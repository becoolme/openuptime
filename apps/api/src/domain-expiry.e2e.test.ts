import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { checkOne } from "./scheduler";
const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "domain-monitor-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };
describe.skipIf(!url)("domain monitors and shared cache", () => {
  it("serializes concurrent fills and reloads expired data", async () => {
    const db = openDatabase(url!, { max: 4 }); await db.migrate();
    const key = crypto.randomUUID(); let calls = 0;
    try {
      const load = async () => { calls++; await new Promise(r => setTimeout(r, 30)); return { value: { fixture: true }, expiresAt: new Date(Date.now() + 60_000) }; };
      await Promise.all(Array.from({ length: 8 }, () => db.repo.cachedRdap(key, load)));
      expect(calls).toBe(1);
      await db.query("update rdap_cache set expires_at=now()-interval '1 second' where key=$1", [key]);
      await db.repo.cachedRdap(key, load); expect(calls).toBe(2);
      await db.repo.cachedRdap(key, load, 120_000); expect(calls).toBe(3);
      await db.query("update rdap_cache set value=$1 where key=$2", [JSON.stringify({ error: "429" }), key]);
      await db.repo.cachedRdap(key, load, 120_000); expect(calls).toBe(3);
    } finally { await db.close(1); }
  });
  it("supports create/edit/export/import with bounded intervals and invalidates changed targets", async () => {
    const db = openDatabase(url!, { max: 1 }); await db.migrate(); const app = createApp(openDatabase);
    let cookie = "";
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app.fetch(new Request(`${origin}/api${path}`, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never);
      if (r.headers.getSetCookie().length) cookie = r.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
      return { status: r.status, body: await r.json() as any };
    };
    try {
      expect((await call("POST", "/auth/sign-up/email", { email: `domain-${crypto.randomUUID()}@example.com`, name: "Domain", password: "correct horse battery" })).status).toBe(200);
      const mon = await call("POST", "/monitors", { name: "Registration", type: "domain", target: "example.com", intervalSec: 60, domainExpiryWarnDays: 45 });
      expect(mon).toMatchObject({ status: 201, body: { type: "domain", intervalSec: 3600, domainExpiryWarnDays: 45 } });
      expect((await call("POST", "/monitors", { name: "Wrong", type: "domain", target: "https://example.com" })).status).toBe(400);
      expect((await call("POST", "/monitors", { name: "Remote", type: "domain", target: "example.com", regions: ["us-east"] })).status).toBe(400);
      const path = `/monitors/${mon.body.id}`;
      expect((await call("PATCH", path, { domainExpiryWarnDays: 0 })).status).toBe(400);
      await db.query("update monitor set domain_expiry=$1 where id=$2", [JSON.stringify({ state: "valid" }), mon.body.id]);
      expect(await call("PATCH", path, { target: "example.net", intervalSec: 60 })).toMatchObject({ status: 200, body: { domainExpiry: null, intervalSec: 3600 } });
      for (const change of [{ target: "example.org" }, { domainExpiryWarnDays: 60 }, { paused: true }]) {
        const created = await call("POST", "/monitors", { name: "Race", type: "domain", target: "example.com", failureThreshold: 1 });
        const snapshot = (await db.repo.getMonitor(created.body.organizationId, created.body.id, null))!;
        let release!: () => void; let entered!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const ready = new Promise<void>(resolve => { entered = resolve; });
        const checking = checkOne({ ...db.repo, cachedRdap: async key => {
          if (key === "bootstrap:v1") return { value: { data: {} }, expiresAt: new Date(Date.now() + 3600_000) };
          entered(); await blocked;
          return { value: { expiresAt: new Date(Date.now() + 5 * 864e5).toISOString(), checkedAt: new Date().toISOString(), source: "https://registry.example", error: null }, expiresAt: new Date(Date.now() + 3600_000) };
        } }, snapshot);
        await ready;
        try { expect((await call("PATCH", `/monitors/${snapshot.id}`, change)).status).toBe(200); }
        finally { release(); }
        await checking;
        const current = await db.repo.getMonitor(snapshot.organizationId, snapshot.id, null);
        expect(current).toMatchObject({ domainExpiry: null, status: "paused" in change ? "paused" : "pending", consecutiveFailures: 0 });
        expect(await db.query("select id from check_result where monitor_id=$1", [snapshot.id])).toHaveLength(0);
        expect(await db.query("select id from incident where monitor_id=$1", [snapshot.id])).toHaveLength(0);
        await db.repo.deleteMonitor(snapshot.organizationId, snapshot.id, null);
      }
      const exported = await call("GET", "/monitors/export");
      expect(exported.body.monitors[0]).toMatchObject({ type: "domain", domainExpiryWarnDays: 45 });
      expect((await call("POST", "/monitors/import", exported.body)).status).toBe(201);
    } finally { await db.close(1); }
  });
});
