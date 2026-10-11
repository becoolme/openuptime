import { zValidator } from "@hono/zod-validator";
import type { Repo } from "@openuptime/repo";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireManager } from "../middleware";
import { creditCost } from "../entitlements";
import { checkOne, nextAfter } from "../scheduler";

const fields = {
  name: z.string().min(1).max(120),
  type: z.enum(["http", "tcp", "dns", "heartbeat", "postgres", "mysql", "redis"]),
  target: z.string().max(2048),
  method: z.enum(["GET", "HEAD", "POST"]),
  expectedStatus: z.number().int().min(100).max(599),
  intervalSec: z.number().int().min(60).max(86400),
  timeoutMs: z.number().int().min(1000).max(30000),
  failureThreshold: z.number().int().min(1).max(10),
  regions: z.array(z.string()),
  keyword: z.string().max(500).nullable(),
  keywordMode: z.enum(["contains", "absent"]),
  headers: z.record(z.string().max(100), z.string().max(2000)),
  graceSec: z.number().int().min(0).max(86400),
  channelIds: z.array(z.string().uuid()).max(50),
  tags: z.array(z.string().trim().min(1).max(32)).max(20),
  slowThresholdMs: z.number().int().min(100).max(60000),
  slowAlertAfter: z.number().int().min(0).max(20),
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
  r.keyword ??= r.keyword_value ?? r.expectedKeyword ?? undefined;
  const t = typeof r.type === "string" ? r.type.toLowerCase() : undefined;
  if (t) r.type = ({ https: "http", keyword: "http", port: "tcp", "tcp-port": "tcp", mysql: "mysql", postgres: "postgres", postgresql: "postgres" } as Record<string, string>)[t] ?? t;
  const o: Record<string, unknown> = {};
  for (const k of FIELD_KEYS) if (r[k] !== undefined && r[k] !== null) o[k] = r[k];
  if (r.keyword === null) o.keyword = null;
  // a new monitor never carries over ids, so a bad channel reference cannot slip in
  delete o.channelIds;
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

export const monitors = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await c.get("repo").listMonitors(c.get("orgId"), c.get("projectId"))))
  .post("/", zValidator("json", body), async (c) => {
    const repo = c.get("repo");
    const v = c.req.valid("json");
    const channelIds = await withAutoChannels(repo, c.get("orgId"), c.get("projectId"), v.channelIds);
    return c.json(await repo.createMonitor(c.get("orgId"), c.get("projectId"), newMonitor({ ...v, channelIds })), 201);
  })
  // JSON backup of this project's monitors; feed it back to POST /import (here or in another workspace)
  .get("/export", async (c) => {
    const rows = await c.get("repo").exportMonitors(c.get("orgId"), c.get("projectId"));
    const monitors = rows.map((m) => Object.fromEntries(FIELD_KEYS.filter((k) => k !== "channelIds").map((k) => [k, (m as unknown as Record<string, unknown>)[k]])));
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
    list.forEach((item, index) => {
      const p = body.safeParse(normaliseImport(item));
      const name = typeof (item as { name?: unknown })?.name === "string" ? (item as { name: string }).name : null;
      if (!p.success) return skipped.push({ index, name, error: p.error.issues.map((i) => `${i.path.join(".") || "item"}: ${i.message}`).join("; ") });
      if (p.data.type !== "heartbeat" && !p.data.target.trim()) return skipped.push({ index, name: p.data.name, error: "target: required" });
      valid.push(p.data);
    });
    if (valid.length) {
      const repo = c.get("repo");
      const auto = await repo.autoEnabledChannelIds(c.get("orgId"), c.get("projectId"));
      await repo.createMonitors(c.get("orgId"), c.get("projectId"), valid.map((v) => newMonitor({ ...v, channelIds: auto })));
    }
    return c.json({ created: valid.length, skipped }, valid.length ? 201 : 400);
  })
  .get("/:id", async (c) => {
    const repo = c.get("repo");
    const m = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!m) return c.json({ error: "Not found" }, 404);
    return c.json({ ...m, ...(await repo.monitorDetail(m.id)) });
  })
  .patch("/:id", zValidator("json", patchBody), async (c) => {
    const repo = c.get("repo");
    const v = c.req.valid("json");
    if (Object.keys(v).length === 0) return c.json({ error: "No changes" }, 400);
    const row = await repo.updateMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"), {
      ...v,
      ...(v.paused !== undefined ? { status: v.paused ? "paused" : "pending", nextCheckAt: new Date() } : {}),
    });
    if (!row) return c.json({ error: "Not found" }, 404);
    // a heartbeat's deadline depends on interval + grace, so re-derive it when either changes
    if (row.type === "heartbeat" && (v.intervalSec !== undefined || v.graceSec !== undefined) && v.paused === undefined) {
      return c.json(await repo.updateMonitor(c.get("orgId"), row.id, c.get("projectScope"), { nextCheckAt: nextAfter(row) }));
    }
    return c.json(row);
  })
  .delete("/:id", requireManager, async (c) => {
    await c.get("repo").deleteMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    return c.body(null, 204);
  })
  .post("/:id/check", async (c) => {
    const repo = c.get("repo");
    const m = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!m) return c.json({ error: "Not found" }, 404);
    // a manual check is a request like any other: it takes a credit
    if ((await c.get("entitlements").spendCredits(m.organizationId, creditCost(m))) < creditCost(m)) {
      return c.json({ error: "No credits left this period", code: "credits_exhausted" }, 402);
    }
    await checkOne(repo, m);
    return c.json({ ok: true });
  });
