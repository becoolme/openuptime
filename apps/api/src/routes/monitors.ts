import { zValidator } from "@hono/zod-validator";
import type { Repo } from "@openuptime/repo";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { isManager, requireManager, uuidParams } from "../middleware";
import { creditCost } from "../entitlements";
import { targetProblem } from "../netguard";
import { MASK, maskHeaders, restoreHeaders } from "../secrets";
import { checkOne, nextAfter } from "../scheduler";
import { isRegionConfigured, runInRegion } from "../probes";
import { AUTO, PROBE_TYPES, REGION_ID } from "../regions";

const fields = {
  name: z.string().min(1).max(120),
  type: z.enum(["http", "tcp", "dns", "heartbeat", "postgres", "mysql", "redis"]),
  target: z.string().max(2048),
  method: z.enum(["GET", "HEAD", "POST"]),
  expectedStatus: z.number().int().min(100).max(599),
  intervalSec: z.number().int().min(60).max(86400),
  timeoutMs: z.number().int().min(1000).max(30000),
  failureThreshold: z.number().int().min(1).max(10),
  // no count limit of its own: a region must be configured on the deployment, and only a plan can cap how many one monitor uses
  regions: z.array(z.string().regex(REGION_ID)).min(1).transform((r) => [...new Set(r)]),
  keyword: z.string().max(500).nullable(),
  keywordMode: z.enum(["contains", "absent"]),
  headers: z.record(z.string().max(100), z.string().max(2000)),
  graceSec: z.number().int().min(0).max(86400),
  channelIds: z.array(z.string().uuid()).max(50),
  tags: z.array(z.string().trim().min(1).max(32)).max(20),
  slowThresholdMs: z.number().int().min(100).max(60000),
  slowAlertAfter: z.number().int().min(0).max(20),
  // another monitor of the same project; while it is down this one opens no incidents and sends no alerts
  dependsOnMonitorId: z.string().uuid().nullable(),
  // several regions: how many must fail before the monitor goes down; 0 = a majority of the regions that answered
  minRegionsFailing: z.number().int().min(0).max(20),
};

/** Create: omitted fields take defaults. */
const body = z.object({
  ...fields,
  type: fields.type.default("http"),
  target: fields.target.default(""),
  method: fields.method.default("GET"),
  expectedStatus: fields.expectedStatus.default(200),
  intervalSec: fields.intervalSec.default(60),
  timeoutMs: fields.timeoutMs.default(10000),
  failureThreshold: fields.failureThreshold.default(3),
  regions: fields.regions.default(["auto"]),
  keyword: fields.keyword.default(null),
  keywordMode: fields.keywordMode.default("contains"),
  headers: fields.headers.default({}),
  graceSec: fields.graceSec.default(0),
  channelIds: fields.channelIds.default([]),
  tags: fields.tags.default([]),
  slowThresholdMs: fields.slowThresholdMs.default(1500),
  slowAlertAfter: fields.slowAlertAfter.default(0),
  dependsOnMonitorId: fields.dependsOnMonitorId.default(null),
  minRegionsFailing: fields.minRegionsFailing.default(0),
});

const IMPORT_MAX = 500;
const FIELD_KEYS = Object.keys(fields);

/** Accepts our own export plus the common spellings of other tools (UptimeRobot, Uptime Kuma, UptimeFlare style). */
function normaliseImport(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = { ...(raw as Record<string, unknown>) };
  r.name ??= r.friendly_name ?? r.friendlyName ?? r.id;
  r.target ??= r.url ?? r.hostname ?? r.host;
  if (r.target != null && r.port && typeof r.target === "string" && !r.target.includes(":") && r.type === "port") r.target = `${r.target}:${r.port}`;
  r.intervalSec ??= typeof r.interval === "number" ? Math.max(60, r.interval) : undefined;
  if (Array.isArray(r.regions) && r.regions.length === 0) delete r.regions;
  r.keyword ??= r.keyword_value ?? r.expectedKeyword ?? undefined;
  const t = typeof r.type === "string" ? r.type.toLowerCase() : undefined;
  if (t) r.type = ({ https: "http", keyword: "http", port: "tcp", "tcp-port": "tcp", mysql: "mysql", postgres: "postgres", postgresql: "postgres" } as Record<string, string>)[t] ?? t;
  const o: Record<string, unknown> = {};
  for (const k of FIELD_KEYS) if (r[k] !== undefined && r[k] !== null) o[k] = r[k];
  if (r.keyword === null) o.keyword = null;
  // a new monitor never carries over ids, so a bad channel or dependency reference cannot slip in
  delete o.channelIds;
  delete o.dependsOnMonitorId;
  // an export taken by a non-manager carries placeholders instead of header values: they are not real values
  if (o.headers && typeof o.headers === "object" && !Array.isArray(o.headers)) {
    o.headers = Object.fromEntries(Object.entries(o.headers as Record<string, unknown>).filter(([, v]) => v !== MASK));
  }
  return o;
}

/** Update: only named fields change (defaults here would silently reset the rest); type is immutable. */
const patchBody = z.object(fields).partial().omit({ type: true }).extend({ paused: z.boolean().optional() });

/** Exposed for the MCP tool definitions so they cannot drift from the REST validation. */
export const monitorCreateSchema = body;
export const monitorPatchSchema = patchBody;

const newMonitor = (v: z.infer<typeof body>) => ({
  ...v,
  heartbeatToken: v.type === "heartbeat" ? crypto.randomUUID().replace(/-/g, "") : null,
  // a new heartbeat monitor must not be "missed" before its first ping is even due
  ...(v.type === "heartbeat" ? { nextCheckAt: nextAfter({ ...v, type: "heartbeat" as const }) } : {}),
});

/** A new monitor also alerts the project's auto-enable channels, on top of whatever it was given. */
async function withAutoChannels(repo: Repo, orgId: string, projectId: string, channelIds: string[]) {
  const auto = await repo.autoEnabledChannelIds(orgId, projectId);
  return auto.length ? [...new Set([...channelIds, ...auto])] : channelIds;
}

/**
 * What the workspace's plan refuses (HTTP 402), or null. `add` is how many active monitors the request would add and
 * `intervalSec` the interval it asks for. Deployments without plans (self-hosted) never refuse.
 */
async function overPlan(c: Context<AppEnv>, o: { add?: number; intervalSec?: number }) {
  const orgId = c.get("orgId");
  const plan = await c.get("entitlements").plan(orgId);
  if (!plan) return null;
  if (o.intervalSec !== undefined && o.intervalSec < plan.minIntervalSec) {
    return c.json({ error: `The ${plan.name} plan checks at most every ${plan.minIntervalSec / 60} min`, code: "interval_not_allowed", minIntervalSec: plan.minIntervalSec, plan: plan.id, upgradeUrl: plan.upgradeUrl }, 402);
  }
  if (o.add && plan.maxActiveMonitors !== null) {
    const active = await c.get("repo").activeMonitorCount(orgId);
    if (active + o.add > plan.maxActiveMonitors) {
      return c.json({ error: `The ${plan.name} plan allows ${plan.maxActiveMonitors} active monitors`, code: "monitor_limit", limit: plan.maxActiveMonitors, active, plan: plan.id, upgradeUrl: plan.upgradeUrl }, 402);
    }
  }
  return null;
}

/**
 * What is wrong with asking for these regions (HTTP 400 or 402), or null. Regions are explicit opt-in: `auto` alone is the
 * default and always fine. Anything else needs a probe configured on this deployment, a type a probe can run, and room in
 * the plan.
 */
async function regionProblem(c: Context<AppEnv>, type: string, regions: string[]) {
  const wanted = [...new Set(regions)];
  if (wanted.every((r) => r === AUTO)) return null;
  if (!(PROBE_TYPES as readonly string[]).includes(type)) {
    return c.json({ error: `Regions other than auto are available for ${PROBE_TYPES.join(" and ")} monitors only`, code: "regions_not_supported" }, 400);
  }
  const unknown = wanted.filter((r) => !isRegionConfigured(r));
  if (unknown.length) return c.json({ error: `Unknown region: ${unknown.join(", ")}`, code: "unknown_region", regions: unknown }, 400);
  const plan = await c.get("entitlements").plan(c.get("orgId"));
  if (plan?.maxRegions != null && wanted.length > plan.maxRegions) {
    return c.json({ error: `The ${plan.name} plan checks from at most ${plan.maxRegions} region${plan.maxRegions === 1 ? "" : "s"} per monitor`, code: "regions_not_allowed", limit: plan.maxRegions, plan: plan.id, upgradeUrl: plan.upgradeUrl }, 402);
  }
  return null;
}

/** How far up a chain of dependencies is followed; a longer one is refused as well. */
const MAX_DEPENDENCY_DEPTH = 10;

/**
 * HTTP 400 when `parentId` cannot be the parent of monitor `selfId` (null when creating): it must be another monitor of the
 * same project, and following the chain upwards must neither lead back to the monitor nor go on for ever.
 */
async function dependencyProblem(c: Context<AppEnv>, projectId: string | null, selfId: string | null, parentId: string | null) {
  if (parentId === null) return null;
  const refuse = (error: string, code: string) => c.json({ error, code }, 400);
  if (parentId === selfId) return refuse("A monitor cannot depend on itself", "dependency_self");
  const repo = c.get("repo");
  const parent = (await repo.monitorsByIds([parentId]))[0];
  if (!parent || parent.organizationId !== c.get("orgId") || parent.projectId !== projectId) {
    return refuse("The monitor it depends on must be another monitor of the same project", "dependency_not_found");
  }
  let at = parent;
  for (let depth = 0; depth < MAX_DEPENDENCY_DEPTH; depth++) {
    if (at.dependsOnMonitorId === null) return null;
    if (at.dependsOnMonitorId === selfId) return refuse("That would make the monitors depend on each other", "dependency_cycle");
    const next = (await repo.monitorsByIds([at.dependsOnMonitorId]))[0];
    if (!next) return null;
    at = next;
  }
  return refuse("Dependencies are nested too deeply", "dependency_cycle");
}

/** HTTP 400 for a target that points at a private address (unless the deployment allows those), or null. */
async function refuseTarget(c: Context<AppEnv>, type: string, target: string) {
  const error = await targetProblem(type, target);
  return error ? c.json({ error, code: "target_not_allowed" }, 400) : null;
}

/** Request header values (often tokens) are shown to owners and admins only. */
const shown = async <T extends { headers?: Record<string, string> | null }>(c: Context<AppEnv>, rows: T[]): Promise<T[]> =>
  (await isManager(c)) ? rows : rows.map((m) => (m.headers && Object.keys(m.headers).length ? { ...m, headers: maskHeaders(m.headers) } : m));

export const monitors = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await shown(c, await c.get("repo").listMonitors(c.get("orgId"), c.get("projectId")))))
  .post("/", zValidator("json", body), async (c) => {
    const repo = c.get("repo");
    const v = c.req.valid("json");
    const blocked = await refuseTarget(c, v.type, v.target);
    if (blocked) return blocked;
    const badRegion = await regionProblem(c, v.type, v.regions);
    if (badRegion) return badRegion;
    const badParent = await dependencyProblem(c, c.get("projectId"), null, v.dependsOnMonitorId);
    if (badParent) return badParent;
    const refused = await overPlan(c, { add: 1, intervalSec: v.type === "heartbeat" ? undefined : v.intervalSec });
    if (refused) return refused;
    const channelIds = await withAutoChannels(repo, c.get("orgId"), c.get("projectId"), v.channelIds);
    return c.json((await shown(c, [await repo.createMonitor(c.get("orgId"), c.get("projectId"), newMonitor({ ...v, channelIds }))]))[0], 201);
  })
  // JSON backup of this project's monitors; feed it back to POST /import (here or in another workspace)
  .get("/export", async (c) => {
    const rows = await c.get("repo").exportMonitors(c.get("orgId"), c.get("projectId"));
    const monitors = (await shown(c, rows)).map((m) => Object.fromEntries(FIELD_KEYS.filter((k) => k !== "channelIds" && k !== "dependsOnMonitorId").map((k) => [k, (m as unknown as Record<string, unknown>)[k]])));
    c.header("content-disposition", 'attachment; filename="openuptime-monitors.json"');
    return c.json({ version: 1, exportedAt: new Date().toISOString(), monitors });
  })
  .post("/import", async (c) => {
    const raw = (await c.req.json().catch(() => null)) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { monitors?: unknown } | null)?.monitors;
    if (!Array.isArray(list)) return c.json({ error: "Expected a JSON array of monitors, or an object with a `monitors` array" }, 400);
    if (list.length === 0 || list.length > IMPORT_MAX) return c.json({ error: `Import between 1 and ${IMPORT_MAX} monitors at a time` }, 400);
    const valid: z.infer<typeof body>[] = [];
    const skipped: { index: number; name: string | null; error: string }[] = [];
    for (const [index, item] of list.entries()) {
      const p = body.safeParse(normaliseImport(item));
      const name = typeof (item as { name?: unknown })?.name === "string" ? (item as { name: string }).name : null;
      if (!p.success) { skipped.push({ index, name, error: p.error.issues.map((i) => `${i.path.join(".") || "item"}: ${i.message}`).join("; ") }); continue; }
      if (p.data.type !== "heartbeat" && !p.data.target.trim()) { skipped.push({ index, name: p.data.name, error: "target: required" }); continue; }
      const problem = await targetProblem(p.data.type, p.data.target);
      if (problem) { skipped.push({ index, name: p.data.name, error: `target: ${problem}` }); continue; }
      valid.push(p.data);
    }
    if (valid.length) {
      // regions that do not exist here (a file from another deployment) or that the plan has no room for fall back
      // rather than failing the whole file; a monitor left with none runs on auto
      const room = (await c.get("entitlements").plan(c.get("orgId")))?.maxRegions ?? Infinity;
      for (const v of valid) {
        const usable = (PROBE_TYPES as readonly string[]).includes(v.type) ? [...new Set(v.regions)].filter(isRegionConfigured).slice(0, room) : [];
        v.regions = usable.length ? usable : [AUTO];
      }
      // an interval below the plan's floor is raised to it rather than failing the whole file
      const floor = (await c.get("entitlements").plan(c.get("orgId")))?.minIntervalSec ?? 0;
      for (const v of valid) if (v.type !== "heartbeat" && v.intervalSec < floor) v.intervalSec = floor;
      const refused = await overPlan(c, { add: valid.length });
      if (refused) return refused;
      const repo = c.get("repo");
      const auto = await repo.autoEnabledChannelIds(c.get("orgId"), c.get("projectId"));
      await repo.createMonitors(c.get("orgId"), c.get("projectId"), valid.map((v) => newMonitor({ ...v, channelIds: auto })));
    }
    return c.json({ created: valid.length, skipped }, valid.length ? 201 : 400);
  })
  .get("/:id", uuidParams, async (c) => {
    const repo = c.get("repo");
    const m = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!m) return c.json({ error: "Not found" }, 404);
    return c.json({ ...(await shown(c, [m]))[0], ...(await repo.monitorDetail(m.id)) });
  })
  .patch("/:id", uuidParams, zValidator("json", patchBody), async (c) => {
    const repo = c.get("repo");
    const v = c.req.valid("json");
    if (Object.keys(v).length === 0) return c.json({ error: "No changes" }, 400);
    // a placeholder header value (what non-managers are shown) keeps the stored one
    if (v.headers) {
      const current = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!current) return c.json({ error: "Not found" }, 404);
      v.headers = restoreHeaders(v.headers, current.headers);
    }
    if (v.target !== undefined) {
      const current = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!current) return c.json({ error: "Not found" }, 404);
      const blocked = await refuseTarget(c, current.type, v.target);
      if (blocked) return blocked;
    }
    if (v.regions !== undefined) {
      const current = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!current) return c.json({ error: "Not found" }, 404);
      const badRegion = await regionProblem(c, current.type, v.regions);
      if (badRegion) return badRegion;
    }
    if (v.dependsOnMonitorId !== undefined) {
      const current = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!current) return c.json({ error: "Not found" }, 404);
      const badParent = await dependencyProblem(c, current.projectId, current.id, v.dependsOnMonitorId);
      if (badParent) return badParent;
    }
    if (v.intervalSec !== undefined || v.paused === false) {
      const current = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (current) {
        // only a faster interval is checked against the plan's floor; leaving an older, faster one in place is fine
        const faster = v.intervalSec !== undefined && v.intervalSec < current.intervalSec && current.type !== "heartbeat";
        const resuming = v.paused === false && current.status === "paused";
        const refused = await overPlan(c, { add: resuming ? 1 : 0, intervalSec: faster ? v.intervalSec : undefined });
        if (refused) return refused;
      }
    }
    const row = await repo.updateMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"), {
      ...v,
      ...(v.paused !== undefined ? { status: v.paused ? "paused" : "pending", nextCheckAt: new Date() } : {}),
    });
    if (!row) return c.json({ error: "Not found" }, 404);
    // a heartbeat's deadline depends on interval + grace, so re-derive it when either changes
    if (row.type === "heartbeat" && (v.intervalSec !== undefined || v.graceSec !== undefined) && v.paused === undefined) {
      const again = await repo.updateMonitor(c.get("orgId"), row.id, c.get("projectScope"), { nextCheckAt: nextAfter(row) });
      return c.json(again ? (await shown(c, [again]))[0] : again);
    }
    return c.json((await shown(c, [row]))[0]);
  })
  .delete("/:id", uuidParams, requireManager, async (c) => {
    await c.get("repo").deleteMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    return c.body(null, 204);
  })
  // Runs the monitor's check now. With `region` it is one request from that region instead: the answer is returned and
  // nothing is recorded, so a spot check from elsewhere cannot flip the monitor's state.
  .post("/:id/check", uuidParams, async (c) => {
    const repo = c.get("repo");
    const asked = z.object({ region: z.string().regex(REGION_ID).optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!asked.success) return c.json({ error: "region must be a region id", code: "unknown_region" }, 400);
    const region = asked.data.region;
    const m = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!m) return c.json({ error: "Not found" }, 404);
    if (region !== undefined) {
      if (!(PROBE_TYPES as readonly string[]).includes(m.type) && region !== AUTO) {
        return c.json({ error: `Regions other than auto are available for ${PROBE_TYPES.join(" and ")} monitors only`, code: "regions_not_supported" }, 400);
      }
      if (!isRegionConfigured(region)) return c.json({ error: `Unknown region: ${region}`, code: "unknown_region", regions: [region] }, 400);
    }
    const cost = region !== undefined ? (m.type === "heartbeat" ? 0 : 1) : creditCost(m);
    // a manual check is a request like any other: it takes a credit
    if ((await c.get("entitlements").spendCredits(m.organizationId, cost)) < cost) {
      return c.json({ error: "No credits left this period", code: "credits_exhausted" }, 402);
    }
    if (region === undefined) {
      await checkOne(repo, m, c.get("entitlements"));
      return c.json({ ok: true });
    }
    if (m.type === "heartbeat") return c.json({ error: "Heartbeat monitors have no check to run", code: "regions_not_supported" }, 400);
    const run = await runInRegion(region, m);
    if ("unreachable" in run) return c.json({ error: run.unreachable, code: "probe_unreachable", region }, 502);
    return c.json({ ok: true, region, result: run.outcome });
  });
