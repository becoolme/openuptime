import { openDatabase } from "@openuptime/db-pg";
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

// Full agent flow against a real Postgres: discovery → dynamic registration → consent → token → MCP call.
// Runs only when TEST_DATABASE_URL points at an empty database.
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };

describe.skipIf(!url)("oauth + mcp end to end", () => {
  const app = createApp(openDatabase);
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);
  const json = (body: unknown) => ({ "content-type": "application/json", ...(body ? {} : {}) });

  it("lets an agent authorize and manage monitors", async () => {
    expect((await req("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } })).status).toBe(200);

    // an account
    const email = `agent-${Date.now()}@example.com`;
    const su = await req("/api/auth/sign-up/email", { method: "POST", headers: json(1), body: JSON.stringify({ email, password: "correct horse battery", name: "Ada" }) });
    expect(su.status).toBe(200);
    let cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    // not authorized yet: a challenge pointing at the metadata
    const anon = await req("/api/mcp", { method: "POST", headers: json(1), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource");

    // discovery
    const prm: any = await (await req("/.well-known/oauth-protected-resource/api/mcp")).json();
    expect(prm.resource).toBe(`${ORIGIN}/api/mcp`);
    const asm: any = await (await req("/.well-known/oauth-authorization-server/api/auth")).json();
    expect(asm.registration_endpoint).toContain("/oauth2/register");
    expect(asm.code_challenge_methods_supported).toContain("S256");
    expect(prm.authorization_servers[0]).toBe(asm.issuer);

    // dynamic client registration, as an MCP client does
    const redirect = "http://127.0.0.1:33333/callback";
    const reg = await req("/api/auth/oauth2/register", {
      method: "POST",
      headers: json(1),
      body: JSON.stringify({ client_name: "Test Agent", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    });
    expect(reg.status, await reg.clone().text()).toBeLessThan(300);
    const client: any = await reg.json();

    // authorization request with PKCE and the resource indicator
    const authorize = async (scope: string, grant?: string) => {
      // what the picker page leaves in its cookie: `<workspace>|*` or `<workspace>|<project>,<project>`
      const verifierFor = randomBytes(32).toString("base64url");
      const challengeFor = createHash("sha256").update(verifierFor).digest("base64url");
      // the picker is always shown now, so a request without an explicit answer picks everything
      const picked = `; ou_grant=${encodeURIComponent(`${challengeFor}~${grant ?? "*"}`)}`;
      const verifier = verifierFor;
      const q = new URLSearchParams({
        response_type: "code", client_id: client.client_id, redirect_uri: redirect, scope, state: "xyz",
        code_challenge: challengeFor, code_challenge_method: "S256", resource: prm.resource,
      });
      const auth = await req(`/api/auth/oauth2/authorize?${q}`, { headers: { cookie }, redirect: "manual" });
      let loc = auth.headers.get("location") ?? ((await auth.clone().json().catch(() => ({}))) as any).url;
      if (loc.includes("/oauth/workspace")) {
        // several workspaces: the agent's authorization first asks which one it may act in
        const c = await req("/api/auth/oauth2/continue", { method: "POST", headers: { ...json(1), cookie: `${cookie}${picked}` }, body: JSON.stringify({ postLogin: true, oauth_query: new URL(loc, ORIGIN).search.slice(1) }) });
        const next: any = await c.json();
        expect(c.status, JSON.stringify(next)).toBe(200);
        loc = next.redirect_uri ?? next.url;
      }
      let back: URL;
      if (loc.startsWith(redirect)) {
        // a consent already on file for this client and workspace is reused without asking again
        back = new URL(loc);
      } else {
        expect(loc, `authorize -> ${auth.status}`).toContain("/oauth/consent");
        const consent = await req("/api/auth/oauth2/consent", { method: "POST", headers: { ...json(1), cookie: `${cookie}${picked}` }, body: JSON.stringify({ accept: true, oauth_query: new URL(loc, ORIGIN).search.slice(1) }) });
        expect(consent.status, await consent.clone().text()).toBe(200);
        const cb: any = await consent.json();
        back = new URL(cb.redirect_uri ?? cb.url);
      }
      expect(back.origin + back.pathname).toBe(redirect);
      expect(back.searchParams.get("state")).toBe("xyz");
      const tok = await req("/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: prm.resource }),
      });
      expect(tok.status, await tok.clone().text()).toBe(200);
      return (await tok.json()) as any;
    };
    const t = await authorize("mcp:read mcp:write");
    expect(t.access_token.split(".")).toHaveLength(3);

    // the agent acts with its token
    const bearer = { authorization: `Bearer ${t.access_token}`, ...json(1) };
    const rpc = async (method: string, params?: unknown, id = 1) => (await (await req("/api/mcp", { method: "POST", headers: bearer, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })).json()) as any;
    expect((await rpc("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.name).toBe("openuptime");
    expect((await rpc("tools/list")).result.tools.length).toBeGreaterThan(5);
    const created = await rpc("tools/call", { name: "create_monitor", arguments: { name: "Agent made", type: "http", target: "https://example.com" } });
    expect(created.result.isError, created.result.content[0].text).toBe(false);
    const listed = await rpc("tools/call", { name: "list_monitors", arguments: {} });
    expect(listed.result.content[0].text).toContain("Agent made");

    // and the REST API accepts the same token
    expect((await req("/api/monitors", { headers: { authorization: `Bearer ${t.access_token}` } })).status).toBe(200);
    // an agent token never gets the account-wide export, and a session does
    expect((await req("/api/me/export", { headers: { authorization: `Bearer ${t.access_token}` } })).status).toBe(403);
    expect((await req("/api/me/export", { headers: { cookie } })).status).toBe(200);
    // a read-only grant can look but not touch
    const ro = await authorize("mcp:read");
    const roHeaders = { authorization: `Bearer ${ro.access_token}`, ...json(1) };
    expect((await req("/api/monitors", { headers: roHeaders })).status).toBe(200);
    expect((await req("/api/monitors", { method: "POST", headers: roHeaders, body: JSON.stringify({ name: "x", target: "https://example.com" }) })).status).toBe(403);

    const first = ((await (await req("/api/auth/organization/list", { headers: { cookie } })).json()) as { id: string }[])[0].id;
    // with a second workspace the agent is bound to the one the user picked
    const org = await req("/api/auth/organization/create", { method: "POST", headers: { ...json(1), cookie }, body: JSON.stringify({ name: "Second", slug: `second-${Date.now()}` }) });
    expect(org.status).toBe(200);
    const second: any = await org.json();
    const act = await req("/api/auth/organization/set-active", { method: "POST", headers: { ...json(1), cookie }, body: JSON.stringify({ organizationId: second.id }) });
    // the session cookie cache holds the active workspace, so take the refreshed cookies like a browser would
    const jar = new Map(cookie.split("; ").map((c) => c.split(/=(.*)/s).slice(0, 2) as [string, string]));
    for (const c of act.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const everything = `${second.id}|*`;
    const t2 = await authorize("mcp:read mcp:write", everything);
    const claims = JSON.parse(Buffer.from(t2.access_token.split(".")[1], "base64url").toString());
    expect(claims.org).toBe(second.id);
    const fresh = await req("/api/monitors", { headers: { authorization: `Bearer ${t2.access_token}` } });
    expect(await fresh.json()).toEqual([]);

    // an agent can be limited to some projects of the workspace
    const mk = async (name: string) => (await (await req("/api/projects", { method: "POST", headers: { ...json(1), cookie }, body: JSON.stringify({ name }) })).json()) as { id: string };
    const [pa, pb] = [await mk("Alpha"), await mk("Beta")];
    const t3 = await authorize("mcp:read mcp:write", `${second.id}|${pa.id}`);
    const c3 = JSON.parse(Buffer.from(t3.access_token.split(".")[1], "base64url").toString());
    expect(c3.workspaces).toEqual([{ id: second.id, projects: [pa.id] }]);
    const limited = { authorization: `Bearer ${t3.access_token}`, ...json(1) };
    expect(((await (await req("/api/projects", { headers: limited })).json()) as { id: string }[]).map((p) => p.id)).toEqual([pa.id]);
    expect((await req("/api/monitors", { headers: { ...limited, "x-project-id": pb.id } })).status).toBe(403);
    expect((await req("/api/projects", { method: "POST", headers: limited, body: JSON.stringify({ name: "Nope" }) })).status).toBe(403);
    // another workspace is not part of that grant
    expect((await req("/api/monitors", { headers: { ...limited, "x-workspace-id": first } })).status).toBe(403);
    // `<workspace>|*` is the whole workspace: no project limit in the token
    const t4 = await authorize("mcp:read", everything);
    expect(JSON.parse(Buffer.from(t4.access_token.split(".")[1], "base64url").toString()).workspaces).toEqual([{ id: second.id }]);

    // several workspaces at once, one of them limited to a project
    const t5 = await authorize("mcp:read mcp:write", `${first}|*;${second.id}|${pa.id}`);
    const multi = { authorization: `Bearer ${t5.access_token}`, ...json(1) };
    const ws: any = await (await req("/api/workspaces", { headers: multi })).json();
    expect(ws.workspaces.map((w: any) => w.id).sort()).toEqual([first, second.id].sort());
    expect(ws.workspaces.find((w: any) => w.id === second.id).projects.map((p: any) => p.id)).toEqual([pa.id]);
    const inFirst: any[] = await (await req("/api/monitors", { headers: { ...multi, "x-workspace-id": first } })).json();
    expect(inFirst.map((m) => m.name)).toContain("Agent made");
    expect((await req("/api/monitors", { headers: { ...multi, "x-workspace-id": second.id, "x-project-id": pb.id } })).status).toBe(403);
    // the MCP tools take the workspace per call
    const rpcMulti = async (name: string, args: unknown) =>
      (await (await req("/api/mcp", { method: "POST", headers: multi, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()) as any;
    expect((await rpcMulti("list_monitors", { workspace: first })).result.content[0].text).toContain("Agent made");
    expect((await rpcMulti("list_workspaces", {})).result.isError).toBe(false);

    // projects can be created where the grant covers all projects of the workspace, and only there
    const made = await rpcMulti("create_project", { workspace: first, name: "Agent project" });
    expect(made.result.isError).toBe(false);
    const newId = JSON.parse(made.result.content[0].text).id as string;
    expect((await req("/api/monitors", { headers: { ...multi, "x-workspace-id": first, "x-project-id": newId } })).status).toBe(200);
    expect((await rpcMulti("create_project", { workspace: second.id, name: "Nope" })).result.isError).toBe(true);

    // every workspace, including ones joined later
    const t6 = await authorize("mcp:read", "*");
    expect(JSON.parse(Buffer.from(t6.access_token.split(".")[1], "base64url").toString()).all_workspaces).toBe(true);
    const everyWs: any = await (await req("/api/workspaces", { headers: { authorization: `Bearer ${t6.access_token}` } })).json();
    expect(everyWs.workspaces).toHaveLength(2);
    expect((await req("/api/monitors", { headers: { authorization: `Bearer ${t6.access_token}`, "x-workspace-id": first } })).status).toBe(200);

    // only an all-workspaces grant may create workspaces
    const bearerAll = { authorization: `Bearer ${t6.access_token}`, ...json(1) };
    expect((await req("/api/workspaces", { method: "POST", headers: multi, body: JSON.stringify({ name: "Nope" }) })).status).toBe(403);
    const t7 = await authorize("mcp:read mcp:write", "*");
    const rpcAll = async (name: string, args: unknown) =>
      (await (await req("/api/mcp", { method: "POST", headers: { authorization: `Bearer ${t7.access_token}`, ...json(1) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()) as any;
    const ws3 = await rpcAll("create_workspace", { name: "Agent space" });
    expect(ws3.result.isError).toBe(false);
    const spawned = JSON.parse(ws3.result.content[0].text) as { id: string; projects: unknown[] };
    expect(spawned.projects).toHaveLength(1);
    expect((await req("/api/monitors", { headers: { ...bearerAll, authorization: `Bearer ${t7.access_token}`, "x-workspace-id": spawned.id } })).status).toBe(200);

    // revoking the grant stops the agent at once, even though its JWT has not expired
    const consents: any[] = await (await req("/api/auth/oauth2/get-consents", { headers: { cookie } })).json();
    expect(consents.length).toBeGreaterThan(0);
    for (const c of consents) {
      const del = await req("/api/auth/oauth2/delete-consent", { method: "POST", headers: { ...json(1), cookie }, body: JSON.stringify({ id: c.id }) });
      expect(del.status).toBeLessThan(300);
    }
    expect((await req("/api/monitors", { headers: { authorization: `Bearer ${t2.access_token}` } })).status).toBe(401);

    // a garbage token is a challenge, not a 500
    const bad = await req("/api/mcp", { method: "POST", headers: { authorization: "Bearer a.b.c", ...json(1) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(bad.status).toBe(401);
  }, 60_000);
});
