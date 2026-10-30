import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Monitor, Scope, TimeCoverage } from "@openuptime/repo";
import type { DbExecutor as Db } from "./client";
import * as schema from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Bound application clock skew by the database clock; repair impossible future events on the next write. */
export async function coverageTime(tx: Tx, monitorId: string, completedAt = new Date()): Promise<Date> {
  const [clock] = await tx.execute<{ at: Date }>(sql`select clock_timestamp() as at`);
  const dbAt = new Date(clock.at);
  await tx.update(schema.monitorObservation).set({
    observedAt: dbAt,
    validUntil: sql`case when ${schema.monitorObservation.validUntil} is null then null else ${schema.monitorObservation.validUntil} - (${schema.monitorObservation.observedAt} - ${dbAt.toISOString()}::timestamptz) end`,
  }).where(and(eq(schema.monitorObservation.monitorId, monitorId), gt(schema.monitorObservation.observedAt, dbAt)));
  const [last] = await tx.select({ at: schema.monitorObservation.observedAt }).from(schema.monitorObservation)
    .where(eq(schema.monitorObservation.monitorId, monitorId)).orderBy(desc(schema.monitorObservation.observedAt), desc(schema.monitorObservation.id)).limit(1);
  return new Date(Math.max(Math.min(completedAt.getTime(), dbAt.getTime()), last?.at.getTime() ?? 0));
}

export async function recordObservation(db: Db, snapshot: Monitor, result: { ok: boolean; latencyMs?: number | null; degraded?: boolean }, options: { generation?: number; heartbeatPing?: boolean } = {}): Promise<boolean> {
  return !!(await appendObservation(db, snapshot, result, options));
}

/** A ping is evidence for the current configuration and renews its deadline in the same transaction. */
export function recordHeartbeatObservation(db: Db, snapshot: Monitor): Promise<Monitor | null> {
  return appendObservation(db, snapshot, { ok: true }, { heartbeatPing: true });
}

/** Store the configuration that actually produced the observation. Never re-interpret old data with today's config. */
async function appendObservation(db: Db, snapshot: Monitor, result: { ok: boolean; latencyMs?: number | null; degraded?: boolean }, options: { generation?: number; heartbeatPing?: boolean } = {}): Promise<Monitor | null> {
  // Capture completion before waiting on the lock: database congestion must not extend freshness.
  const completedAt = new Date();
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(schema.monitor).where(eq(schema.monitor.id, snapshot.id)).for("update");
    if (!current || current.paused || (!options.heartbeatPing && current.coverageRevision !== (snapshot.coverageRevision ?? 0))) return null;
    if (options.heartbeatPing && current.type !== "heartbeat") return null;
    const generation = options.generation;
    if (generation !== undefined && (!Number.isSafeInteger(generation) || generation <= 0 || generation > current.runGeneration || generation <= current.coverageGeneration)) return null;
    const at = await coverageTime(tx, current.id, completedAt);
    const [last] = await tx.select().from(schema.monitorObservation).where(eq(schema.monitorObservation.monitorId, snapshot.id))
      .orderBy(desc(schema.monitorObservation.observedAt), desc(schema.monitorObservation.id)).limit(1);
    // The ping fence is committed with the observation, not the later mutable lastCheckedAt/incident updates.
    if (current.type === "heartbeat" && !options.heartbeatPing && current.coverageHeartbeatVersion !== (snapshot.coverageHeartbeatVersion ?? 0)) return null;
    // A scheduler may load the new ping version before the ping handler updates nextCheckAt.
    // Check the committed observation under the same lock, not that mutable deadline.
    if (current.type === "heartbeat" && !options.heartbeatPing && !result.ok
      && last?.revision === current.coverageRevision && (last.state === "up" || last.state === "degraded")
      && last.validUntil && last.validUntil > at) return null;
    const durationMs = current.type === "heartbeat"
      ? (current.intervalSec + current.graceSec) * 1000
      : current.intervalSec * 1000 + current.timeoutMs + 60_000;
    const windows = await tx.select({ endsAt: schema.maintenanceWindow.endsAt }).from(schema.maintenanceWindow).where(and(
      eq(schema.maintenanceWindow.organizationId, current.organizationId),
      current.projectId ? or(isNull(schema.maintenanceWindow.projectId), eq(schema.maintenanceWindow.projectId, current.projectId)) : isNull(schema.maintenanceWindow.projectId),
      lte(schema.maintenanceWindow.startsAt, at), gt(schema.maintenanceWindow.endsAt, at),
      or(sql`cardinality(${schema.maintenanceWindow.monitorIds}) = 0`, sql`${current.id} = any(${schema.maintenanceWindow.monitorIds})`),
    ));
    const maintenanceUntil = windows.length ? new Date(Math.max(...windows.map((w) => w.endsAt.getTime()))) : null;
    await tx.insert(schema.monitorObservation).values({
      monitorId: current.id, observedAt: at,
      state: !result.ok ? "down" : result.degraded || (result.latencyMs != null && result.latencyMs > current.slowThresholdMs) ? "degraded" : "up",
      validUntil: new Date(at.getTime() + durationMs), maintenanceUntil,
      revision: current.coverageRevision, generation, intervalSec: current.intervalSec, graceSec: current.graceSec, timeoutMs: current.timeoutMs,
    });
    if (options.heartbeatPing) {
      const [updated] = await tx.update(schema.monitor).set({
        coverageHeartbeatVersion: current.coverageHeartbeatVersion + 1,
        consecutiveSuccesses: sql`least(${schema.monitor.consecutiveSuccesses} + 1, ${schema.monitor.recoveryThreshold})`,
        consecutiveFailures: 0, lastCheckedAt: at,
        nextCheckAt: sql`clock_timestamp() + make_interval(secs => ${schema.monitor.intervalSec} + ${schema.monitor.graceSec})`,
        status: current.status === "down" ? "down" : "up",
        ...(current.status !== "down" && current.status !== "up" ? { statusChangedAt: at } : {}),
      }).where(eq(schema.monitor.id, current.id)).returning();
      return updated;
    }
    if (generation !== undefined) await tx.update(schema.monitor).set({
      ...(generation !== undefined ? { coverageGeneration: generation } : {}),
    }).where(eq(schema.monitor.id, current.id));
    return current;
  });
}

/** Aggregate in PostgreSQL, avoiding a month's raw observations in Worker memory. */
export async function timeCoverage(db: Db, orgId: string, monitorId: string, scope: Scope, days: 7 | 30, now = new Date()): Promise<TimeCoverage | null> {
  if (days !== 7 && days !== 30) throw new Error("Coverage window must be 7 or 30 days");
  const [m] = await db.select({ id: schema.monitor.id }).from(schema.monitor).where(and(eq(schema.monitor.id, monitorId), eq(schema.monitor.organizationId, orgId), scope ? inArray(schema.monitor.projectId, scope) : undefined));
  if (!m) return null;
  const from = new Date(now.getTime() - days * 86_400_000);
  const values = await db.execute(sql`
    with events as (
      (select * from monitor_observation where monitor_id = ${monitorId} and observed_at < ${from.toISOString()} order by observed_at desc, id desc limit 1)
      union all
      (select * from monitor_observation where monitor_id = ${monitorId} and observed_at >= ${from.toISOString()} and observed_at < ${now.toISOString()})
    ), spans as (
      select state, maintenance_until, greatest(observed_at, ${from.toISOString()}::timestamptz) as lo,
        least(lead(observed_at, 1, ${now.toISOString()}::timestamptz) over (order by observed_at, id), coalesce(valid_until, ${now.toISOString()}::timestamptz), ${now.toISOString()}::timestamptz) as hi
      from events
    ) select state, coalesce(sum(greatest(0, extract(epoch from (hi-lo)) * 1000)), 0)::double precision as ms,
      coalesce(sum(case when maintenance_until is not null then greatest(0, extract(epoch from (least(hi, maintenance_until)-lo)) * 1000) else 0 end), 0)::double precision as maintenance_ms
      from spans group by state`);
  const totalMs = now.getTime() - from.getTime();
  const states = { up: 0, down: 0, degraded: 0, paused: 0, unknown: 0 };
  let observedMaintenanceMs = 0;
  for (const row of values) {
    const state = String(row.state);
    if (state === "up" || state === "down" || state === "degraded" || state === "paused") states[state] = Number(row.ms);
    observedMaintenanceMs += Number(row.maintenance_ms);
  }
  // Everything without a still-valid observation is unknown, including time before this feature was deployed.
  states.unknown = Math.max(0, totalMs - states.up - states.down - states.degraded - states.paused);
  return { from: from.toISOString(), to: now.toISOString(), totalMs, states, observedMaintenanceMs, policy: "bounded-observation-v1" };
}
