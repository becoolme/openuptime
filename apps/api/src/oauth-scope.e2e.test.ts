import { openDatabase } from "@openuptime/db-pg";
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { community } from "./edition";
import type { RequestPrincipal } from "./env";

// An authorized agent (MCP over OAuth) sees only the workspaces and projects the user ticked in the picker, and
// nothing of anybody else's. Runs only when TEST_DATABASE_URL points at a database (shared with the other e2e tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };
const JSON_HEADERS = { "content-type": "application/json" };

describe.skipIf(!url)("an agent sees only what the user authorized", () => {
  const observed: { path: string; principal?: RequestPrincipal }[] = [];
  const app = createApp(openDatabase, { edition: { ...community, requestMiddleware: async (c, next) => {
    await next(); observed.push({ path: c.req.path, principal: c.get("requestPrincipal") });
  } } });
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);

  async function signUp(label: string) {
    const r = await req("/api/auth/sign-up/email", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ email: `${label}-${Date.now()}-${randomBytes(3).toString("hex")}@example.com`, password: "correct horse battery", name: label }),
    });
    expect(r.status).toBe(200);
    return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  }
  const as = (cookie: string) => async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await req(`/api${path}`, { method, headers: { ...JSON_HEADERS, cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };

  it("limits an agent to the workspace and project picked, in the REST API and over MCP", async () => {
    expect((await req("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } })).status).toBe(200);

    // Ada owns two workspaces; her first has two projects (Alpha is the picked one). Bob is somebody else.
    const adaCookie = await signUp("ada");
    const ada = as(adaCookie);
    const bobCookie = await signUp("bob");
    const bob = as(bobCookie);

    const spaces = (await ada("GET", "/workspaces")).body.workspaces as { id: string; projects: { id: string; name: string }[] }[];
    const home = spaces[0];
    const alpha = home.projects[0].id;
    const beta = (await ada("POST", "/projects", { name: "Beta" })).body.id as string;
    const other = (await ada("POST", "/workspaces", { name: "Ada other" })).body as { id: string; projects: { id: string }[] };

    const mon = async (who: ReturnType<typeof as>, name: string, projectId: string) => {
      const r = await who("POST", "/monitors", { name, type: "http", target: "https://example.com" }, { "x-project-id": projectId });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as string;
    };
    const alphaMon = await mon(ada, "Alpha monitor", alpha);
    const betaMon = await mon(ada, "Beta monitor", beta);
    const bobHome = ((await bob("GET", "/workspaces")).body.workspaces as { id: string; projects: { id: string }[] }[])[0];
    const bobMon = await mon(bob, "Bob monitor", bobHome.projects[0].id);
    // a channel only Beta has, and an incident on Beta's monitor
    const betaChannel = await ada("POST", "/channels", { type: "slack", name: "Beta only", config: { url: "https://hooks.slack.com/services/T000/B000/abcdef" }, scope: "project" }, { "x-project-id": beta });
    expect(betaChannel.status, JSON.stringify(betaChannel.body)).toBe(201);
    const betaIncident = await ada("POST", "/incidents", { title: "Beta is down", monitorId: betaMon }, { "x-project-id": beta });
    expect(betaIncident.status).toBe(201);

    // the agent registers and is authorized for Ada's home workspace, project Alpha only
    const redirect = "http://127.0.0.1:33333/callback";
    const reg = await req("/api/auth/oauth2/register", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ client_name: "Scoped Agent", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    });
    const client: any = await reg.json();
    const prm: any = await (await req("/.well-known/oauth-protected-resource/api/mcp")).json();
    const authorize = async (pick: string, rejected = false, scopes = "mcp:read mcp:write") => {
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const picked = `; ou_grant=${encodeURIComponent(`${challenge}~${pick}`)}`;
      const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, scope: scopes, state: "s", code_challenge: challenge, code_challenge_method: "S256", resource: prm.resource });
      const a = await req(`/api/auth/oauth2/authorize?${q}`, { headers: { cookie: adaCookie }, redirect: "manual" });
      let loc = a.headers.get("location") ?? ((await a.clone().json().catch(() => ({}))) as any).url;
      if (!loc) throw new Error(`authorize -> ${a.status} ${await a.clone().text()}`);
      if (loc.includes("/oauth/workspace")) {
        const c = await req("/api/auth/oauth2/continue", { method: "POST", headers: { ...JSON_HEADERS, cookie: `${adaCookie}${picked}` }, body: JSON.stringify({ postLogin: true, oauth_query: new URL(loc, ORIGIN).search.slice(1) }) });
        const next: any = await c.json();
        if (rejected) {
          expect(c.status, JSON.stringify(next)).toBe(400);
          return "";
        }
        expect(c.status, JSON.stringify(next)).toBe(200);
        loc = next.redirect_uri ?? next.url;
      }
      if (!loc.startsWith(redirect)) {
        const c = await req("/api/auth/oauth2/consent", { method: "POST", headers: { ...JSON_HEADERS, cookie: `${adaCookie}${picked}` }, body: JSON.stringify({ accept: true, oauth_query: new URL(loc, ORIGIN).search.slice(1) }) });
        const next: any = await c.json();
        expect(c.status, JSON.stringify(next)).toBe(200);
        loc = next.redirect_uri ?? next.url;
      }
      const tok = await req("/api/auth/oauth2/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: new URL(loc).searchParams.get("code")!, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: prm.resource }),
      });
      expect(tok.status).toBe(200);
      return ((await tok.json()) as any).access_token as string;
    };
    const readToken = await authorize(`${home.id}|${alpha}`, false, "mcp:read");
    const importData = { source: "oauth-test", monitors: [{ sourceId: "1", name: "Preview only", target: "https://1.1.1.1/" }] };
    const preview = await req("/api/monitors/import/preview", { method: "POST", headers: { ...JSON_HEADERS, authorization: `Bearer ${readToken}` }, body: JSON.stringify(importData) });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ created: 0, ready: 1 });
    expect((await req("/api/monitors/import", { method: "POST", headers: { ...JSON_HEADERS, authorization: `Bearer ${readToken}` }, body: JSON.stringify(importData) })).status).toBe(403);
    expect((await req("/api/monitors/import/preview", { method: "POST", headers: { ...JSON_HEADERS, authorization: `Bearer ${readToken}`, "x-project-id": beta }, body: JSON.stringify(importData) })).status).toBe(403);
    const token = await authorize(`${home.id}|${alpha}`);
    const agent = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const r = await req(`/api${path}`, { method, headers: { ...JSON_HEADERS, authorization: `Bearer ${token}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };

    // what it is shown: the one workspace, the one project
    const seen = (await agent("GET", "/workspaces")).body;
    expect(seen.workspaces).toEqual([{ id: home.id, name: expect.any(String), projects: [{ id: alpha, name: expect.any(String) }] }]);
    expect((await agent("GET", "/projects")).body.map((p: any) => p.id)).toEqual([alpha]);
    expect((await agent("GET", "/monitors")).body.map((m: any) => m.name)).toEqual(["Alpha monitor"]);
    expect(observed.at(-1)?.principal).toMatchObject({ kind: "oauth", clientId: client.client_id, orgId: home.id, projectId: alpha, projectScope: [alpha] });
    expect(observed.at(-1)?.principal?.userId).toBeTruthy();
    expect(JSON.stringify(observed.at(-1)?.principal)).not.toContain(token);

    // what it is refused: the sibling project, the other workspaces, and somebody else's
    expect((await agent("GET", "/monitors", undefined, { "x-project-id": beta })).status).toBe(403);
    expect(observed.at(-1)?.principal).toBeUndefined();
    expect((await agent("GET", `/monitors/${betaMon}`)).status).toBe(404);
    expect((await agent("PATCH", `/monitors/${betaMon}`, { name: "hijacked" })).status).toBe(404);
    // delete is idempotent (204) but scoped: the sibling project's monitor survives it
    await agent("DELETE", `/monitors/${betaMon}`);
    await agent("DELETE", `/monitors/${bobMon}`);
    expect((await agent("GET", `/monitors/${bobMon}`)).status).toBe(404);
    expect((await agent("GET", `/incidents/${betaIncident.body.id}`)).status).toBe(404);
    expect((await agent("GET", "/incidents")).body.map((i: any) => i.title)).not.toContain("Beta is down");
    expect((await agent("GET", "/channels")).body.map((c: any) => c.name)).not.toContain("Beta only");
    for (const ws of [other.id, bobHome.id]) {
      expect([ws, (await agent("GET", "/monitors", undefined, { "x-workspace-id": ws })).status]).toEqual([ws, 403]);
    }
    // a project id from another workspace never resolves to that project: it falls back to the granted one's data
    const foreign = await agent("GET", "/monitors", undefined, { "x-workspace-id": home.id, "x-project-id": bobHome.projects[0].id });
    expect(foreign.status === 403 || (foreign.status === 200 && foreign.body.map((m: any) => m.name).join() === "Alpha monitor")).toBe(true);
    // it cannot widen itself: no new projects or workspaces, no account export, no better-auth session endpoints
    expect((await agent("POST", "/projects", { name: "Mine" })).status).toBe(403);
    expect((await agent("POST", "/workspaces", { name: "Mine" })).status).toBe(403);
    expect((await agent("GET", "/me/export")).status).toBe(403);
    const orgList = await req("/api/auth/organization/list", { headers: { authorization: `Bearer ${token}` } });
    expect(orgList.status === 401 || (await orgList.json()) === null || ((await orgList.clone().json().catch(() => [])) as unknown[]).length === 0).toBe(true);
    // nothing of Ada's other project or of Bob's was touched by any of that
    expect((await ada("GET", `/monitors/${betaMon}`, undefined, { "x-project-id": beta })).body.name).toBe("Beta monitor");
    expect((await bob("GET", `/monitors/${bobMon}`, undefined, { "x-project-id": bobHome.projects[0].id })).body.name).toBe("Bob monitor");

    // the same over MCP: tools list only the granted workspace and project, and refuse the rest
    const call = async (name: string, args: unknown = {}) => {
      const r = await req("/api/mcp", { method: "POST", headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      return ((await r.json()) as any).result as { isError: boolean; content: { text: string }[] };
    };
    const lw = await call("list_workspaces");
    expect(lw.isError).toBe(false);
    const lwText = lw.content[0].text;
    expect(lwText).toContain(home.id);
    expect(lwText).toContain(alpha);
    for (const hidden of [beta, other.id, bobHome.id]) expect(lwText).not.toContain(hidden);
    observed.length = 0;
    const lm = await call("list_monitors");
    expect(observed.find((e) => e.path === "/api/monitors")?.principal).toMatchObject({ kind: "oauth", clientId: client.client_id, orgId: home.id, projectScope: [alpha] });
    expect(observed.find((e) => e.path === "/api/mcp")?.principal).toBeUndefined();
    expect(lm.content[0].text).toContain("Alpha monitor");
    expect(lm.content[0].text).not.toContain("Beta monitor");
    expect((await call("list_monitors", { project: beta })).isError).toBe(true);
    expect((await call("list_monitors", { workspace: other.id })).isError).toBe(true);
    expect((await call("get_monitor", { id: betaMon })).isError).toBe(true);
    expect((await call("create_project", { name: "Mine" })).isError).toBe(true);
    // deleting what it cannot see is a no-op, never a deletion
    await call("delete_monitor", { id: bobMon });
    await call("delete_monitor", { id: betaMon });
    expect((await ada("GET", `/monitors/${betaMon}`, undefined, { "x-project-id": beta })).status).toBe(200);
    expect((await bob("GET", `/monitors/${bobMon}`, undefined, { "x-project-id": bobHome.projects[0].id })).status).toBe(200);

    // an agent picked for both of Ada's workspaces but still one project each sees exactly those
    const token2 = await authorize(`${home.id}|${alpha};${other.id}`);
    const two = await req("/api/workspaces", { headers: { authorization: `Bearer ${token2}` } });
    const twoBody: any = await two.json();
    expect(twoBody.workspaces.map((w: any) => w.id).sort()).toEqual([home.id, other.id].sort());
    expect(twoBody.workspaces.find((w: any) => w.id === home.id).projects.map((p: any) => p.id)).toEqual([alpha]);
    expect(JSON.stringify(twoBody)).not.toContain(beta);
    expect(JSON.stringify(twoBody)).not.toContain(bobHome.id);
    expect((await req("/api/monitors", { headers: { authorization: `Bearer ${token2}`, "x-workspace-id": other.id } })).status).toBe(200);
    expect(observed.at(-1)?.principal).toMatchObject({ kind: "oauth", clientId: client.client_id, orgId: other.id, projectScope: null });

    // a grant naming somebody else's workspace is dropped at consent time, not honoured
    const sneaky = await authorize(`${home.id}|${alpha};${bobHome.id}`);
    const sneakyClaims = JSON.parse(Buffer.from(sneaky.split(".")[1], "base64url").toString());
    expect(sneakyClaims.workspaces.map((w: any) => w.id)).toEqual([home.id]);
    expect((await req("/api/monitors", { headers: { authorization: `Bearer ${sneaky}`, "x-workspace-id": bobHome.id } })).status).toBe(403);
    // and a project that is not in the picked workspace leaves nothing to grant: the picker refuses
    expect(await authorize(`${home.id}|${bobHome.projects[0].id}`, true)).toBe("");
  }, 90_000);
});
