import { SERVER_METRIC_RETENTION_DAYS, type Repo, type Server, type ServerMetricPoint } from "@openuptime/repo";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbExecutor } from "./client";
import * as schema from "./schema";

type ServerMethods = Pick<Repo,
  | "serverAgentKey" | "rotateServerAgentKey" | "serverAgentKeyOwner" | "serverByMachine" | "createServer" | "recordServerReport"
  | "listServers" | "serverCount" | "serverRank" | "serverMonitorIds" | "serverCpuSeries" | "server" | "updateServer" | "deleteServer" | "serverMetrics">;

const newKey = () => `oua_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
const S = schema.server;
const M = schema.serverMetric;

/** Storage of agent-reported servers and their metrics. */
export function serverRepo(db: DbExecutor): ServerMethods {
  const mine = (orgId: string, projectId: string, id: string) => and(eq(S.id, id), eq(S.organizationId, orgId), eq(S.projectId, projectId));
  const one = async (orgId: string, projectId: string, id: string) => {
    const [row] = await db.select().from(S).where(mine(orgId, projectId, id));
    return (row as Server | undefined) ?? null;
  };
  return {
    async serverAgentKey(orgId, projectId) {
      const K = schema.serverAgentKey;
      const [have] = await db.select({ key: K.key }).from(K).where(and(eq(K.projectId, projectId), eq(K.organizationId, orgId)));
      if (have) return have.key;
      await db.insert(K).values({ projectId, organizationId: orgId, key: newKey() }).onConflictDoNothing({ target: K.projectId });
      const [row] = await db.select({ key: K.key }).from(K).where(and(eq(K.projectId, projectId), eq(K.organizationId, orgId)));
      return row.key;
    },
    async rotateServerAgentKey(orgId, projectId, key) {
      const K = schema.serverAgentKey;
      const [row] = await db.insert(K).values({ projectId, organizationId: orgId, key, rotatedAt: new Date() })
        .onConflictDoUpdate({ target: K.projectId, set: { key, rotatedAt: new Date() } }).returning({ key: K.key });
      return row.key;
    },
    async serverAgentKeyOwner(key) {
      const K = schema.serverAgentKey;
      const [row] = await db.select({ orgId: K.organizationId, projectId: K.projectId }).from(K).where(eq(K.key, key));
      return row ?? null;
    },
    async serverByMachine(projectId, machineId) {
      const [row] = await db.select().from(S).where(and(eq(S.projectId, projectId), eq(S.machineId, machineId)));
      return (row as Server | undefined) ?? null;
    },
    async createServer(orgId, projectId, s) {
      const [row] = await db.insert(S).values({ organizationId: orgId, projectId, machineId: s.machineId, name: s.name, tags: s.tags ?? [], intervalSec: s.intervalSec, monitorId: s.monitorId, ...s.host })
        .onConflictDoNothing({ target: [S.projectId, S.machineId] }).returning();
      if (row) return { server: row as Server, created: true };
      const [existing] = await db.select().from(S).where(and(eq(S.projectId, projectId), eq(S.machineId, s.machineId)));
      return { server: existing as Server, created: false };
    },
    async recordServerReport(serverId, host, snapshot, diskUsed, diskTotal) {
      const m = snapshot.metrics;
      await db.update(S).set({ ...host, snapshot, lastSeenAt: new Date(snapshot.at) }).where(eq(S.id, serverId));
      await db.insert(M).values({
        serverId, ts: new Date(snapshot.at), cpu: m.cpu, memUsed: m.memUsed, memCached: m.memCached, swapUsed: m.swapUsed, diskUsed, diskTotal,
        diskReadBps: m.diskReadBps, diskWriteBps: m.diskWriteBps, netRxBps: m.netRxBps, netTxBps: m.netTxBps, load1: m.load1, load5: m.load5, load15: m.load15,
      });
    },
    async listServers(orgId, projectId) {
      const rows = await db.select().from(S).where(and(eq(S.organizationId, orgId), eq(S.projectId, projectId))).orderBy(asc(S.name));
      return rows as Server[];
    },
    async serverCount(orgId) {
      const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(S).where(eq(S.organizationId, orgId));
      return r?.n ?? 0;
    },
    async serverRank(orgId, serverId) {
      const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(S).where(and(
        eq(S.organizationId, orgId),
        sql`(${S.createdAt}, ${S.id}) < (select created_at, id from server where id = ${serverId})`,
      ));
      return r?.n ?? 0;
    },
    async serverMonitorIds(orgId, monitorIds) {
      if (!monitorIds.length) return [];
      const rows = await db.select({ id: S.monitorId }).from(S).where(and(eq(S.organizationId, orgId), inArray(S.monitorId, monitorIds)));
      return rows.map((r) => r.id!);
    },
    async serverCpuSeries(serverIds, minutes) {
      if (!serverIds.length) return {};
      const rows = await db.select({ id: M.serverId, cpu: M.cpu }).from(M)
        .where(and(inArray(M.serverId, serverIds), sql`${M.ts} > now() - make_interval(mins => ${minutes})`)).orderBy(asc(M.ts));
      const out: Record<string, number[]> = {};
      for (const r of rows) (out[r.id] ??= []).push(r.cpu);
      return out;
    },
    server: one,
    async updateServer(orgId, projectId, id, patch) {
      if (!Object.keys(patch).length) return one(orgId, projectId, id);
      const [row] = await db.update(S).set(patch).where(mine(orgId, projectId, id)).returning();
      return (row as Server | undefined) ?? null;
    },
    async deleteServer(orgId, projectId, id) {
      const [row] = await db.delete(S).where(mine(orgId, projectId, id)).returning();
      return (row as Server | undefined) ?? null;
    },
    async serverMetrics(serverId, from, stepSec) {
      const step = Math.max(1, Math.round(stepSec));
      const bucket = sql`to_timestamp(floor(extract(epoch from ${M.ts}) / ${step}) * ${step})`;
      const rows = await db.select({
        t: sql<string>`${bucket}`.as("t"),
        cpu: sql<number>`avg(${M.cpu})::float8`,
        memUsed: sql<number>`avg(${M.memUsed})::float8`,
        swapUsed: sql<number>`avg(${M.swapUsed})::float8`,
        diskUsed: sql<number>`max(${M.diskUsed})::float8`,
        diskTotal: sql<number>`max(${M.diskTotal})::float8`,
        diskReadBps: sql<number>`avg(${M.diskReadBps})::float8`,
        diskWriteBps: sql<number>`avg(${M.diskWriteBps})::float8`,
        netRxBps: sql<number>`avg(${M.netRxBps})::float8`,
        netTxBps: sql<number>`avg(${M.netTxBps})::float8`,
        load1: sql<number>`avg(${M.load1})::float8`,
      }).from(M).where(and(eq(M.serverId, serverId), sql`${M.ts} >= ${from.toISOString()}::timestamptz`))
        .groupBy(sql`1`).orderBy(sql`1`);
      return rows.map((r): ServerMetricPoint => ({
        t: new Date(r.t), cpu: Number(r.cpu), memUsed: Number(r.memUsed), swapUsed: Number(r.swapUsed), diskUsed: Number(r.diskUsed), diskTotal: Number(r.diskTotal),
        diskReadBps: Number(r.diskReadBps), diskWriteBps: Number(r.diskWriteBps), netRxBps: Number(r.netRxBps), netTxBps: Number(r.netTxBps), load1: Number(r.load1),
      }));
    },
  };
}

/** Housekeeping: raw metric rows outlive their charts by nothing. */
export async function purgeServerMetrics(db: DbExecutor) {
  await db.execute(sql`delete from server_metric where ts < now() - make_interval(days => ${SERVER_METRIC_RETENTION_DAYS})`);
}
