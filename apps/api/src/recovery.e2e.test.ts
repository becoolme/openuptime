import { checkOne } from "./scheduler";
import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "recovery-monitor-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };

describe.skipIf(!url)("Recovery thresholds through the API", () => {
  it("persists settings and delays heartbeat recovery until the configured number of pings", async () => {
    const db = openDatabase(url!, { max: 1 });
    await db.migrate();
    const app = createApp(openDatabase);
    let cookie = "";
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app.fetch(new Request(`${origin}/api${path}`, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never);
      const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      if (cookies) cookie = cookies;
      return { status: r.status, body: await r.json().catch(() => null) as any };
    };
    try {
      expect((await call("POST", "/auth/sign-up/email", { email: `recovery-${crypto.randomUUID()}@example.com`, name: "Recovery", password: "correct horse battery" })).status).toBe(200);
      const orgId = (await call("GET", "/me")).body.organization.id;
      const created = await call("POST", "/monitors", { name: "Job", type: "heartbeat", recoveryThreshold: 2, failureThreshold: 1 });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ recoveryThreshold: 2, consecutiveSuccesses: 0 });
      const path = `/monitors/${created.body.id}`;
      const ping = `/heartbeat/${created.body.heartbeatToken}`;
      expect((await call("PATCH", path, { name: "Renamed" })).body.recoveryThreshold).toBe(2);
      const exported = await call("GET", "/monitors/export");
      expect(exported.body.monitors[0].recoveryThreshold).toBe(2);
      expect(exported.body.monitors[0]).not.toHaveProperty("consecutiveSuccesses");
      expect((await call("POST", "/monitors/import", exported.body)).body).toMatchObject({ created: 1 });
      expect((await call("GET", "/monitors")).body.every((m: any) => m.recoveryThreshold === 2)).toBe(true);
      const missed = async () => { await checkOne(db.repo, (await db.repo.getMonitor(orgId, created.body.id, null))!); };
      await missed();
      expect((await call("GET", path)).body.status).toBe("down");
      await call("POST", ping);
      expect((await call("GET", path)).body).toMatchObject({ status: "down", consecutiveSuccesses: 1 });
      expect(await db.repo.hasOpenIncident(created.body.id, false)).toBe(true);
      await missed();
      expect((await call("GET", path)).body.consecutiveSuccesses).toBe(0);
      await Promise.all([call("POST", ping), call("POST", ping)]);
      expect((await call("GET", path)).body).toMatchObject({ status: "up", consecutiveSuccesses: 2 });
      expect(await db.repo.hasOpenIncident(created.body.id, false)).toBe(false);
      await call("PATCH", path, { paused: true });
      expect((await call("POST", ping)).body.paused).toBe(true);
      expect((await call("GET", path)).body.consecutiveSuccesses).toBe(0);
      await call("PATCH", path, { paused: false });
      expect((await call("GET", path)).body.consecutiveSuccesses).toBe(0);
      for (const recoveryThreshold of [0, 11, 1.5]) expect((await call("PATCH", path, { recoveryThreshold })).status).toBe(400);
      const bare = await call("POST", "/monitors", { name: "Default", type: "heartbeat" });
      expect(bare.body.recoveryThreshold).toBe(1);
    } finally { await db.close(1); }
  });
});
