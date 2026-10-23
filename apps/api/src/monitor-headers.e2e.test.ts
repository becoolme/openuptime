import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { MASK } from "./secrets";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "monitor-headers-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };

describe.skipIf(!url)("monitor request permissions", () => {
  it("requires a manager to change a request that retains stored headers", async () => {
    const db = openDatabase(url!, { max: 1 });
    await db.migrate();
    const app = createApp(openDatabase);
    const call = async (cookie: string, method: string, path: string, body?: unknown) => {
      const r = await app.fetch(new Request(`${origin}/api${path}`, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never);
      return { status: r.status, body: await r.json().catch(() => null) as any, cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
    };
    const signup = async () => {
      const r = await call("", "POST", "/auth/sign-up/email", { email: `headers-${crypto.randomUUID()}@example.com`, name: "Headers", password: "correct horse battery" });
      expect(r.status).toBe(200);
      return { id: r.body.user.id, cookie: r.cookie };
    };
    try {
      const owner = await signup();
      const member = await signup();
      const orgId = (await call(owner.cookie, "GET", "/me")).body.organization.id;
      await db.query(`insert into member (id, organization_id, user_id, role, created_at) values ($1, $2, $3, 'member', now())`, [crypto.randomUUID(), orgId, member.id]);
      const active = await call(member.cookie, "POST", "/auth/organization/set-active", { organizationId: orgId });
      expect(active.status).toBe(200);
      member.cookie = active.cookie || member.cookie;
      const mon = await call(owner.cookie, "POST", "/monitors", { name: "Protected", type: "http", target: "https://1.1.1.1/health", headers: { Authorization: "Bearer fixture-only" } });
      expect(mon.status).toBe(201);
      const path = `/monitors/${mon.body.id}`;
      expect((await call(member.cookie, "GET", path)).body.headers).toEqual({ Authorization: MASK });
      for (const patch of [
        { target: "https://8.8.8.8/health" }, { method: "POST" },
        { headers: { Authorization: MASK, Host: "example.com" } },
      ]) {
        expect(await call(member.cookie, "PATCH", path, patch)).toMatchObject({ status: 403, body: { code: "protected_request_headers" } });
      }
      expect((await db.repo.getMonitor(orgId, mon.body.id, null))?.headers).toEqual({ Authorization: "Bearer fixture-only" });
      expect((await call(member.cookie, "PATCH", path, { name: "Renamed", target: mon.body.target, method: "GET", headers: { Authorization: MASK } })).status).toBe(200);
      expect((await call(owner.cookie, "PATCH", path, { target: "https://8.8.8.8/health" })).status).toBe(200);
      expect((await call(member.cookie, "PATCH", path, { target: "https://1.1.1.1/health", headers: { "X-Check": "new-member-supplied-value" } })).status).toBe(200);
      expect((await call(member.cookie, "PATCH", path, { headers: {} })).status).toBe(200);
      expect((await call(member.cookie, "PATCH", path, { target: "https://8.8.8.8/health" })).status).toBe(200);
    } finally {
      await db.close(1);
    }
  });
});
