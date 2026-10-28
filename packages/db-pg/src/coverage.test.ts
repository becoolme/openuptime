import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, createRepo, eq, schema } from "./index";

const url = process.env.DATABASE_URL;
const db = url ? createDb(url, { max: 4 }) : undefined!;
const repo = url ? createRepo(db) : undefined!;
const orgId = `coverage-${crypto.randomUUID()}`;
const now = new Date("2026-10-28T12:00:00Z");
const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
afterEach(() => vi.useRealTimers());
afterAll(async () => { if (url) { await db.delete(schema.organization).where(eq(schema.organization.id, orgId)); await db.$client.end(); } });

describe.skipIf(!url)("bounded observation time coverage", () => {
  beforeAll(async () => { await db.insert(schema.organization).values({ id: orgId, name: "Coverage", slug: orgId, createdAt: now }); });
  async function monitor(extra: Partial<typeof schema.monitor.$inferInsert> = {}) {
    return (await db.insert(schema.monitor).values({ organizationId: orgId, name: "Service", target: "https://example.com", intervalSec: 60, timeoutMs: 10000, ...extra }).returning())[0];
  }
  const clock = (seconds: number) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(at(seconds)); };

  it("never backfills healthy time from current monitor status", async () => {
    const m = await monitor({ status: "up" });
    const report = await repo.timeCoverage(orgId, m.id, null, 7, now);
    expect(report?.states).toEqual({ up: 0, down: 0, degraded: 0, paused: 0, unknown: 7 * 86400000 });
  });

  it("clips overlapping observations, preserves unknown gaps and separates slow/failing checks from alert thresholds", async () => {
    const m = await monitor({ failureThreshold: 20 });
    clock(0); expect(await repo.recordObservation(m, { ok: true })).toBe(true);
    clock(60); await repo.recordObservation(m, { ok: false });
    clock(300); await repo.recordObservation(m, { ok: true, latencyMs: 3000 });
    const r = (await repo.timeCoverage(orgId, m.id, null, 7, at(400)))!;
    expect(r.states).toEqual({ up: 60000, down: 130000, degraded: 100000, paused: 0, unknown: r.totalMs - 290000 });
    expect(Object.values(r.states).reduce((a, b) => a + b)).toBe(r.totalMs);
    expect((await repo.getMonitor(orgId, m.id, null))?.status).toBe("pending");
  });

  it("fences old configuration results and cuts observations at pause/resume boundaries", async () => {
    const m = await monitor();
    clock(0); await repo.recordObservation(m, { ok: true });
    clock(20); const paused = (await repo.updateMonitor(orgId, m.id, null, { paused: true, status: "paused" }))!;
    clock(30); expect(await repo.recordObservation(m, { ok: false })).toBe(false);
    clock(70); const resumed = (await repo.updateMonitor(orgId, m.id, null, { paused: false, status: "pending" }))!;
    expect(await repo.recordObservation(paused, { ok: true })).toBe(false);
    clock(100); await repo.recordObservation(resumed, { ok: true });
    const r = (await repo.timeCoverage(orgId, m.id, null, 7, at(150)))!;
    expect(r.states.up).toBe(70000); expect(r.states.paused).toBe(50000);
    expect(r.states.unknown).toBe(r.totalMs - 120000);
  });

  it("orders pause fences after observations even across a backwards application clock", async () => {
    const m = await monitor(); clock(10); await repo.recordObservation(m, { ok: true });
    clock(0); await repo.updateMonitor(orgId, m.id, null, { paused: true });
    const r = (await repo.timeCoverage(orgId, m.id, null, 7, at(20)))!;
    expect(r.states.up).toBe(0); expect(r.states.paused).toBe(10000);
  });

  it("serializes concurrent duplicate generations and rejects older late completions", async () => {
    const m = await monitor({ runGeneration: 2 });
    clock(0);
    const accepted = await Promise.all([repo.recordObservation(m, { ok: true }, { generation: 2 }), repo.recordObservation(m, { ok: false }, { generation: 2 })]);
    expect(accepted.sort()).toEqual([false, true]);
    expect(await repo.recordObservation(m, { ok: true }, { generation: 1 })).toBe(false);
    expect(await repo.recordObservation(m, { ok: true }, { generation: 3 })).toBe(false);
    expect(await repo.recordObservation(m, { ok: true }, { generation: 0 })).toBe(false);
    expect(await db.select().from(schema.monitorObservation).where(eq(schema.monitorObservation.monitorId, m.id))).toHaveLength(1);
    // A deliberate manual check remains possible after the scheduled generation has completed.
    clock(20); expect(await repo.recordObservation(m, { ok: true })).toBe(true);
  });

  it("uses heartbeat grace, rejects a missed check racing a new ping, and leaves expired coverage unknown", async () => {
    const m = await monitor({ type: "heartbeat", intervalSec: 60, graceSec: 15 });
    clock(0); await repo.recordObservation(m, { ok: true }, { heartbeatPing: true });
    clock(1); expect(await repo.recordObservation(m, { ok: false })).toBe(false);
    const r = (await repo.timeCoverage(orgId, m.id, null, 7, at(100)))!;
    expect(r.states.up).toBe(75000); expect(r.states.down).toBe(0);
    expect(r.states.unknown).toBe(r.totalMs - 75000);
    // Even if lastCheckedAt was never updated (a process died), a newly loaded missed check is accepted.
    clock(100); const loaded = (await repo.getMonitor(orgId, m.id, null))!;
    expect(loaded.lastCheckedAt).toBeNull();
    expect(await repo.recordObservation(loaded, { ok: false })).toBe(true);
  });

  it("captures maintenance labels without later edits rewriting history or excluding failures", async () => {
    const m = await monitor();
    const [window] = await db.insert(schema.maintenanceWindow).values({ organizationId: orgId, name: "Upgrade", startsAt: at(-1), endsAt: at(50), monitorIds: [m.id] }).returning();
    clock(0); await repo.recordObservation(m, { ok: false });
    await db.delete(schema.maintenanceWindow).where(eq(schema.maintenanceWindow.id, window.id));
    const r = (await repo.timeCoverage(orgId, m.id, null, 7, at(100)))!;
    expect(r.states.down).toBe(100000); expect(r.observedMaintenanceMs).toBe(50000);
  });

  it("enforces workspace and project scope, including empty scope", async () => {
    const [p] = await db.insert(schema.project).values({ organizationId: orgId, name: "A" }).returning();
    const m = await monitor({ projectId: p.id });
    expect(await repo.timeCoverage("someone-else", m.id, null, 7, now)).toBeNull();
    expect(await repo.timeCoverage(orgId, m.id, [], 7, now)).toBeNull();
    expect(await repo.timeCoverage(orgId, m.id, [crypto.randomUUID()], 7, now)).toBeNull();
    expect(await repo.timeCoverage(orgId, m.id, [p.id], 7, now)).not.toBeNull();
  });

  it("keeps the latest predecessor at retention boundaries instead of resurrecting old pauses", async () => {
    const m = await monitor();
    const old = new Date(Date.now() - 40 * 86400000);
    await db.insert(schema.monitorObservation).values([
      { monitorId: m.id, observedAt: new Date(old.getTime() - 1000), state: "paused", revision: 0 },
      { monitorId: m.id, observedAt: old, state: "unknown", revision: 1 },
    ]);
    await repo.purgeExpired();
    const kept = await db.select().from(schema.monitorObservation).where(eq(schema.monitorObservation.monitorId, m.id));
    expect(kept).toHaveLength(1); expect(kept[0].state).toBe("unknown");
    const r = (await repo.timeCoverage(orgId, m.id, null, 30))!;
    expect(r.states.unknown).toBe(r.totalMs);
  });

  it("uses the predecessor at the left boundary and does not double count equal timestamps", async () => {
    const m = await monitor();
    const from = new Date(now.getTime() - 7 * 86400000);
    await db.insert(schema.monitorObservation).values([
      { monitorId: m.id, observedAt: new Date(from.getTime() - 2000), validUntil: new Date(from.getTime() + 2000), state: "up", revision: 0 },
      { monitorId: m.id, observedAt: from, state: "paused", revision: 1 },
      { monitorId: m.id, observedAt: from, state: "unknown", revision: 2 },
    ]);
    const r = (await repo.timeCoverage(orgId, m.id, null, 7, now))!;
    expect(r.states.unknown).toBe(r.totalMs); expect(r.states.up).toBe(0); expect(r.states.paused).toBe(0);
  });
});
