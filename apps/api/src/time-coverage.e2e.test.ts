import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { checkOne } from "./scheduler";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin, CRON_SECRET: "cron" };

describe.skipIf(!url)("time coverage API", () => {
  const app = createApp(openDatabase);
  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${origin}${path}`, init), env as never);
  async function account() {
    await raw("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const signup = await raw("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `coverage-${crypto.randomUUID()}@example.com`, password: "correct horse battery", name: "Ada" }) });
    const cookie = signup.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return (path: string, method = "GET", body?: unknown) => raw(`/api${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  it("returns unknown for new monitors, validates windows and protects other workspaces", async () => {
    const call = await account();
    const created = await call("/monitors", "POST", { name: "Coverage", type: "heartbeat", intervalSec: 60 });
    expect(created.status).toBe(201);
    const m = await created.json() as { id: string; heartbeatToken: string };
    const response = await call(`/monitors/${m.id}/time-coverage`);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const report = await response.json() as { totalMs: number; states: { unknown: number; up: number } };
    expect(report.states.unknown).toBe(report.totalMs); expect(report.states.up).toBe(0);
    expect((await call(`/monitors/${m.id}/time-coverage?days=30`)).status).toBe(200);
    expect((await call(`/monitors/${m.id}/time-coverage?days=31`)).status).toBe(400);
    expect((await call("/monitors/not-a-uuid/time-coverage")).status).toBe(404);
    expect((await raw(`/api/monitors/${m.id}/time-coverage`)).status).toBe(401);
    const other = await account();
    expect((await other(`/monitors/${m.id}/time-coverage`)).status).toBe(404);
    expect((await raw(`/api/heartbeat/${m.heartbeatToken}`, { method: "POST" })).status).toBe(200);
    const after = await (await call(`/monitors/${m.id}/time-coverage`)).json() as { states: { up: number } };
    expect(after.states.up).toBeGreaterThan(0);
    const racing = createApp((connection, options) => {
      const database = openDatabase(connection, options);
      return { ...database, repo: { ...database.repo, monitorByHeartbeatToken: async (token) => {
        const snapshot = await database.repo.monitorByHeartbeatToken(token);
        if (snapshot) await database.repo.updateMonitor(snapshot.organizationId, snapshot.id, null, { intervalSec: 120 });
        return snapshot;
      } } };
    });
    const concurrentPing = await racing.fetch(new Request(`${origin}/api/heartbeat/${m.heartbeatToken}`, { method: "POST" }), env as never);
    expect(await concurrentPing.json()).toEqual({ ok: true });
    const renewed = await (await call(`/monitors/${m.id}`)).json() as { status: string; intervalSec: number; nextCheckAt: string; lastCheckedAt: string };
    expect(renewed).toMatchObject({ status: "up", intervalSec: 120 });
    expect(Date.parse(renewed.nextCheckAt)).toBeGreaterThan(Date.now() + 110_000);
    expect(Date.parse(renewed.lastCheckedAt)).toBeGreaterThan(Date.now() - 10_000);
    expect((await call(`/monitors/${m.id}`, "PATCH", { paused: true })).status).toBe(200);
    expect(await (await raw(`/api/heartbeat/${m.heartbeatToken}`, { method: "POST" })).json()).toMatchObject({ paused: true });
  });
  it("records a completed failure and opens its incident after a newer lease exists", async () => {
    const call = await account();
    const created = await call("/monitors", "POST", { name: "Overlapping lease", type: "heartbeat", intervalSec: 60, failureThreshold: 1 });
    const m = await created.json() as { id: string; organizationId: string };
    const database = openDatabase(url!, { max: 1 });
    try {
      await database.query("update monitor set run_generation=2 where id=$1", [m.id]);
      const snapshot = (await database.repo.getMonitor(m.organizationId, m.id, null))!;
      // Generation 1 started before generation 2 was claimed, but has only just completed.
      await checkOne(database.repo, { ...snapshot, runGeneration: 1 }, undefined, true);
      expect(await database.query("select id from check_result where monitor_id=$1", [m.id])).toHaveLength(1);
      expect(await database.repo.hasOpenIncident(m.id, false)).toBe(true);
      expect((await database.repo.getMonitor(m.organizationId, m.id, null))?.status).toBe("down");
    } finally { await database.close(1); }
  });

});
