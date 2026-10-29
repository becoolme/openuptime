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
      expect((await call("POST", "/monitors/import", { monitors: exported.body.monitors.map(({ source, sourceId, ...m }: any) => m) })).body).toMatchObject({ created: 1 });
      expect((await call("GET", "/monitors")).body.every((m: any) => m.recoveryThreshold === 2)).toBe(true);
      // a miss only happens once the ping's validity has run out; a miss inside it is discarded as stale
      const missed = async () => { await db.query("update monitor_observation set valid_until = now() - interval '1 second' where monitor_id = $1", [created.body.id]); await checkOne(db.repo, (await db.repo.getMonitor(orgId, created.body.id, null))!); };
      await missed();
      expect((await call("GET", path)).body.status).toBe("down");
      await call("POST", ping);
      expect((await call("GET", path)).body).toMatchObject({ status: "down", consecutiveSuccesses: 1 });
      expect(await db.repo.hasOpenIncident(created.body.id, false)).toBe(true);
      // Saying "not paused" about a monitor that is running is not a resume: it keeps its status and its recovery progress.
      expect((await call("PATCH", path, { paused: false })).body).toMatchObject({ status: "down", consecutiveSuccesses: 1 });
      await missed();
      expect((await call("GET", path)).body.consecutiveSuccesses).toBe(0);
      await Promise.all([call("POST", ping), call("POST", ping)]);
      expect((await call("GET", path)).body).toMatchObject({ status: "up", consecutiveSuccesses: 2 });
      expect(await db.repo.hasOpenIncident(created.body.id, false)).toBe(false);
      let entered!: () => void; let release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const racing = createApp((connection, options) => {
        const database = openDatabase(connection, options);
        return { ...database, repo: { ...database.repo, recordHeartbeatObservation: async (monitor) => {
          const result = await database.repo.recordHeartbeatObservation(monitor);
          entered(); await gate; return result;
        } } };
      });
      const delayedPing = racing.fetch(new Request(`${origin}/api${ping}`, { method: "POST" }), env as never);
      await ready;
      try { await missed(); } finally { release(); }
      expect((await delayedPing).status).toBe(200);
      expect((await call("GET", path)).body.status).toBe("down");
      expect(await db.repo.hasOpenIncident(created.body.id, false)).toBe(true);
      await call("PATCH", path, { paused: true });
      expect((await call("POST", ping)).body.paused).toBe(true);
      // A check run by hand on a paused monitor leaves its status and counters alone.
      const pausedBefore = (await call("GET", path)).body;
      await missed();
      expect((await call("GET", path)).body).toMatchObject({ status: pausedBefore.status, consecutiveFailures: pausedBefore.consecutiveFailures, consecutiveSuccesses: 0 });
      expect(pausedBefore.status).toBe("paused");
      expect((await call("GET", path)).body.consecutiveSuccesses).toBe(0);
      await call("PATCH", path, { paused: false });
      expect((await call("GET", path)).body.consecutiveSuccesses).toBe(0);
      for (const recoveryThreshold of [0, 11, 1.5]) expect((await call("PATCH", path, { recoveryThreshold })).status).toBe(400);
      const bare = await call("POST", "/monitors", { name: "Default", type: "heartbeat" });
      expect(bare.body.recoveryThreshold).toBe(1);
    } finally { await db.close(1); }
  });
});
