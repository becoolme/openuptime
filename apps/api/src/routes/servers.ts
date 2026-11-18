import { zValidator } from "@hono/zod-validator";
import { DEFAULT_SERVER_INTERVAL_SEC, SERVER_INTERVALS, type Repo, type Server, type ServerDisk, type ServerHost, type ServerSnapshot } from "@openuptime/repo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Plan } from "../entitlements";
import type { AppEnv } from "../env";
import { acceptHeartbeat } from "../heartbeat";
import { requireManager, uuidParams } from "../middleware";
import { allow } from "../ratelimit";
import { nextAfter } from "../scheduler";
import { newServerMonitor, serverMonitorTiming } from "./monitors";

/** The shortest report interval allowed: 30 s where there are no plans (self-hosted), else what the plan says (60 s by default). */
export const minServerInterval = (plan: Plan | null) => (plan ? (plan.minServerIntervalSec ?? DEFAULT_SERVER_INTERVAL_SEC) : SERVER_INTERVALS[0]);

/** A server counts as offline once three reports in a row are missing. */
export const serverOnline = (s: Pick<Server, "lastSeenAt" | "intervalSec">, now = Date.now()) =>
  !!s.lastSeenAt && now - s.lastSeenAt.getTime() < s.intervalSec * 3 * 1000;

/** New machines one project may register per hour; a leaked key cannot flood the dashboard. */
const REGISTRATIONS_PER_HOUR = 30;

// totals of several disks still fit a bigint column
const num = z.number().finite().min(0).max(1e15);
const str = (max: number) => z.string().max(max).default("");
// a list the agent found empty may arrive as null
const list = <T extends z.ZodTypeAny>(item: T, max: number) => z.preprocess((v) => v ?? undefined, z.array(item).max(max).default([]));
const addresses = list(z.string().max(64), 32);
export const reportSchema = z.object({
  version: str(32),
  machineId: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  hostname: z.string().trim().max(253).default(""),
  host: z.object({
    os: str(64), platform: str(64), platformVersion: str(64), kernel: str(128), arch: str(32), cpuModel: str(200),
    cores: z.number().int().min(0).max(4096).default(0), memTotal: num.default(0), swapTotal: num.default(0),
    bootTime: z.number().int().min(0).max(4102444800).optional(), uptimeSec: num.optional(),
  }).default({} as never),
  metrics: z.object({
    cpu: z.number().finite().min(0).max(100), memUsed: num, memCached: num.default(0), swapUsed: num.default(0),
    load1: num.default(0), load5: num.default(0), load15: num.default(0),
    diskReadBps: num.default(0), diskWriteBps: num.default(0), netRxBps: num.default(0), netTxBps: num.default(0),
  }),
  disks: list(z.object({ device: str(200), mount: z.string().max(1024), fs: str(64), total: num, used: num }), 64),
  interfaces: list(z.object({ name: z.string().max(64), mac: str(64), ipv4: addresses, ipv6: addresses, rxBps: num.default(0), txBps: num.default(0) }), 64),
});
export type AgentReport = z.infer<typeof reportSchema>;

/** Used and total bytes across disks, each device counted once (bind mounts and subvolumes share one). */
export function diskTotals(disks: ServerDisk[]) {
  const seen = new Map<string, ServerDisk>();
  for (const d of disks) {
    const key = d.device && d.device !== "none" ? d.device : d.mount;
    if (!seen.has(key)) seen.set(key, d);
  }
  let used = 0;
  let total = 0;
  for (const d of seen.values()) { used += d.used; total += d.total; }
  return { used, total };
}

function hostOf(r: AgentReport): ServerHost {
  return {
    hostname: r.hostname, os: r.host.os, platform: r.host.platform, kernel: r.host.kernel, arch: r.host.arch, cpuModel: r.host.cpuModel,
    cores: r.host.cores, memTotal: Math.round(r.host.memTotal), swapTotal: Math.round(r.host.swapTotal),
    bootTime: r.host.bootTime ? new Date(r.host.bootTime * 1000) : null, agentVersion: r.version,
  };
}

const bearer = (c: Context<AppEnv>) => c.req.header("authorization")?.match(/^Bearer\s+(oua_[A-Za-z0-9]{16,64})\s*$/)?.[1] ?? null;

/** Public ingest for the server agent: authenticated by the project's install key, which can do nothing else. */
export const agent = new Hono<AppEnv>()
  .post("/report", bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    const key = bearer(c);
    if (!key) return c.json({ error: "Missing agent key" }, 401);
    const repo = c.get("repo");
    const owner = await repo.serverAgentKeyOwner(key);
    if (!owner) return c.json({ error: "Unknown agent key", code: "invalid_key" }, 401);
    const parsed = reportSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid report", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
    const r = parsed.data;
    const host = hostOf(r);
    let s = await repo.serverByMachine(owner.projectId, r.machineId);
    if (!s) {
      const entitlements = c.get("entitlements");
      if (!(await allow(repo, `server-register:${owner.projectId}`, REGISTRATIONS_PER_HOUR, 3600))) return c.json({ error: "Too many new servers, try again later" }, 429);
      const plan = await entitlements.plan(owner.orgId);
      if (plan?.maxActiveMonitors != null && (await repo.activeMonitorCount(owner.orgId)) + 1 > plan.maxActiveMonitors) {
        return c.json({ error: `The ${plan.name} plan allows ${plan.maxActiveMonitors} active monitors`, code: "monitor_limit" }, 402);
      }
      const name = (r.hostname || r.machineId).slice(0, 120);
      const intervalSec = Math.max(DEFAULT_SERVER_INTERVAL_SEC, minServerInterval(plan));
      const monitor = await newServerMonitor(repo, owner.orgId, owner.projectId, name, intervalSec);
      const made = await repo.createServer(owner.orgId, owner.projectId, { machineId: r.machineId, name, intervalSec, monitorId: monitor.id, host });
      // another report of the same machine registered it first: drop the spare monitor
      if (!made.created) await repo.deleteMonitor(owner.orgId, monitor.id, null);
      s = made.server;
    } else if (s.lastSeenAt && Date.now() - s.lastSeenAt.getTime() < (s.intervalSec * 1000) / 2) {
      // too soon after the last report (two agents with one machine id, or a restart loop): acknowledged, not stored
      return c.json({ ok: true, interval: s.intervalSec, skipped: true });
    }
    const snapshot: ServerSnapshot = {
      at: new Date().toISOString(),
      platformVersion: r.host.platformVersion || undefined,
      uptimeSec: r.host.uptimeSec,
      metrics: r.metrics,
      disks: r.disks,
      interfaces: r.interfaces,
    };
    const totals = diskTotals(r.disks);
    await repo.recordServerReport(s.id, host, snapshot, Math.round(totals.used), Math.round(totals.total));
    if (s.monitorId) {
      const m = await repo.getMonitor(owner.orgId, s.monitorId, null);
      if (m) await acceptHeartbeat(repo, m, c.get("entitlements"));
    }
    return c.json({ ok: true, interval: s.intervalSec });
  });

const RANGES = { "1h": { sec: 3600, step: 60 }, "6h": { sec: 6 * 3600, step: 300 }, "24h": { sec: 86400, step: 900 }, "7d": { sec: 7 * 86400, step: 3600 } } as const;

const view = (s: Server) => ({
  id: s.id, name: s.name, tags: s.tags, machineId: s.machineId, hostname: s.hostname, os: s.os, platform: s.platform, kernel: s.kernel, arch: s.arch, cpuModel: s.cpuModel,
  cores: s.cores, memTotal: s.memTotal, swapTotal: s.swapTotal, bootTime: s.bootTime, agentVersion: s.agentVersion, intervalSec: s.intervalSec,
  lastSeenAt: s.lastSeenAt, createdAt: s.createdAt, monitorId: s.monitorId, snapshot: s.snapshot, online: serverOnline(s),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  tags: z.array(z.string().trim().min(1).max(32)).max(20),
  intervalSec: z.number().int().refine((v) => (SERVER_INTERVALS as readonly number[]).includes(v), `Use one of ${SERVER_INTERVALS.join(", ")} seconds`),
}).partial();

async function keepMonitorInStep(repo: Repo, orgId: string, s: Server, patch: { name?: string; intervalSec?: number }) {
  if (!s.monitorId) return;
  const m = await repo.getMonitor(orgId, s.monitorId, null);
  if (!m) return;
  const timing = patch.intervalSec !== undefined && patch.intervalSec !== m.intervalSec ? serverMonitorTiming(patch.intervalSec) : null;
  if (!timing && patch.name === undefined) return;
  await repo.updateMonitor(orgId, m.id, null, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(timing ? { ...timing, nextCheckAt: serverDeadline(m.nextCheckAt, timing) } : {}),
  });
}

/**
 * When a server's monitor next counts as missed after its interval changes. The agent learns the new interval only at
 * its next report, which still follows the old one, so a shorter interval keeps the deadline already set.
 */
export function serverDeadline(current: Date | null, timing: { intervalSec: number; graceSec: number }, now = Date.now()) {
  const fresh = nextAfter({ ...timing, type: "heartbeat" }, now);
  return current && current > fresh ? current : fresh;
}

/** Servers of the active project, for the dashboard. */
export const servers = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    if (c.get("allProjects")) throw new HTTPException(400, { message: "Choose a project" });
    await next();
  })
  .get("/", async (c) => {
    const repo = c.get("repo");
    const list = await repo.listServers(c.get("orgId"), c.get("projectId"));
    const cpu = await repo.serverCpuSeries(list.map((s) => s.id), 60);
    const plan = await c.get("entitlements").plan(c.get("orgId"));
    return c.json({ servers: list.map((s) => ({ ...view(s), cpuSeries: cpu[s.id] ?? [] })), minIntervalSec: minServerInterval(plan), intervals: SERVER_INTERVALS, upgradeUrl: plan?.upgradeUrl ?? null });
  })
  // the key lets anyone report as any server of the project, so only those who may delete servers see it
  .get("/agent-key", requireManager, async (c) => c.json({ key: await c.get("repo").serverAgentKey(c.get("orgId"), c.get("projectId")) }))
  .post("/agent-key/rotate", requireManager, async (c) => {
    const key = `oua_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    return c.json({ key: await c.get("repo").rotateServerAgentKey(c.get("orgId"), c.get("projectId"), key) });
  })
  .get("/:id", uuidParams, async (c) => {
    const repo = c.get("repo");
    const s = await repo.server(c.get("orgId"), c.get("projectId"), c.req.param("id"));
    if (!s) return c.json({ error: "Not found" }, 404);
    const range = RANGES[(c.req.query("range") ?? "1h") as keyof typeof RANGES] ?? RANGES["1h"];
    // never finer than the server reports, or most buckets would be empty
    const step = Math.max(range.step, s.intervalSec);
    const points = await repo.serverMetrics(s.id, new Date(Date.now() - range.sec * 1000), step);
    const monitor = s.monitorId ? await repo.getMonitor(c.get("orgId"), s.monitorId, null) : null;
    const plan = await c.get("entitlements").plan(c.get("orgId"));
    return c.json({ ...view(s), points, stepSec: step, monitorStatus: monitor?.status ?? null, minIntervalSec: minServerInterval(plan), intervals: SERVER_INTERVALS, upgradeUrl: plan?.upgradeUrl ?? null });
  })
  .patch("/:id", uuidParams, zValidator("json", patchSchema), async (c) => {
    const repo = c.get("repo");
    const orgId = c.get("orgId");
    const patch = c.req.valid("json");
    const current = await repo.server(orgId, c.get("projectId"), c.req.param("id"));
    if (!current) return c.json({ error: "Not found" }, 404);
    if (patch.intervalSec !== undefined && patch.intervalSec !== current.intervalSec) {
      const plan = await c.get("entitlements").plan(orgId);
      const min = minServerInterval(plan);
      if (patch.intervalSec < min) {
        return c.json({ error: `The ${plan?.name ?? "current"} plan reports at most every ${min} s`, code: "interval_not_allowed", minIntervalSec: min, plan: plan?.id, upgradeUrl: plan?.upgradeUrl }, 402);
      }
    }
    const row = await repo.updateServer(orgId, c.get("projectId"), current.id, patch);
    if (!row) return c.json({ error: "Not found" }, 404);
    await keepMonitorInStep(repo, orgId, current, patch);
    return c.json(view(row));
  })
  .delete("/:id", uuidParams, requireManager, async (c) => {
    const repo = c.get("repo");
    const orgId = c.get("orgId");
    const s = await repo.server(orgId, c.get("projectId"), c.req.param("id"));
    if (!s) return c.json({ error: "Not found" }, 404);
    // the monitor goes first: should the second step fail, the server stays listed instead of leaving an orphan monitor
    if (s.monitorId) await repo.deleteMonitor(orgId, s.monitorId, null);
    await repo.deleteServer(orgId, c.get("projectId"), s.id);
    return c.body(null, 204);
  });
