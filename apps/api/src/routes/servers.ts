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

/** The 402 an agent gets when the workspace has no room for this server under its plan. */
const serverLimit = (c: Context<AppEnv>, plan: Plan & { maxServers: number }) =>
  c.json({ error: `The ${plan.name} plan allows ${plan.maxServers} servers`, code: "server_limit", limit: plan.maxServers, plan: plan.id, upgradeUrl: plan.upgradeUrl ?? null }, 402);

/** A server counts as offline once three reports in a row are missing. */
export const serverOnline = (s: Pick<Server, "lastSeenAt" | "intervalSec">, now = Date.now()) =>
  !!s.lastSeenAt && now - s.lastSeenAt.getTime() < s.intervalSec * 3 * 1000;

/** New machines one project may register per hour; a leaked key cannot flood the dashboard. */
const REGISTRATIONS_PER_HOUR = 30;

// totals of several disks still fit a bigint column
const num = z.number().finite().min(0).max(1e15);
// byte counts go into bigint columns
const bytes = num.transform(Math.round);
// an odd host (a long mount path, hundreds of interfaces) is cut down to size rather than refused, so it keeps reporting
const cut = (max: number) => z.string().transform((s) => s.slice(0, max));
const str = (max: number) => cut(max).default("");
// a list the agent found empty may arrive as null
const list = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z.preprocess((v) => v ?? undefined, z.array(item).default([]).transform((a) => a.slice(0, max)));
const addresses = list(cut(64), 32);
// control characters never belong in a name or tag
const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
/** The name the install command gave, cut to size; anything odd is dropped rather than refusing the report. */
const startName = z.unknown().optional().transform((v) => (typeof v === "string" ? clean(v, 120) : ""));
/** The tags the install command gave: at most 20, each cut to 32 characters, blanks and repeats dropped. */
const startTags = z.unknown().optional().transform((v) =>
  Array.isArray(v) ? [...new Set(v.filter((t): t is string => typeof t === "string").map((t) => clean(t, 32)).filter(Boolean))].slice(0, 20) : []);
export const reportSchema = z.object({
  version: str(32),
  machineId: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  hostname: z.string().trim().max(253).default(""),
  // set by the install command; used only when the machine registers, since the dashboard owns them afterwards
  name: startName,
  tags: startTags,
  host: z.object({
    os: str(64), platform: str(64), platformVersion: str(64), kernel: str(128), arch: str(32), cpuModel: str(200),
    cores: z.number().int().min(0).max(4096).default(0), memTotal: bytes.default(0), swapTotal: bytes.default(0),
    bootTime: z.number().int().min(0).max(4102444800).optional(), uptimeSec: num.optional(),
  }).default({} as never),
  metrics: z.object({
    cpu: z.number().finite().min(0).max(100), memUsed: bytes, memCached: bytes.default(0), swapUsed: bytes.default(0),
    load1: num.default(0), load5: num.default(0), load15: num.default(0),
    diskReadBps: num.default(0), diskWriteBps: num.default(0), netRxBps: num.default(0), netTxBps: num.default(0),
  }),
  disks: list(z.object({ device: str(200), mount: cut(1024), fs: str(64), total: bytes, used: bytes }), 64),
  interfaces: list(z.object({ name: cut(64), mac: str(64), ipv4: addresses, ipv6: addresses, rxBps: num.default(0), txBps: num.default(0) }), 64),
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
    const entitlements = c.get("entitlements");
    if (!s) {
      if (!(await allow(repo, `server-register:${owner.projectId}`, REGISTRATIONS_PER_HOUR, 3600))) return c.json({ error: "Too many new servers, try again later" }, 429);
      const plan = await entitlements.plan(owner.orgId);
      const cap = plan?.maxServers ?? null;
      if (plan && cap !== null && (await repo.serverCount(owner.orgId)) >= cap) return serverLimit(c, { ...plan, maxServers: cap });
      const name = (r.name || r.hostname || r.machineId).slice(0, 120);
      const intervalSec = Math.max(DEFAULT_SERVER_INTERVAL_SEC, minServerInterval(plan));
      const monitor = await newServerMonitor(repo, owner.orgId, owner.projectId, name, intervalSec);
      const made = await repo.createServer(owner.orgId, owner.projectId, { machineId: r.machineId, name, tags: r.tags, intervalSec, monitorId: monitor.id, host });
      // another report of the same machine registered it first: drop the spare monitor
      if (!made.created) await repo.deleteMonitor(owner.orgId, monitor.id, null);
      // two new machines that passed the count at once: the later one gives its place back
      else if (plan && cap !== null && (await repo.serverRank(owner.orgId, made.server.id)) >= cap) {
        await repo.deleteServer(owner.orgId, owner.projectId, made.server.id);
        await repo.deleteMonitor(owner.orgId, monitor.id, null);
        return serverLimit(c, { ...plan, maxServers: cap });
      }
      s = made.server;
    } else if (s.lastSeenAt && Date.now() - s.lastSeenAt.getTime() < (s.intervalSec * 1000) / 2) {
      // too soon after the last report (two agents with one machine id, or a restart loop): acknowledged, not stored
      return c.json({ ok: true, interval: s.intervalSec, skipped: true });
    } else {
      const plan = await entitlements.plan(owner.orgId);
      // after a downgrade the oldest servers keep reporting; the rest are refused until there is room again
      if (plan?.maxServers != null && (await repo.serverRank(owner.orgId, s.id)) >= plan.maxServers) return serverLimit(c, { ...plan, maxServers: plan.maxServers });
      // an interval the plan no longer allows is raised, and the agent hears the new one in this answer
      const min = minServerInterval(plan);
      if (s.intervalSec < min) {
        await keepMonitorInStep(repo, owner.orgId, s, { intervalSec: min });
        s = (await repo.updateServer(owner.orgId, owner.projectId, s.id, { intervalSec: min })) ?? s;
      }
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

/** The install script; the dashboard's Add server dialog points at the same file. */
export const INSTALL_SCRIPT = "https://raw.githubusercontent.com/becoolme/openuptime/main/apps/agent/install.sh";

// install.sh refuses quotes, $, backticks, backslashes and control characters in a name or tags
const SHELL_SAFE = /^[^"'$`\\\u0000-\u001f\u007f]+$/;
const installSchema = z.object({
  name: z.string().trim().min(1).max(120).regex(SHELL_SAFE, "No quotes, $, backticks or backslashes").optional(),
  tags: z.array(z.string().trim().min(1).max(32).regex(SHELL_SAFE, "No quotes, $, backticks or backslashes").refine((t) => !t.includes(","), "No commas")).max(20).optional(),
});

const shellWord = (v: string) => (/^[A-Za-z0-9._,:@%+=/-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);

/** The command that installs the agent; `--allow-http` is added for a plain http endpoint on another machine. */
export function installCommand(o: { key: string; endpoint: string; name?: string; tags?: string[] }) {
  const args = ["--key", o.key, "--endpoint", shellWord(o.endpoint)];
  if (o.name) args.push("--name", shellWord(o.name));
  const tags = [...new Set(o.tags ?? [])];
  if (tags.length) args.push("--tags", shellWord(tags.join(",")));
  if (/^http:\/\//.test(o.endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(o.endpoint)) args.push("--allow-http");
  return `curl -fsSL ${INSTALL_SCRIPT} | sudo sh -s -- ${args.join(" ")}`;
}

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
    const maxServers = plan?.maxServers ?? null;
    return c.json({
      servers: list.map((s) => ({ ...view(s), cpuSeries: cpu[s.id] ?? [] })), minIntervalSec: minServerInterval(plan), intervals: SERVER_INTERVALS, upgradeUrl: plan?.upgradeUrl ?? null,
      // the cap counts every project of the workspace
      maxServers, serverCount: maxServers === null ? null : await repo.serverCount(c.get("orgId")),
    });
  })
  // the key lets anyone report as any server of the project, so only those who may delete servers see it
  .get("/agent-key", requireManager, async (c) => c.json({ key: await c.get("repo").serverAgentKey(c.get("orgId"), c.get("projectId")) }))
  .post("/agent-key/rotate", requireManager, async (c) => {
    const key = `oua_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    return c.json({ key: await c.get("repo").rotateServerAgentKey(c.get("orgId"), c.get("projectId"), key) });
  })
  // the same key as above, ready to paste: for agents and scripts setting servers up (POST, so OAuth clients need write scope)
  .post("/install", requireManager, async (c) => {
    const parsed = installSchema.safeParse((await c.req.json().catch(() => null)) ?? {});
    if (!parsed.success) return c.json({ error: "Invalid name or tags", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
    const key = await c.get("repo").serverAgentKey(c.get("orgId"), c.get("projectId"));
    const endpoint = (c.env.WEB_ORIGIN || new URL(c.req.url).origin).replace(/\/+$/, "");
    return c.json({
      key, endpoint, command: installCommand({ key, endpoint, ...parsed.data }),
      uninstallCommand: `curl -fsSL ${INSTALL_SCRIPT} | sudo sh -s -- --uninstall`, script: INSTALL_SCRIPT,
      note: "Run the command as root on a Linux server with systemd. Name and tags apply when the server first reports; after that, rename or retag the server in OpenUptime, not by reinstalling.",
    });
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
