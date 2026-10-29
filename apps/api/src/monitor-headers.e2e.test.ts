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
      const withBody = await call(owner.cookie, "POST", "/monitors", { name: "Body", type: "http", target: "https://1.1.1.1/health", method: "POST", requestBody: "token=fixture-secret" });
      expect(withBody.status).toBe(201);
      const bodyPath = `/monitors/${withBody.body.id}`;
      expect((await call(member.cookie, "GET", bodyPath)).body.requestBody).toBe(MASK);
      expect((await call(owner.cookie, "GET", bodyPath)).body.requestBody).toBe("token=fixture-secret");
      expect((await call(member.cookie, "GET", "/monitors")).body.find((m: any) => m.id === withBody.body.id).requestBody).toBe(MASK);
      const maskedExport = (await call(member.cookie, "GET", "/monitors/export")).body;
      expect(maskedExport.monitors.find((m: any) => m.name === "Body").requestBody).toBe(MASK);
      expect((await call(owner.cookie, "POST", "/monitors/import", [maskedExport.monitors.find((m: any) => m.name === "Body")])).body).toMatchObject({ created: 0, skipped: [{ error: expect.stringContaining("masked request body") }] });
      for (const patch of [{ target: "https://8.8.8.8/" }, { method: "PUT" }, { headers: { Host: "elsewhere.example" } }, { target: "https://8.8.8.8/", requestBody: MASK }]) {
        expect(await call(member.cookie, "PATCH", bodyPath, patch)).toMatchObject({ status: 403 });
      }
      expect((await call(member.cookie, "PATCH", bodyPath, { name: "Body renamed", requestBody: MASK })).status).toBe(200);
      expect((await db.repo.getMonitor(orgId, withBody.body.id, null))?.requestBody).toBe("token=fixture-secret");
      expect((await call(owner.cookie, "PATCH", bodyPath, { method: "GET" })).status).toBe(400);
      expect((await call(owner.cookie, "PATCH", bodyPath, { requestBody: "你".repeat(5462) })).status).toBe(400);
      expect((await call(member.cookie, "PATCH", bodyPath, { target: "https://8.8.8.8/", requestBody: null })).status).toBe(200);
      expect((await call(owner.cookie, "POST", "/monitors", { name: "Invalid GET", target: "https://1.1.1.1/", requestBody: "x" })).status).toBe(400);
      expect((await call(owner.cookie, "POST", "/monitors", { name: "Invalid TCP", type: "tcp", target: "1.1.1.1:80", method: "POST", requestBody: "x" })).status).toBe(400);
      const exported = (await call(owner.cookie, "GET", "/monitors/export")).body.monitors.find((m: any) => m.name === "Body renamed");
      exported.requestBody = '{"ok":true}'; exported.method = "PATCH";
      expect((await call(owner.cookie, "POST", "/monitors/import", [{ ...exported, source: undefined, sourceId: undefined }])).body).toMatchObject({ created: 1, skipped: [] });
      const imported = (await call(owner.cookie, "GET", "/monitors")).body.find((m: any) => m.id !== withBody.body.id && m.name === "Body renamed");
      expect(imported).toMatchObject({ method: "PATCH", requestBody: '{"ok":true}' });
    } finally {
      await db.close(1);
    }
  });
});
