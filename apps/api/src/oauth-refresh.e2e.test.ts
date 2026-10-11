import { openDatabase } from "@openuptime/db-pg";
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

// Runs only when TEST_DATABASE_URL points at an empty database.
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };
const FORM = { "content-type": "application/x-www-form-urlencoded" };

// MCP clients repeat the scope they authorized with (including offline_access) when they refresh
describe.skipIf(!url)("OAuth refresh with offline_access", () => {
  const app = createApp(openDatabase);
  const req = (p: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${p}`, init), env as never);
  const J = { "content-type": "application/json" };
  const resource = `${ORIGIN}/api/mcp`;

  async function grant() {
    await req("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const su = await req("/api/auth/sign-up/email", { method: "POST", headers: J, body: JSON.stringify({ email: `r-${Date.now()}-${Math.random()}@example.com`, password: "correct horse battery", name: "R" }) });
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const redirect = "http://127.0.0.1:33333/callback";
    const reg = await req("/api/auth/oauth2/register", { method: "POST", headers: J, body: JSON.stringify({ client_name: "T", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
    const client: { client_id: string } = await reg.json();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, scope: "mcp:read mcp:write offline_access", state: "s", code_challenge: challenge, code_challenge_method: "S256", resource });
    const a = await req(`/api/auth/oauth2/authorize?${q}`, { headers: { cookie }, redirect: "manual" });
    const authCookie = `${cookie}; ou_grant=${encodeURIComponent(`${challenge}~*`)}`;
    const query = (loc: string) => new URL(loc, ORIGIN).search.slice(1);
    const next: { redirect_uri?: string; url?: string } = await (await req("/api/auth/oauth2/continue", { method: "POST", headers: { ...J, cookie: authCookie }, body: JSON.stringify({ postLogin: true, oauth_query: query(a.headers.get("location")!) }) })).json();
    let loc = (next.redirect_uri ?? next.url)!;
    if (!loc.startsWith(redirect)) {
      const cb: { redirect_uri?: string; url?: string } = await (await req("/api/auth/oauth2/consent", { method: "POST", headers: { ...J, cookie: authCookie }, body: JSON.stringify({ accept: true, oauth_query: query(loc) }) })).json();
      loc = (cb.redirect_uri ?? cb.url)!;
    }
    const tok = await req("/api/auth/oauth2/token", { method: "POST", headers: FORM, body: new URLSearchParams({ grant_type: "authorization_code", code: new URL(loc).searchParams.get("code")!, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource }) });
    const t: { refresh_token: string; scope: string } = await tok.json();
    return { clientId: client.client_id, refreshToken: t.refresh_token, scope: t.scope };
  }

  const refresh = async (clientId: string, refreshToken: string, scope: string) => {
    const r = await req("/api/auth/oauth2/token", { method: "POST", headers: FORM, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, scope, resource }) });
    return { status: r.status, body: (await r.json()) as { access_token?: string; refresh_token?: string; scope?: string; error?: string } };
  };

  it("keeps offline_access on the grant and rotates the refresh token", async () => {
    const g = await grant();
    expect(g.scope.split(" ")).toContain("offline_access");
    const r = await refresh(g.clientId, g.refreshToken, "mcp:read mcp:write offline_access");
    expect(r.status).toBe(200);
    expect(r.body.access_token).toBeTruthy();
    expect(r.body.refresh_token).toBeTruthy();
  });

  it("refreshes grants that were issued without offline_access", async () => {
    const g = await grant();
    const d = openDatabase(url!, { max: 1 });
    await d.query("update oauth_refresh_token set scopes = array_remove(scopes, 'offline_access')");
    await d.close(1);
    const r = await refresh(g.clientId, g.refreshToken, "mcp:read mcp:write offline_access");
    expect(r.body.error).toBeUndefined();
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe("mcp:read mcp:write");
  });
});
