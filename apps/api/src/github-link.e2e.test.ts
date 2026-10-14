import { openDatabase } from "@openuptime/db-pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { createAuth, isNativeCallback } from "./auth";

// Runs only when TEST_DATABASE_URL points at a database. GitHub itself is replaced by a stub for its token and
// profile endpoints, so the real Better Auth callback, linking and handoff code runs.
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = {
  DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron",
  GITHUB_CLIENT_ID: "test-id", GITHUB_CLIENT_SECRET: "test-secret",
};

describe("isNativeCallback", () => {
  it("accepts only the exact native callback", () => {
    expect(isNativeCallback("openuptime://auth")).toBe(true);
    expect(isNativeCallback("openuptime://auth?x=1")).toBe(true);
    expect(isNativeCallback("openuptime://authx")).toBe(false);
    expect(isNativeCallback("openuptime://evil")).toBe(false);
    expect(isNativeCallback("https://openuptime://auth")).toBe(false);
    expect(isNativeCallback(null)).toBe(false);
  });
});

describe.skipIf(!url)("GitHub sign-in, linking and native handoff", () => {
  const app = createApp(openDatabase);
  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);
  const jar = (res: Response, prev = "") => {
    const m = new Map(prev.split("; ").filter(Boolean).map((p) => [p.split("=")[0], p] as const));
    for (const c of res.headers.getSetCookie()) m.set(c.split("=")[0], c.split(";")[0]);
    return [...m.values()].join("; ");
  };
  const json = (cookie: string, body: unknown) => ({ method: "POST", headers: { cookie, "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) });

  let ghUser = { id: 1001, login: "octo", email: "octo@example.com", name: "Octo" };
  const realFetch = globalThis.fetch;
  const stub = () =>
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(typeof input === "string" || input instanceof URL ? input : input.url);
      if (u.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "gho_test", token_type: "bearer", scope: "read:user,user:email" });
      if (u.startsWith("https://api.github.com/user/emails")) return Response.json([{ email: ghUser.email, primary: true, verified: true }]);
      if (u.startsWith("https://api.github.com/user")) return Response.json({ ...ghUser, avatar_url: "" });
      return realFetch(input, init);
    });
  afterEach(() => vi.unstubAllGlobals());

  /** Runs the GitHub round trip: start (as `cookie`, if any), then the provider's redirect back. */
  async function github(callbackURL: string, cookie = "", link = false) {
    stub();
    const start = await raw(link ? "/api/auth/link-social" : "/api/auth/sign-in/social", json(cookie, { provider: "github", callbackURL, disableRedirect: true }));
    expect(start.status).toBe(200);
    const { url: authUrl } = (await start.json()) as { url: string };
    const state = new URL(authUrl).searchParams.get("state")!;
    const jar1 = jar(start, cookie);
    const back = await raw(`/api/auth/callback/github?code=abc&state=${state}`, { headers: { cookie: jar1 }, redirect: "manual" });
    return { back, cookie: jar(back, jar1), location: back.headers.get("location") ?? "" };
  }

  it("signs in with GitHub and hands a single-use token to the native callback", async () => {
    await raw("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    ghUser = { id: Date.now(), login: "octo", email: `octo-${Date.now()}@example.com`, name: "Octo" };
    const r = await github("openuptime://auth");
    expect(r.location.startsWith("openuptime://auth")).toBe(true);
    const token = new URL(r.location).searchParams.get("token");
    expect(token).toBeTruthy();

    // the web flow does not get a token appended
    const web = await github(`${ORIGIN}/dashboard`);
    expect(new URL(web.location).searchParams.has("token")).toBe(false);

    const ok = await raw("/api/auth/one-time-token/verify", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ token }) });
    expect(ok.status).toBe(200);
    const cookie = jar(ok);
    expect(cookie).toContain("session_token");
    const me = await raw("/api/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    // single use
    const again = await raw("/api/auth/one-time-token/verify", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ token }) });
    expect(again.status).toBe(400);
  });

  it("refuses other custom-scheme callbacks and generating tokens from the client", async () => {
    // the library skips origin checks under test, so ask its trusted-origin matcher directly
    const db = openDatabase(url!, { max: 1 });
    const ctx = await createAuth(db, env as never).$context;
    await db.close(1);
    const trusted = (u: string) => ctx.isTrustedOrigin(u, { allowRelativePaths: false });
    expect(trusted("openuptime://auth")).toBe(true);
    expect(trusted("openuptime://auth?x=1")).toBe(true);
    for (const u of ["evil://auth", "openuptime://evil", "openuptime://authx", "https://evil.example/auth", "openuptime://auth@evil"]) expect(trusted(u)).toBe(false);
    const email = `ott-${Date.now()}@example.com`;
    const up = await raw("/api/auth/sign-up/email", json("", { email, password: "correct horse battery", name: "Ott" }));
    const gen = await raw("/api/auth/one-time-token/generate", { headers: { cookie: jar(up) } });
    expect(gen.status).toBeGreaterThanOrEqual(400);
  });

  it("links GitHub with a different email, lists it, and refuses to leave no way to sign in", async () => {
    const email = `link-${Date.now()}@example.com`;
    const up = await raw("/api/auth/sign-up/email", json("", { email, password: "correct horse battery", name: "Linker" }));
    expect(up.status).toBe(200);
    let cookie = jar(up);
    ghUser = { id: Date.now() + 1, login: "other", email: `other-${Date.now()}@example.com`, name: "Other" };
    const l = await github(`${ORIGIN}/settings`, cookie, true);
    expect(l.location).toBe(`${ORIGIN}/settings`);
    cookie = l.cookie;

    const list = await raw("/api/auth/list-accounts", { headers: { cookie } });
    expect(list.status).toBe(200);
    const accounts = (await list.json()) as { id: string; providerId: string }[];
    expect(accounts.map((a) => a.providerId).sort()).toEqual(["credential", "github"]);

    // an API key is not a session on the auth endpoints
    const keyed = await raw("/api/auth/list-accounts", { headers: { "x-api-key": "ou_nope", authorization: "Bearer ou_nope" } });
    expect(keyed.status).toBe(401);

    const un = await raw("/api/auth/unlink-account", json(cookie, { accountId: accounts.find((a) => a.providerId === "github")!.id }));
    expect(un.status).toBe(200);
    const left = (await (await raw("/api/auth/list-accounts", { headers: { cookie } })).json()) as { id: string; providerId: string }[];
    expect(left.map((a) => a.providerId)).toEqual(["credential"]);
    // the last one stays
    const last = await raw("/api/auth/unlink-account", json(cookie, { accountId: left[0].id }));
    expect(last.status).toBe(400);
  });

  it("does not let a GitHub-only account unlink its only provider", async () => {
    ghUser = { id: Date.now() + 2, login: "solo", email: `solo-${Date.now()}@example.com`, name: "Solo" };
    const r = await github("openuptime://auth");
    const token = new URL(r.location).searchParams.get("token");
    const ok = await raw("/api/auth/one-time-token/verify", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ token }) });
    const cookie = jar(ok);
    const accounts = (await (await raw("/api/auth/list-accounts", { headers: { cookie } })).json()) as { id: string }[];
    expect(accounts).toHaveLength(1);
    expect((await raw("/api/auth/unlink-account", json(cookie, { accountId: accounts[0].id }))).status).toBe(400);
  });
});
