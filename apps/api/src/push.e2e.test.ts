import { openDatabase } from "@openuptime/db-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { setApnsTransport, type ApnsRequest } from "./apns";

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const base = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };

describe.skipIf(!url)("push devices and the push channel", () => {
  const app = createApp(openDatabase);
  let apnsKey = "";
  let configured: Record<string, unknown> = base;
  const raw = (env: object, path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    apnsKey = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
    configured = { ...base, APNS_KEY: apnsKey, APNS_KEY_ID: "KEYID12345", APNS_TEAM_ID: "TEAMID1234", APNS_BUNDLE_ID: "app.openuptime.ios" };
    await raw(base, "/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
  });
  afterAll(() => setApnsTransport(null));

  const signUp = async (label: string) => {
    const r = await raw(base, "/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: "correct horse battery", name: label }),
    });
    expect(r.status).toBe(200);
    const id = ((await r.json()) as { user: { id: string } }).user.id;
    return { id, cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
  };
  const call = async (env: object, who: { cookie: string }, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await raw(env, `/api${path}`, { method, headers: { cookie: who.cookie, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const sql = async <T,>(q: string, p: unknown[] = []) => {
    const db = openDatabase(url!, { max: 1 });
    try { return await db.query<T>(q, p); } finally { await db.close(1); }
  };
  const tok = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

  it("reports the capability without exposing more than a boolean", async () => {
    const off = (await (await raw(base, "/api/config")).json()) as any;
    expect(off.push).toEqual({ apns: false });
    const on = (await (await raw(configured, "/api/config")).json()) as any;
    expect(on.push).toEqual({ apns: true });
    // sign-in providers are unchanged
    expect(Object.keys((await (await raw(configured, "/api/auth-providers")).json()) as object).sort()).toEqual(["github", "legal", "signup", "turnstileSiteKey"]);
  });

  it("registers, lists, updates and deletes a device", async () => {
    const ada = await signUp("ada");
    const token = tok();
    expect((await call(base, { cookie: "" }, "PUT", "/push/devices", { token, platform: "ios", environment: "sandbox" })).status).toBe(401);

    const put = await call(base, ada, "PUT", "/push/devices", { token: token.toUpperCase(), platform: "ios", environment: "sandbox", locale: "zh-CN", name: "Ada's iPhone" });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ token, platform: "ios", environment: "sandbox", locale: "zh-CN", name: "Ada's iPhone" });
    expect(put.body.id).toBeTruthy();

    // registering again updates the same row
    const again = await call(base, ada, "PUT", "/push/devices", { token, platform: "ios", environment: "production", locale: "en" });
    expect(again.body.id).toBe(put.body.id);
    expect(again.body).toMatchObject({ environment: "production", locale: "en", name: null });
    const list = await call(base, ada, "GET", "/push/devices");
    expect(list.body).toHaveLength(1);

    for (const bad of [{ token: "zz".repeat(20), platform: "ios", environment: "production" }, { token: "ab", platform: "ios", environment: "production" }, { token, platform: "android", environment: "production" }, { token, platform: "ios", environment: "beta" }, { token, platform: "ios", environment: "production", name: "x".repeat(81) }]) {
      expect((await call(base, ada, "PUT", "/push/devices", bad)).status).toBe(400);
    }

    expect((await call(base, ada, "DELETE", `/push/devices/${token}`)).status).toBe(204);
    expect((await call(base, ada, "GET", "/push/devices")).body).toEqual([]);
  });

  it("moves a token to the user who registered it last and keeps others' devices untouchable", async () => {
    const [a, b] = [await signUp("move-a"), await signUp("move-b")];
    const token = tok();
    await call(base, a, "PUT", "/push/devices", { token, platform: "ios", environment: "production" });
    await call(base, b, "PUT", "/push/devices", { token, platform: "ios", environment: "production" });
    expect((await call(base, a, "GET", "/push/devices")).body).toEqual([]);
    expect((await call(base, b, "GET", "/push/devices")).body).toHaveLength(1);
    // a cannot delete b's device
    expect((await call(base, a, "DELETE", `/push/devices/${token}`)).status).toBe(204);
    expect((await call(base, b, "GET", "/push/devices")).body).toHaveLength(1);
  });

  it("works with an API key", async () => {
    const u = await signUp("keyed");
    const key = (await (await raw(base, "/api/auth/api-key/create", { method: "POST", headers: { cookie: u.cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "phone" }) })).json()) as { key: string };
    const viaKey = { cookie: "" };
    const h = { "x-api-key": key.key };
    const token = tok();
    const put = await call(base, viaKey, "PUT", "/push/devices", { token, platform: "ios", environment: "production" }, h);
    expect(put.status).toBe(200);
    expect((await call(base, u, "GET", "/push/devices")).body).toHaveLength(1);
    expect((await call(base, viaKey, "GET", "/push/devices", undefined, h)).body[0].token).toBe(token);
    expect((await call(base, viaKey, "DELETE", `/push/devices/${token}`, undefined, h)).status).toBe(204);
  });

  it("creates the Mobile app channel for managed workspaces only, once, and only when APNs is configured", async () => {
    const owner = await signUp("owner");
    const orgs = async () => (await sql<{ organization_id: string }>("select organization_id from member where user_id = $1", [owner.id])).map((r) => r.organization_id);
    const [home] = await orgs();
    // a second workspace where this user is only a member
    const other = await sql<{ id: string }>(`insert into organization (id, name, slug, created_at) values ($1, 'Other', $2, now()) returning id`, [crypto.randomUUID(), `other-${Date.now()}`]);
    await sql(`insert into member (id, organization_id, user_id, role, created_at) values ($1, $2, $3, 'member', now())`, [crypto.randomUUID(), other[0].id, owner.id]);

    await call(base, owner, "PUT", "/push/devices", { token: tok(), platform: "ios", environment: "production" });
    expect(await sql("select 1 from alert_channel where type = 'push' and organization_id = $1", [home])).toHaveLength(0);

    await call(configured, owner, "PUT", "/push/devices", { token: tok(), platform: "ios", environment: "production" });
    await call(configured, owner, "PUT", "/push/devices", { token: tok(), platform: "ios", environment: "production" });
    const made = await sql<{ name: string; enabled: boolean; auto_enable: boolean; project_id: string | null }>("select name, enabled, auto_enable, project_id from alert_channel where type = 'push' and organization_id = $1", [home]);
    expect(made).toEqual([{ name: "Mobile app", enabled: true, auto_enable: true, project_id: null }]);
    expect(await sql("select 1 from alert_channel where type = 'push' and organization_id = $1", [other[0].id])).toHaveLength(0);
  });

  it("refuses to create a push channel when APNs is not configured", async () => {
    const u = await signUp("chan");
    const refused = await call(base, u, "POST", "/channels", { type: "push", name: "Mobile app" });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("push_not_configured");
    const ok = await call(configured, u, "POST", "/channels", { type: "push", name: "Mobile app", config: { junk: 1 } });
    expect(ok.status).toBe(201);
    expect(ok.body.type).toBe("push");
    expect(ok.body.config).toEqual({});
  });

  it("delivers through the stub transport to every member's devices, for the channel test too", async () => {
    const u = await signUp("deliver");
    const mate = await signUp("mate");
    const [org] = (await sql<{ organization_id: string }>("select organization_id from member where user_id = $1", [u.id])).map((r) => r.organization_id);
    await sql(`insert into member (id, organization_id, user_id, role, created_at) values ($1, $2, $3, 'member', now())`, [crypto.randomUUID(), org, mate.id]);
    const [t1, t2] = [tok(), tok()];
    await call(configured, u, "PUT", "/push/devices", { token: t1, platform: "ios", environment: "production", locale: "en" });
    await call(configured, mate, "PUT", "/push/devices", { token: t2, platform: "ios", environment: "sandbox", locale: "zh-CN" });
    const ch = (await call(configured, u, "POST", "/channels", { type: "push", name: "Mobile app" })).body;

    const seen: ApnsRequest[] = [];
    setApnsTransport(async (r) => {
      seen.push(r);
      return r.path.endsWith(t2) ? { status: 410, body: "" } : { status: 200, body: "" };
    });
    const res = await call(configured, u, "POST", `/channels/${ch.id}/test`);
    expect(res.status).toBe(200);
    expect(seen.map((r) => r.host).sort()).toEqual(["api.development.push.apple.com", "api.push.apple.com"]);
    expect(JSON.parse(seen.find((r) => r.path.endsWith(t2))!.body).aps.alert.title).toBe("渠道已连通");
    // the dead token was dropped
    expect((await call(configured, mate, "GET", "/push/devices")).body).toEqual([]);
    expect((await call(configured, u, "GET", "/push/devices")).body).toHaveLength(1);
    const logged = await sql<{ ok: boolean; kind: string }>("select ok, kind from alert_delivery where channel_id = $1", [ch.id]);
    expect(logged).toEqual([{ ok: true, kind: "test" }]);

    // all attempts failing surfaces as an error on the test and in the log, without the token
    setApnsTransport(async () => ({ status: 503, body: "" }));
    const bad = await call(configured, u, "POST", `/channels/${ch.id}/test`);
    expect(bad.status).toBe(502);
    expect(JSON.stringify(bad.body)).not.toContain(t1);
  });
});
