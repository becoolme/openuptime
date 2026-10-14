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
  async function github(callbackURL: string, cookie = "", link = false, native = false) {
    stub();
    const start = native
      ? await raw("/api/auth/native/github", { redirect: "manual" })
      : await raw(link ? "/api/auth/link-social" : "/api/auth/sign-in/social", json(cookie, { provider: "github", callbackURL, disableRedirect: true }));
    expect(start.status).toBe(native ? 302 : 200);
    const authUrl = native ? start.headers.get("location")! : ((await start.json()) as { url: string }).url;
    expect(authUrl.startsWith("https://github.com/login/oauth/authorize")).toBe(true);
    const state = new URL(authUrl).searchParams.get("state")!;
    const jar1 = jar(start, cookie);
    const back = await raw(`/api/auth/callback/github?code=abc&state=${state}`, { headers: { cookie: jar1 }, redirect: "manual" });
    return { back, cookie: jar(back, jar1), location: back.headers.get("location") ?? "" };
  }

  it("signs in with GitHub and hands a single-use token to the native callback", async () => {
    await raw("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    ghUser = { id: Date.now(), login: "octo", email: `octo-${Date.now()}@example.com`, name: "Octo" };
    const r = await github("openuptime://auth", "", false, true);
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
    const r = await github("openuptime://auth", "", false, true);
    const token = new URL(r.location).searchParams.get("token");
    const ok = await raw("/api/auth/one-time-token/verify", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ token }) });
    const cookie = jar(ok);
    const accounts = (await (await raw("/api/auth/list-accounts", { headers: { cookie } })).json()) as { id: string }[];
    expect(accounts).toHaveLength(1);
    expect((await raw("/api/auth/unlink-account", json(cookie, { accountId: accounts[0].id }))).status).toBe(400);
  });

  describe("pre-registration takeover", () => {
    const signIn = (email: string, password: string) => raw("/api/auth/sign-in/email", json("", { email, password }));
    const sql = async <T,>(q: string, p: unknown[] = []) => {
      const db = openDatabase(url!, { max: 1 });
      try { return await db.query<T>(q, p); } finally { await db.close(1); }
    };

    it("clears credentials, sessions and keys set on an unverified account when its owner signs in with GitHub", async () => {
      const email = `victim-${Date.now()}@example.com`;
      const up = await raw("/api/auth/sign-up/email", json("", { email, password: "attacker knows this", name: "Mallory" }));
      expect(up.status).toBe(200);
      const attacker = jar(up);
      const userId = ((await up.json()) as { user: { id: string } }).user.id;
      const key = await raw("/api/auth/api-key/create", json(attacker, { name: "planted" }));
      expect(key.status).toBe(200);
      expect((await raw("/api/me", { headers: { cookie: attacker } })).status).toBe(200);

      ghUser = { id: Date.now() + 10, login: "victim", email, name: "Victim" };
      const r = await github(`${ORIGIN}/dashboard`);
      expect(r.location).toBe(`${ORIGIN}/dashboard`);

      // the same user, now verified, signed in through GitHub
      const me = await raw("/api/auth/get-session", { headers: { cookie: r.cookie } });
      expect(((await me.json()) as { user: { id: string } }).user.id).toBe(userId);
      expect(await sql(`select 1 from "user" where id = $1 and email_verified`, [userId])).toHaveLength(1);
      // everything the squatter set up is gone
      expect((await signIn(email, "attacker knows this")).status).toBeGreaterThanOrEqual(400);
      expect((await raw("/api/me", { headers: { cookie: attacker } })).status).toBe(401);
      expect(await sql("select 1 from apikey where reference_id = $1", [userId])).toHaveLength(0);
      const left = await sql<{ provider_id: string }>("select provider_id from account where user_id = $1", [userId]);
      expect(left.map((a) => a.provider_id)).toEqual(["github"]);
    });

    it("keeps the password of a verified local user who signs in with GitHub", async () => {
      const email = `verified-${Date.now()}@example.com`;
      const up = await raw("/api/auth/sign-up/email", json("", { email, password: "my own password", name: "Vera" }));
      const userId = ((await up.json()) as { user: { id: string } }).user.id;
      await sql(`update "user" set email_verified = true where id = $1`, [userId]);
      ghUser = { id: Date.now() + 11, login: "vera", email, name: "Vera" };
      const r = await github(`${ORIGIN}/dashboard`);
      expect(r.location).toBe(`${ORIGIN}/dashboard`);
      expect((await signIn(email, "my own password")).status).toBe(200);
      const accounts = await sql<{ provider_id: string }>("select provider_id from account where user_id = $1", [userId]);
      expect(accounts.map((a) => a.provider_id).sort()).toEqual(["credential", "github"]);
    });

    it("does not wipe an unverified user who links GitHub from their own session", async () => {
      const email = `own-${Date.now()}@example.com`;
      const up = await raw("/api/auth/sign-up/email", json("", { email, password: "my own password", name: "Own" }));
      const cookie = jar(up);
      ghUser = { id: Date.now() + 12, login: "own", email, name: "Own" };
      const r = await github(`${ORIGIN}/settings`, cookie, true);
      expect(r.location).toBe(`${ORIGIN}/settings`);
      expect((await signIn(email, "my own password")).status).toBe(200);
      expect((await raw("/api/me", { headers: { cookie } })).status).toBe(200);
    });

    it("refuses a password sign-up for an email a GitHub sign-in already created", async () => {
      const email = `ghfirst-${Date.now()}@example.com`;
      ghUser = { id: Date.now() + 13, login: "ghfirst", email, name: "Gh" };
      await github(`${ORIGIN}/dashboard`);
      const up = await raw("/api/auth/sign-up/email", json("", { email, password: "squatter password", name: "Mallory" }));
      const body = (await up.json()) as { token?: string | null };
      expect(up.status).toBeGreaterThanOrEqual(400);
      expect(body.token ?? null).toBeNull();
      expect((await signIn(email, "squatter password")).status).toBeGreaterThanOrEqual(400);
      const accounts = await sql<{ provider_id: string }>(`select a.provider_id from account a join "user" u on u.id = a.user_id where u.email = $1`, [email]);
      expect(accounts.map((a) => a.provider_id)).toEqual(["github"]);
    });
  });
});
