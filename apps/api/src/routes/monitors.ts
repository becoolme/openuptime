import { zValidator } from "@hono/zod-validator";
import type { Repo, McpConfig } from "@openuptime/repo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppEnv } from "../env";
import { ALL_PROJECTS, cookieValue, isManager, listedProjects, requireManager, uuidParams } from "../middleware";
import { creditCost } from "../entitlements";
import { targetProblem } from "../netguard";
import { MASK, maskHeaders, restoreHeaders, sameJson } from "../secrets";
import { checkOne, nextAfter } from "../scheduler";
import { isRegionConfigured, runInRegion, usesOnlyPrivateProbes } from "../probes";
import { AUTO, PROBE_TYPES, REGION_ID } from "../regions";

import { HTTP_METHODS, MAX_REQUEST_BODY_BYTES, requestBodyProblem } from "../http-request";

import { mcpConfigPatchSchema, mcpConfigSchema } from "../mcp-config";
import { mcpCheck } from "../mcp-monitor";
import { prepareMcpOAuth, addOAuthTiming, mcpRefreshPreviewChanged } from "../mcp-oauth";

function rpcProblem(v: { type: string; target: string }): string | null {
  if (v.type !== "evm" && v.type !== "solana") return null;
  try {
    const url = new URL(v.target);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash) return null;
  } catch { /* invalid URL */ }
  return "Blockchain RPC requires an http(s) URL without embedded credentials or a fragment";
}

function mcpProblem(v: {type: string; target: string; mcpConfig?: McpConfig | null}): string | null {
  if (v.type !== "mcp") return v.mcpConfig ? "MCP configuration is only valid for MCP monitors" : null;
  try {
    const url = new URL(v.target);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return "MCP requires an http(s) URL without embedded credentials or a fragment; use authentication headers";
  } catch { return "MCP requires an absolute http(s) URL"; }
  return null;
}

const fields = {
  name: z.string().min(1).max(120).describe("Display name shown in the dashboard, alerts and status-page components."),
  type: z.enum(["http", "tcp", "dns", "heartbeat", "postgres", "mysql", "redis", "websocket", "domain", "mcp", "evm", "solana"]).describe("Check protocol; immutable after creation. HTTP checks a URL, WebSocket checks the handshake (and optionally a reply), heartbeat waits for incoming pings, and other types check a service."),
  target: z.string().max(2048).describe("HTTP: absolute http(s) URL. WebSocket: ws:// or wss:// URL. TCP: host:port. DNS: hostname. Domain: explicit registered domain, without scheme or path; not a subdomain. Database/Redis: connection URL for that protocol. Heartbeat: leave empty. Public targets only by default."),
  mcpConfig: mcpConfigSchema.nullable().describe("MCP: requiredTools, optional schemaCheck baseline, and toolCall. Tool calls require explicit enabled=true and may incur charges or modify data. Assertions use JSON Pointer paths into the result. Manager-only configuration."),
  domainExpiryWarnDays: z.number().int().min(1).max(365).describe("Domain registration only: fail when expiration is this many days away; unknown dates also fail explicitly."),
  method: z.enum(HTTP_METHODS).describe("HTTP request method; ignored for other monitor types."),
  requestBody: z.string().max(MAX_REQUEST_BODY_BYTES).nullable().describe("HTTP request body, up to 16384 UTF-8 bytes; unavailable with GET or HEAD. Set Content-Type using headers. Null clears it. Masked values preserve stored secrets on update; owners and admins can read bodies."),
  expectedStatus: z.number().int().min(100).max(599).describe("HTTP response status that counts as healthy; an expected 3xx is checked without following the redirect."),
  intervalSec: z.number().int().min(60).max(86400).describe("Seconds between checks, or the expected heartbeat period. Domain checks are raised to at least 3600 seconds; daily checks are recommended. Hosted plans may require a longer interval."),
  timeoutMs: z.number().int().min(1000).max(30000).describe("Maximum duration of a check in milliseconds; for domain checks, each IANA/registry request has this timeout and shared cache locks wait at most 3 seconds."),
  failureThreshold: z.number().int().min(1).max(10).describe("Consecutive failed checks required before opening an incident."),
  recoveryThreshold: z.number().int().min(1).max(10).describe("Consecutive successful runs (or heartbeat pings) required to recover from down. Default 1; a multi-region vote counts once. Does not delay latency-only recovery."),
  // no count limit of its own: a region must be configured on the deployment, and only a plan can cap how many one monitor uses
  regions: z.array(z.string().regex(REGION_ID)).min(1).transform((r) => [...new Set(r)]).describe("Region ids from list_regions. auto uses this deployment; explicit regions work for HTTP, TCP, WebSocket and MCP. A supplied list replaces the existing one."),
  keyword: z.string().max(500).nullable().describe("HTTP response-body text, or for WebSocket the first message received, to test; null disables keyword matching."),
  keywordMode: z.enum(["contains", "absent"]).describe("Whether the HTTP response body (or the WebSocket message) must contain keyword or must not contain it."),
  // an absolute http(s) URL or a path; blank means "any destination"
  expectedLocation: z.string().trim().max(2048).refine((v) => v === "" || v.startsWith("/") || /^https?:\/\/\S+$/i.test(v), "Use a full http(s) URL or a path starting with /").transform((v) => v || null).nullable().describe("For an expected HTTP redirect (3xx), require this Location URL or path; null or empty string accepts any destination."),
  headers: z.record(z.string().max(100), z.string().max(2000)).describe("HTTP (or WebSocket handshake) request headers; replaces the header map. An empty object removes all custom headers. Existing masked values preserve stored secrets."),
  // sent as one text message after the handshake; blank means "handshake only"
  wsMessage: z.string().max(2000).transform((v) => v || null).nullable().describe("WebSocket only: text message sent once the connection is open; a message must then come back within the timeout. Not a secret: put credentials in headers. Null or empty string checks the handshake only."),
  dnsRecordType: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS"]).describe("DNS record type; default A. Queries Cloudflare's public DoH resolver."),
  dnsExpectedValue: z.string().max(2000).transform((v) => v || null).nullable().describe("Optional DNS answer value. At least one answer of the selected type must match. TXT uses quoted DNS presentation; MX includes priority. Empty or null accepts any answer of that type."),
  dnsMatchMode: z.enum(["exact", "contains"]).describe("DNS answer match: exact or case-sensitive substring. Hostnames in CNAME/NS and MX exact matches ignore case and trailing dots."),
  graceSec: z.number().int().min(0).max(86400).describe("Extra seconds allowed after a heartbeat deadline before it counts as missed; used only for heartbeat monitors."),
  channelIds: z.array(z.string().uuid()).max(50).describe("Alert-channel UUIDs from list_channels. Replaces the selected channels; an empty list clears them. Newly created monitors also inherit auto-enabled channels."),
  tags: z.array(z.string().trim().min(1).max(32)).max(20).describe("Dashboard filter labels; a supplied list replaces the existing tags, and an empty list clears them."),
  slowThresholdMs: z.number().int().min(100).max(60000).describe("Latency in milliseconds above which a successful check counts as slow."),
  slowAlertAfter: z.number().int().min(0).max(20).describe("Consecutive slow checks required for a slow-response alert; zero disables these alerts."),
  // another monitor of the same project; while it is down this one opens no incidents and sends no alerts
  dependsOnMonitorId: z.string().uuid().nullable().describe("Parent monitor UUID in the same project; suppresses new incidents and alerts while the parent is down. Null removes the dependency."),
  // several regions: how many must fail before the monitor goes down; 0 = a majority of the regions that answered
  minRegionsFailing: z.number().int().min(0).max(20).describe("Failed regions needed to mark a multi-region monitor down; zero uses a majority of regions that answered."),
};

/** Create: omitted fields take defaults. */
const body = z.object({
  ...fields,
  type: fields.type.default("http"),
  target: fields.target.default(""),
  method: fields.method.default("GET"),
  requestBody: fields.requestBody.default(null),
  mcpConfig: fields.mcpConfig.default(null),
  domainExpiryWarnDays: fields.domainExpiryWarnDays.default(30),
  expectedStatus: fields.expectedStatus.default(200),
  intervalSec: fields.intervalSec.default(60),
  timeoutMs: fields.timeoutMs.default(10000),
  failureThreshold: fields.failureThreshold.default(3),
  recoveryThreshold: fields.recoveryThreshold.default(1),
  regions: fields.regions.default(["auto"]),
  keyword: fields.keyword.default(null),
  keywordMode: fields.keywordMode.default("contains"),
  expectedLocation: fields.expectedLocation.default(null),
  headers: fields.headers.default({}),
  wsMessage: fields.wsMessage.default(null),
  dnsRecordType: fields.dnsRecordType.default("A"),
  dnsExpectedValue: fields.dnsExpectedValue.default(null),
  dnsMatchMode: fields.dnsMatchMode.default("exact"),
  graceSec: fields.graceSec.default(0),
  channelIds: fields.channelIds.default([]),
  tags: fields.tags.default([]),
  slowThresholdMs: fields.slowThresholdMs.default(1500),
  slowAlertAfter: fields.slowAlertAfter.default(0),
  dependsOnMonitorId: fields.dependsOnMonitorId.default(null),
  minRegionsFailing: fields.minRegionsFailing.default(0),
});

const IMPORT_MAX = 500;
const sourceSchema = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9._:-]+$/);
export const monitorImportSchema = z.object({
  source: sourceSchema.optional().describe("Stable source namespace, such as uptime-kuma:production. Reuse it on retries; defaults to json. Per-row source takes precedence."),
  destination: z.object({ organizationId: z.string(), projectId: z.string().uuid() }).optional().describe("Optional on preview. For import_monitors, pass the destination returned by the preview: the import is then refused if the active workspace or project changed. Without it the monitors go to the active project."),
  monitors: z.array(z.record(z.string(), z.unknown())).min(1).max(IMPORT_MAX).describe("Monitor records. Give each a stable sourceId (or id). Source IDs ignore surrounding whitespace. Missing ids use a hash of type, name and target. Repeated identities are skipped, never overwritten."),
});
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
  if (t) r.type = ({ https: "http", keyword: "http", port: "tcp", "tcp-port": "tcp", mysql: "mysql", postgres: "postgres", postgresql: "postgres", "websocket-upgrade": "websocket", ws: "websocket" } as Record<string, string>)[t] ?? t;
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
const patchBody = z.object(fields).partial().omit({ type: true }).extend({
  mcpConfig: mcpConfigPatchSchema.nullable().optional().describe(`${fields.mcpConfig.description} Omit oauth to keep the stored credentials; with oauth.mode refresh_token, omit oauth.refreshToken to keep the stored (rotating) token.`),
  paused: z.boolean().optional().describe("True pauses checks and alerts; false resumes checking with pending status. Prefer pause_monitor or resume_monitor for this change alone.") });

/** Exposed for the MCP tool definitions so they cannot drift from the REST validation. */
export const monitorCreateSchema = body;
export const monitorPatchSchema = patchBody;

const DNS_DEFAULTS = { dnsRecordType: "A", dnsExpectedValue: null, dnsMatchMode: "exact" } as const;

const creationProblem = (v: z.infer<typeof body>) => v.requestBody === MASK ? "A masked request body cannot be imported or created; supply the original body" : rpcProblem(v) ?? mcpProblem(v) ?? requestBodyProblem(v);

const newMonitor = (v: z.infer<typeof body>) => ({
  ...v,
  ...(v.type !== "dns" ? DNS_DEFAULTS : {}),
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
async function refuseTarget(c: Context<AppEnv>, type: string, target: string, regions: string[] = ["auto"]) {
  if (usesOnlyPrivateProbes(type, regions)) return null;
  const error = await targetProblem(type, target);
  return error ? c.json({ error, code: "target_not_allowed" }, 400) : null;
}

/**
 * A refresh token rotates on every check, so any copy handed out is stale soon after and must never be written back.
 * It is write-only; with `clientSecret` also removed the result is safe to place in an export file.
 */
function withoutOAuthSecrets(config: McpConfig | null | undefined, o: { clientSecret?: boolean } = {}): McpConfig | null | undefined {
  if (!config?.oauth) return config;
  const { refreshToken: _refresh, clientSecret, ...oauth } = config.oauth;
  return { ...config, oauth: { ...oauth, ...(o.clientSecret || clientSecret === undefined ? {} : { clientSecret }) } };
}
/** Request headers and bodies (often tokens) are shown to owners and admins only. */
const shown = async <T extends { headers?: Record<string, string> | null; requestBody?: string | null; type?: string; mcpConfig?: McpConfig | null }>(c: Context<AppEnv>, rows: T[]): Promise<T[]> =>
  (await isManager(c)) ? rows.map((m) => m.mcpConfig?.oauth ? { ...m, mcpConfig: withoutOAuthSecrets(m.mcpConfig) } : m) : rows.map((m) => ({ ...m, ...(m.type === "mcp" ? { mcpConfig: null, mcpBaseline: null, mcpObservation: null, mcpConfigRedacted: true } : {}), ...(m.headers ? { headers: maskHeaders(m.headers) } : {}), ...(m.requestBody ? { requestBody: MASK } : {}) }));

/** Source fields that look like credentials: a record carrying one is refused rather than imported without its authentication. */
const CREDENTIAL_KEY = /auth|user|pass|secret|token|cred|bearer|oauth/i;

/** Preview and execution share normalization and validation; only execution writes monitor rows. */
async function importMonitors(c: Context<AppEnv>, preview: boolean) {
  // the project asked for by header or by the dashboard's cookie; a stale or unknown id would otherwise fall back silently to another project
  const explicitProject = c.req.header("x-project-id") ?? cookieValue(c.req.header("cookie"), "ou_project");
  if (explicitProject && explicitProject !== ALL_PROJECTS && explicitProject !== c.get("projectId")) return c.json({ error: "The selected import project is unavailable", code: "import_project_unavailable" }, 403);
  const raw: unknown = await c.req.json().catch(() => null);
  const envelope = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (!preview && envelope.destination !== undefined) {
    const expected = envelope.destination as { organizationId?: unknown; projectId?: unknown } | null;
    if (expected?.organizationId !== c.get("orgId") || expected?.projectId !== c.get("projectId")) return c.json({ error: "The import destination changed; preview again", code: "import_destination_changed" }, 409);
  }
  const list = Array.isArray(raw) ? raw : envelope.monitors;
  if (!Array.isArray(list) || list.length < 1 || list.length > IMPORT_MAX) return c.json({ error: `Import between 1 and ${IMPORT_MAX} monitors` }, 400);
  const defaultSource = sourceSchema.safeParse(envelope.source ?? "json");
  if (!defaultSource.success) return c.json({ error: "Invalid source namespace" }, 400);
  type Row = { index: number; name: string | null; source?: string; sourceId?: string; status: string; monitorId?: string | null; error?: string; warnings: string[]; type?: string; intervalSec?: number; regions?: string[] };
  const report: Row[] = [];
  const candidates: { row: Row; value: z.infer<typeof body>; source: string; sourceId: string }[] = [];
  const plan = await c.get("entitlements").plan(c.get("orgId"));
  const aliases = new Set(["source", "sourceId", "id", "friendly_name", "friendlyName", "url", "hostname", "host", "port", "interval", "keyword_value", "expectedKeyword"]);
  const lookups = new Map<string, Promise<string | null>>();
  for (const [index, item] of list.entries()) {
    const r = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const row: Row = { index, name: typeof r.name === "string" ? r.name : null, status: "skipped", warnings: [] };
    report.push(row);
    // Like masked headers: never import OAuth credentials, and never turn an OAuth monitor into an unauthenticated one.
    const importedOAuth = r.mcpConfig && typeof r.mcpConfig === "object" ? (r.mcpConfig as Record<string, unknown>).oauth : null;
    if (importedOAuth !== undefined && importedOAuth !== null) { row.error = "MCP OAuth credentials are not imported; remove mcpConfig.oauth, import, then enter the OAuth settings on the monitor"; continue; }
    const parsed = body.safeParse(normaliseImport(item));
    if (!parsed.success) { row.error = parsed.error.issues.map((i) => `${i.path.join(".") || "item"}: ${i.message}`).join("; "); continue; }
    const v = parsed.data;
    row.name = v.name;
    if (v.type === "mcp" && v.mcpConfig?.toolCall?.enabled) { row.error = "Import MCP monitors with tool calls disabled; enable them explicitly after import"; continue; }
    const invalid = creationProblem(v);
    if (v.type === "mcp" && !(await isManager(c))) return c.json({ error: "Only workspace owners and admins can configure MCP monitors" }, 403);
    if (invalid) { row.error = invalid; continue; }
    const source = sourceSchema.safeParse(r.source ?? defaultSource.data);
    if (!source.success) { row.error = "Invalid source namespace"; continue; }
    const unknown = Object.keys(r).filter((k) => !FIELD_KEYS.includes(k) && !aliases.has(k));
    if (unknown.length) row.warnings.push(`Unsupported fields: ${unknown.sort().join(", ")}`);
    // Never turn a secret placeholder or unsupported authentication into an unauthenticated monitor.
    if (r.headers && typeof r.headers === "object" && Object.values(r.headers).some((v) => v === MASK)) { row.error = "Masked headers cannot be restored; supply original credentials"; continue; }
    if (Object.keys(r).some((k) => !FIELD_KEYS.includes(k) && !aliases.has(k) && (k === "body" || CREDENTIAL_KEY.test(k)) && r[k] != null && r[k] !== "")) { row.error = "Unsupported authentication or request body; map it explicitly before importing"; continue; }
    if (Array.isArray(r.channelIds) && r.channelIds.length) row.warnings.push("Source channel references are not imported; destination auto-enabled channels apply");
    if (r.dependsOnMonitorId) row.warnings.push("Source monitor dependencies are not imported");
    if (v.type !== "heartbeat" && !v.target.trim()) { row.error = "target: required"; continue; }
    // a file often repeats a host; resolve each distinct target once (a read-only grant may run previews)
    const lookupKey = `${v.type}\0${v.target}\0${v.regions.join(",")}`;
    if (!lookups.has(lookupKey)) lookups.set(lookupKey, usesOnlyPrivateProbes(v.type, v.regions) ? Promise.resolve(null) : targetProblem(v.type, v.target));
    const problem = await lookups.get(lookupKey)!;
    if (problem) { row.error = `target: ${problem}`; continue; }
    let sourceId: string;
    const identity = r.sourceId ?? r.id;
    if (identity !== undefined) {
      if ((typeof identity !== "string" && typeof identity !== "number") || !String(identity).trim() || String(identity).trim().length > 200 || /[\u0000-\u001f]/.test(String(identity))) { row.error = "sourceId must be a nonempty string of at most 200 characters"; continue; }
      sourceId = String(identity).trim();
    } else {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([v.type, v.name, v.target])));
      sourceId = "sha256:" + [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
      row.warnings.push("No sourceId supplied; identity is derived from type, name and target. Changing them creates a new monitor");
    }
    const room = plan?.maxRegions ?? Infinity;
    const usable = (PROBE_TYPES as readonly string[]).includes(v.type) ? [...new Set(v.regions)].filter(isRegionConfigured).slice(0, room) : [];
    const regions = usable.length ? usable : [AUTO];
    if (JSON.stringify(v.regions) !== JSON.stringify(regions)) row.warnings.push("Regions adjusted to this deployment and plan");
    v.regions = regions;
    if (v.type === "domain") {
      const bounded = Math.min(86400, Math.max(v.intervalSec, 3600));
      if (bounded !== v.intervalSec) { v.intervalSec = bounded; row.warnings.push("Interval adjusted to the 1 hour to 1 day range for domain checks"); }
    }
    if (v.type !== "heartbeat" && v.intervalSec < (plan?.minIntervalSec ?? 0)) { v.intervalSec = plan!.minIntervalSec; row.warnings.push("Interval raised to the plan minimum"); }
    Object.assign(row, { source: source.data, sourceId, type: v.type, intervalSec: v.intervalSec, regions: v.regions });
    candidates.push({ row, value: v, source: source.data, sourceId });
  }
  const repo = c.get("repo");
  const auto = candidates.length ? await repo.autoEnabledChannelIds(c.get("orgId"), c.get("projectId")) : [];
  const batch = await repo.importMonitors(c.get("orgId"), c.get("projectId"), candidates.map(({ value, source, sourceId }) => ({ source, sourceId, input: newMonitor({ ...value, channelIds: auto }) })), { preview, maxActive: plan?.maxActiveMonitors ?? null });
  batch.rows.forEach((r, i) => {
    const { existing, ...rest } = r;
    Object.assign(candidates[i].row, rest);
    if (r.status !== "duplicate" || !existing) return;
    const row = candidates[i].row as Row & { existing?: unknown };
    row.existing = existing;
    const v = candidates[i].value;
    if (existing.name !== v.name || existing.target !== v.target) row.warnings.push(`Skipped: this source ID already belongs to "${existing.name}" (${existing.target || "no target"}), which differs from this record; use a different source or sourceId if both are wanted`);
  });
  const created = report.filter((r) => r.status === "created").length;
  const duplicates = report.filter((r) => r.status === "duplicate").length;
  const ready = report.filter((r) => r.status === "ready").length;
  const skipped = report.filter((r) => r.status === "skipped").map(({ index, name, error }) => ({ index, name, error }));
  const project = (await repo.listProjects(c.get("orgId"), c.get("projectScope"))).find((p) => p.id === c.get("projectId"));
  const result = { destination: { organizationId: c.get("orgId"), projectId: c.get("projectId"), projectName: project?.name ?? null }, preview, created, duplicates, ready, skipped, report, canImport: !batch.limit && candidates.length > 0, autoChannelCount: auto.length, capacity: batch.limit };
  // same fields as the single-create 402 (error text, numeric limit, active, plan); the batch detail is under `capacity`
  if (batch.limit && !preview) return c.json({ ...result, error: `The ${plan?.name} plan allows ${batch.limit.max} active monitors`, code: "monitor_limit", limit: batch.limit.max, active: batch.limit.active, plan: plan?.id, upgradeUrl: plan?.upgradeUrl }, 402);
  return c.json(result, preview || (!created && duplicates) ? 200 : created ? 201 : 400);
}

export const monitors = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await shown(c, await c.get("repo").listMonitors(c.get("orgId"), await listedProjects(c)))))
  .post("/", zValidator("json", body), async (c) => {
    const repo = c.get("repo");
    const v = c.req.valid("json");
    const invalid = creationProblem(v);
    if (invalid) return c.json({ error: invalid }, 400);
    if (v.type === "mcp" && !(await isManager(c))) return c.json({ error: "Only workspace owners and admins can configure MCP monitors" }, 403);
    if (v.type === "domain") v.intervalSec = Math.min(86400, Math.max(v.intervalSec, 3600));
    const blocked = await refuseTarget(c, v.type, v.target, v.regions);
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
  .post("/mcp/preview", requireManager, bodyLimit({ maxSize: 128 * 1024 }), zValidator("json", z.object({
    monitorId: z.string().uuid().optional(), target: fields.target, headers: fields.headers.default({}),
    timeoutMs: fields.timeoutMs.default(10000), mcpConfig: mcpConfigPatchSchema.nullable().default(null), region: z.string().regex(REGION_ID).optional(),
  })), async (c) => {
    const v = c.req.valid("json"), repo = c.get("repo");
    const invalid = mcpProblem({ type: "mcp", ...v });
    if (invalid) return c.json({ error: invalid }, 400);
    const blocked = await refuseTarget(c, "mcp", v.target, [v.region ?? AUTO]);
    if (blocked) return blocked;
    if (v.region && !isRegionConfigured(v.region)) return c.json({ error: "Unknown probe region" }, 400);
    const stored = v.monitorId ? await repo.getMonitor(c.get("orgId"), v.monitorId, c.get("projectScope")) : null;
    if (v.monitorId && (!stored || stored.type !== "mcp")) return c.json({ error: "Not found" }, 404);
    if (v.mcpConfig?.oauth?.mode === "refresh_token") {
      // The issuer may rotate the token on use; without a saved monitor the new token could not be stored and the pasted one would be burned.
      if (!stored) return c.json({ error: "Save the monitor before testing a refresh token: the authorization server may rotate it, and only a saved monitor can keep the new token", code: "mcp_refresh_requires_saved_monitor" }, 400);
      const saved = stored.mcpConfig?.oauth;
      if (!v.mcpConfig.oauth.refreshToken && saved?.mode === "refresh_token" && saved.refreshToken) v.mcpConfig.oauth.refreshToken = saved.refreshToken;
      if (!v.mcpConfig.oauth.refreshToken) return c.json({ error: "Refresh-token mode requires a refresh token" }, 400);
    }
    if (stored && mcpRefreshPreviewChanged(v, stored)) return c.json({ error: "Save endpoint and OAuth changes before previewing an existing monitor" }, 409);
    if ((await c.get("entitlements").spendCredits(c.get("orgId"), 1)) < 1) return c.json({ error: "No credits left this period", code: "credits_exhausted" }, 402);
    const input = { type: "mcp" as const, target: v.target, headers: v.headers, timeoutMs: v.timeoutMs, method: "GET", expectedStatus: 200,
      mcpConfig: { requiredTools: [], ...v.mcpConfig, schemaCheck: false, toolCall: null } };
    // Refresh token rotation is persisted only against the authorized existing monitor and never returned.
    const prepared = await prepareMcpOAuth(input, repo, stored ?? undefined);
    c.header("cache-control", "no-store");
    if ("outcome" in prepared) return c.json({ ...prepared.outcome, mcp: prepared.outcome.mcp ?? { stage: "oauth", timings: {}, tools: [], changes: [], toolsComplete: false } });
    let outcome;
    if (v.region && v.region !== AUTO) {
      const run = await runInRegion(v.region, prepared.input, repo);
      if ("unreachable" in run) return c.json({ ok: false, inconclusive: true, error: run.unreachable, mcp: { stage: "server/discover", timings: { oauth: prepared.elapsedMs }, tools: [], changes: [], toolsComplete: false } });
      outcome = run.outcome;
    } else outcome = await mcpCheck(prepared.input);
    return c.json(addOAuthTiming(outcome, prepared.elapsedMs));
  })
  // JSON backup of this project's monitors; feed it back to POST /import (here or in another workspace)
  .get("/export", async (c) => {
    const rows = await c.get("repo").exportMonitors(c.get("orgId"), c.get("projectId"));
    // OAuth secrets stay with this monitor: a copied refresh token would be shared, and burned, by two monitors.
    const monitors = (await shown(c, rows)).map((m) => (m.mcpConfig?.oauth ? { ...m, mcpConfig: withoutOAuthSecrets(m.mcpConfig, { clientSecret: true }) } : m)).map((m) => Object.fromEntries(FIELD_KEYS.filter((k) => k !== "channelIds" && k !== "dependsOnMonitorId").map((k) => [k, (m as unknown as Record<string, unknown>)[k]]).concat([["source", m.importSource ?? "openuptime"], ["sourceId", m.importSourceId ?? m.id]])));
    c.header("content-disposition", 'attachment; filename="openuptime-monitors.json"');
    return c.json({ version: 1, exportedAt: new Date().toISOString(), monitors });
  })
  .post("/import/preview", bodyLimit({ maxSize: 4 * 1024 * 1024 }), (c) => importMonitors(c, true))
  .post("/import", bodyLimit({ maxSize: 4 * 1024 * 1024 }), (c) => importMonitors(c, false))
  .get("/:id/time-coverage", uuidParams, async (c) => {
    const days = c.req.query("days") ?? "7";
    if (days !== "7" && days !== "30") return c.json({ error: "days must be 7 or 30" }, 400);
    const report = await c.get("repo").timeCoverage(c.get("orgId"), c.req.param("id"), c.get("projectScope"), days === "7" ? 7 : 30);
    if (!report) return c.json({ error: "Not found" }, 404);
    c.header("cache-control", "no-store");
    return c.json(report);
  })
  .get("/:id", uuidParams, async (c) => {
    const repo = c.get("repo");
    const m = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!m) return c.json({ error: "Not found" }, 404);
    const detail = await repo.monitorDetail(m.id);
    const result = { ...(await shown(c, [m]))[0], ...detail };
    if (m.type === "mcp" && !(await isManager(c))) result.results = detail.results.map(r => Object.fromEntries(Object.entries(r).filter(([key]) => key !== "mcp")) as typeof r);
    return c.json(result);
  })
  .patch("/:id", uuidParams, zValidator("json", patchBody), async (c) => {
    const repo = c.get("repo");
    const v = c.req.valid("json");
    if (Object.keys(v).length === 0) return c.json({ error: "No changes" }, 400);
    const stored = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!stored) return c.json({ error: "Not found" }, 404);
    if (stored.type === "mcp" && stored.mcpConfig?.toolCall?.enabled &&
      ((v.paused === false && stored.paused) || (v.intervalSec !== undefined && v.intervalSec !== stored.intervalSec) || (v.timeoutMs !== undefined && v.timeoutMs !== stored.timeoutMs) || (v.regions !== undefined && !sameJson(v.regions, stored.regions))) && !(await isManager(c))) {
      return c.json({ error: "Only workspace owners and admins can resume or change the schedule of enabled MCP tool calls" }, 403);
    }

    if (v.target !== undefined) {
      const invalid = rpcProblem({ ...stored, ...v });
      if (invalid) return c.json({ error: invalid }, 400);
    }
    if (v.mcpConfig !== undefined || (stored.type === "mcp" && (v.target !== undefined || v.headers !== undefined))) {
      if (!(await isManager(c))) return c.json({ error: "Only workspace owners and admins can configure MCP monitors" }, 403);
      const invalid = mcpProblem({ ...stored, ...v });
      if (invalid) return c.json({ error: invalid }, 400);
      // An omitted refresh token keeps the stored one (filled in under the row lock); there must be one to keep.
      const saved = stored.mcpConfig?.oauth;
      if (v.mcpConfig?.oauth?.mode === "refresh_token" && !v.mcpConfig.oauth.refreshToken && !(saved?.mode === "refresh_token" && saved.refreshToken)) return c.json({ error: "Refresh-token mode requires a refresh token" }, 400);
    }

    if (v.dnsRecordType !== undefined || v.dnsExpectedValue !== undefined || v.dnsMatchMode !== undefined) {
      const current = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!current) return c.json({ error: "Not found" }, 404);
      if (current.type !== "dns") Object.assign(v, DNS_DEFAULTS);
    }
    // Retaining stored headers or a body also retains their access rights: only managers may change the request around them.
    if (v.headers !== undefined || v.target !== undefined || v.method !== undefined || v.wsMessage !== undefined || v.requestBody !== undefined) {
      const current = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!current) return c.json({ error: "Not found" }, 404);
      if (v.headers) v.headers = restoreHeaders(v.headers, current.headers);
      if (v.requestBody === MASK) v.requestBody = current.requestBody ?? null;
      const invalid = requestBodyProblem({ ...current, ...v });
      if (invalid) return c.json({ error: invalid }, 400);
      const nextHeaders = v.headers ?? current.headers;
      const retainsStored = Object.entries(current.headers).some(([key, value]) => nextHeaders[key] === value)
        || Boolean(current.requestBody && (v.requestBody === undefined || v.requestBody === current.requestBody));
      const changesRequest = (v.target !== undefined && v.target !== current.target)
        || (v.method !== undefined && v.method !== current.method)
        || (v.wsMessage !== undefined && v.wsMessage !== current.wsMessage)
        || (v.requestBody !== undefined && v.requestBody !== (current.requestBody ?? null))
        || !sameJson(nextHeaders, current.headers);
      if (retainsStored && changesRequest && !(await isManager(c))) {
        return c.json({ error: "Only workspace owners and admins can change request settings while keeping stored headers or request body", code: "protected_request_headers" }, 403);
      }
    }
    if (v.target !== undefined) {
      const current = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!current) return c.json({ error: "Not found" }, 404);
      const blocked = await refuseTarget(c, current.type, v.target, v.regions ?? current.regions);
      if (blocked) return blocked;
    }
    if (v.regions !== undefined) {
      const current = await repo.getMonitor(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!current) return c.json({ error: "Not found" }, 404);
      const badRegion = await regionProblem(c, current.type, v.regions);
      if (badRegion) return badRegion;
      if (current.type === "mcp") {
        const blocked = await refuseTarget(c, current.type, v.target ?? current.target, v.regions);
        if (blocked) return blocked;
      }
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
        if (current.type === "domain" && v.intervalSec !== undefined) v.intervalSec = Math.min(86400, Math.max(v.intervalSec, 3600));
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
  .get("/:id/mcp-history", uuidParams, requireManager, async (c) => {
    const days = c.req.query("days") ?? "7";
    if (days !== "7" && days !== "30") return c.json({ error: "days must be 7 or 30" }, 400);
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 120)));
    if (!Number.isInteger(limit)) return c.json({ error: "limit must be an integer" }, 400);
    const history = await c.get("repo").mcpHistory(c.get("orgId"), c.req.param("id"), c.get("projectScope"), { days: days === "7" ? 7 : 30, limit });
    if (!history) return c.json({ error: "MCP monitor not found" }, 404);
    c.header("cache-control", "no-store");
    return c.json(history);
  })
  .post("/:id/mcp-baseline/accept", uuidParams, requireManager, zValidator("json", z.object({ observationId: z.string().uuid(), schemaHash: z.string().regex(/^[a-f0-9]{64}$/) })), async (c) => {
    const result = await c.get("repo").acceptMcpBaseline(c.get("orgId"), c.req.param("id"), c.get("projectScope"), c.req.valid("json"));
    if (result.status === "not_found") return c.json({ error: "MCP monitor not found" }, 404);
    if (result.status !== "accepted") return c.json({ error: "Discovery changed or is incomplete; review the latest schema before accepting", code: result.status }, 409);
    return c.json({ ok: true });
  })
  .post("/:id/mcp-baseline/reset", uuidParams, requireManager, async (c) => c.json({ error: "Review the discovered schema and POST its observationId and schemaHash to /mcp-baseline/accept" }, 409))
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
    if (m.type === "mcp" && !(await isManager(c))) return c.json({ error: "Only workspace owners and admins can run MCP checks" }, 403);
    if (m.type === "heartbeat") return c.json({ error: "Heartbeat monitors have no check to run", code: "regions_not_supported" }, 400);
    if (region !== undefined) {
      if (!(PROBE_TYPES as readonly string[]).includes(m.type) && region !== AUTO) {
        return c.json({ error: `Regions other than auto are available for ${PROBE_TYPES.join(" and ")} monitors only`, code: "regions_not_supported" }, 400);
      }
      if (!isRegionConfigured(region)) return c.json({ error: `Unknown region: ${region}`, code: "unknown_region", regions: [region] }, 400);
    }
    const cost = region !== undefined ? 1 : creditCost(m);
    // a manual check is a request like any other: it takes a credit
    if ((await c.get("entitlements").spendCredits(m.organizationId, cost)) < cost) {
      return c.json({ error: "No credits left this period", code: "credits_exhausted" }, 402);
    }
    if (region === undefined) {
      await checkOne(repo, m, c.get("entitlements"));
      return c.json({ ok: true });
    }
    const run = await runInRegion(region, m, repo);
    if ("unreachable" in run) return c.json({ error: run.unreachable, code: "probe_unreachable", region }, 502);
    return c.json({ ok: true, region, result: run.outcome });
  });
