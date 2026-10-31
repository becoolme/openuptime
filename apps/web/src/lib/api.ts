import { resolveRoute } from "./routes";
import { go } from "./locale-path";

export type McpAssertion = { path: string; operator: "equals" | "contains" | "exists"; value?: unknown };
export type McpOAuth = { mode: "client_credentials" | "refresh_token"; issuer: string; clientId: string; clientSecret?: string; refreshToken?: string; scopes?: string[]; resource?: string; tokenAuthMethod?: "client_secret_basic" | "client_secret_post" };
export type McpConfig = { requiredTools: string[]; schemaCheck: boolean; transport?: "auto" | "streamable-http" | "sse"; listPrompts?: boolean; listResources?: boolean; driftPolicy?: "down" | "degraded" | "record"; oauth?: McpOAuth | null; toolCall: { enabled: boolean; name: string; arguments: Record<string, unknown>; assertions: McpAssertion[] } | null };
export type McpToolSchema = { name: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; description?: string; annotations?: Record<string, unknown> };
export type McpDrift = { severity: "breaking" | "warning" | "info"; kind: string; tool: string; path?: string; message: string };
export type McpObservation = { toolsComplete?: boolean; id?: string; schemaHash?: string; checkedAt?: string; protocolVersion?: string; transport?: string; stage: string; timings: Record<string, number>; tools: McpToolSchema[]; changes: string[]; drift?: McpDrift[]; prompts?: { name: string }[]; resources?: { uri: string; name: string }[] };
export type McpCheckDiagnostics = Pick<McpObservation, "id" | "schemaHash" | "checkedAt" | "stage" | "timings" | "changes" | "drift" | "protocolVersion" | "transport">;
export type McpHistory = { results: (CheckResult & { mcp: McpCheckDiagnostics })[]; metrics: { samples: number; p50: number | null; p95: number | null; stages: Record<string, { samples: number; p50: number | null; p95: number | null }> }; changes: { id: string; checkedAt: string; severity: "breaking" | "warning" | "info"; changes: string[]; drift: McpDrift[] }[] };
export type McpPreview = { ok: boolean; latencyMs?: number; error?: string; mcp: McpObservation };
export type Monitor = {
  id: string; name: string; type: "http" | "tcp" | "dns" | "heartbeat" | "postgres" | "mysql" | "redis" | "websocket" | "domain" | "mcp" | "evm" | "solana"; target: string; method: string; requestBody?: string | null;
  mcpConfig?: McpConfig | null;
  mcpConfigRedacted?: boolean;
  mcpBaseline?: McpToolSchema[] | null;
  mcpObservation?: McpObservation | null;
  domainExpiryWarnDays?: number;
  domainExpiry?: { state: "valid" | "expiring" | "expired" | "unknown"; expiresAt: string | null; checkedAt: string; cacheUntil: string; source: string | null; error: string | null } | null;
  expectedStatus: number; intervalSec: number; timeoutMs: number; failureThreshold: number; recoveryThreshold?: number; consecutiveSuccesses?: number;
  status: "pending" | "up" | "degraded" | "down" | "paused"; paused: boolean;
  lastCheckedAt: string | null; heartbeatToken: string | null;
  uptime24h?: number | null; avgLatency24h?: number | null; spark?: (number | null)[];
  dnsRecordType?: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS"; dnsExpectedValue?: string | null; dnsMatchMode?: "exact" | "contains";
  keyword?: string | null; keywordMode?: "contains" | "absent"; expectedLocation?: string | null; wsMessage?: string | null; graceSec?: number; channelIds?: string[]; headers?: Record<string, string>;
  /** the project the monitor belongs to (the lists of the "All projects" view mix several) */
  projectId?: string | null;
  tags?: string[]; slowThresholdMs?: number; slowAlertAfter?: number;
  /** where checks run from: `auto` (this deployment) or ids from `api.regions()` */
  regions?: string[];
  /** another monitor of the project; while it is down this one opens no incidents and sends no alerts */
  dependsOnMonitorId?: string | null;
  /** several regions: how many must fail before it goes down; 0 = a majority of those that answered */
  minRegionsFailing?: number;
};
export type Project = { id: string; name: string };
/** One project's line in the "All projects" overview. */
export type ProjectOverview = Project & { monitors: number; down: number; openIncidents: number };
export type Subscriber = { id: string; email: string; confirmedAt: string | null; createdAt: string };
export type Maintenance = { seriesId?: string | null; recurrence?: { frequency: "daily" | "weekly"; timeZone: string; until: string } | null; id: string; name: string; startsAt: string; endsAt: string; monitorIds: string[] };
export type CheckResult = { id: string; ok: boolean; statusCode: number | null; latencyMs: number | null; error: string | null; checkedAt: string; region?: string };
export type RegionStat = {
  region: string; checks24h: number; uptime24h: number | null; avgLatency24h: number | null;
  last: { ok: boolean; statusCode: number | null; latencyMs: number | null; error: string | null; checkedAt: string } | null;
};
export type RegionList = { regions: { id: string; name: string }[]; types: string[]; maxPerMonitor: number | null };
export type SpotCheck = { ok: true; region?: string; result?: { ok: boolean; statusCode?: number; latencyMs?: number; error?: string } };
export type Incident = {
  id: string; title: string; status: "investigating" | "identified" | "monitoring" | "resolved";
  /** sequential inside the project, shown as INC-<number> */
  number?: number | null;
  projectId?: string | null;
  rootCause?: string | null;
  postmortem?: string | null;
  /** set once a person published the write-up to the status page */
  postmortemPublishedAt?: string | null;
  severity: string; startedAt: string; resolvedAt: string | null; acknowledgedAt: string | null; monitorName?: string | null;
  updates?: { id: string; status: Incident["status"]; body: string; visibility?: "public" | "internal"; createdAt: string }[];
  auto?: boolean;
  /** why an automatic incident opened, e.g. "3 consecutive failed checks; 3 of 3 regions failed" */
  evaluationNote?: string | null;
  monitorId?: string | null;
  monitor?: { id: string; name: string; status: string; target: string; type: string } | null;
  assignee?: { name: string; email: string } | null;
  checks?: CheckResult[];
  deliveries?: AlertDelivery[];
};

export type Channel = { id: string; type: "slack" | "webhook" | "email" | "telegram" | "pagerduty" | "lark" | "push" | "discord" | "teams" | "ntfy"; name: string; config: { url?: string; secret?: string; to?: string; chatId?: string; botToken?: string; routingKey?: string; topic?: string; token?: string; priority?: string }; enabled: boolean; autoEnable?: boolean; projectId?: string | null };
export type WorkspaceSettings = { alertLogRetentionDays: number; checkRetentionDays: number; monthlyReport: boolean };
export type StatusPage = { id: string; projectId?: string | null; slug: string; title: string; theme: "light" | "dark" | "auto"; showLatency: boolean; externalUrl?: string | null; hideBranding?: boolean; uptimeOkPct?: number; uptimeWarnPct?: number; mcpEnabled?: boolean; maintenanceReminderHours?: number; branding?: { allowed: boolean; upgradeUrl?: string }; monitorIds?: string[]; components?: { monitorId: string; groupName: string | null }[] };

// Requests started as soon as the page's HTML is parsed (lib/boot.ts), in parallel with the JS bundles loading:
// the first GET for a path is answered by that in-flight request, so a page load is HTML (static) + one parallel API round.
// Entries expire after a few seconds and any mutation drops them, so a prefetched page never shows stale data.
const EARLY_TTL = 10_000;
const early = new Map<string, { at: number; p: Promise<unknown> }>();
function takeEarly(path: string): Promise<unknown> | undefined {
  const e = early.get(path);
  return e && Date.now() - e.at < EARLY_TTL ? e.p : undefined;
}
export type Quota = { limit: number; used: number; periodStart: string; periodEnd: string };
export type Usage =
  | { metered: false }
  | {
      metered: true;
      credits: Quota | null;
      emails: Quota | null;
      activeMonitors: number;
      plan: { id: string; name: string; maxActiveMonitors: number | null; minIntervalSec: number; maxRegions?: number | null; upgradeUrl?: string; manageUrl?: string } | null;
    };

/** Starts the shell's reads and the data of the route at `pathname` right away. */
export function prefetch(pathname: string) {
  const hit = resolveRoute(pathname);
  for (const path of ["/me", "/counts", "/projects", ...(hit ? hit.route.data(hit.params) : [])]) {
    if (early.has(path)) continue;
    const p = fetchJson<unknown>(path);
    p.catch(() => {});
    early.set(path, { at: Date.now(), p });
  }
}

// Revisits: every GET is remembered, and the first read of a path right after a route change is answered from memory
// (instant paint) while a background request checks it. A mutation drops everything so edits are never shown stale.
const STORE_TTL = 60_000;
const store = new Map<string, { at: number; data: unknown }>();
let armedUntil = 0;
/** Called by the router on every navigation: the page's mount-time reads may use remembered data. */
export const armCache = () => { armedUntil = Date.now() + 1500; };

// Switching workspace or project changes what every path returns: forget everything, and let no read that was already
// in flight for the old scope be remembered.
let scope = 0;
export function resetCache() {
  scope++;
  armedUntil = 0;
  store.clear();
  early.clear();
}

/** An API refusal: `code` and the rest of the body let the UI explain plan limits (HTTP 402) instead of just printing the message. */
export class ApiError extends Error {
  status: number;
  code?: string;
  upgradeUrl?: string;
  constructor(message: string, status: number, body: { code?: string; upgradeUrl?: string } | null) {
    super(message);
    this.status = status;
    this.code = body?.code;
    this.upgradeUrl = body?.upgradeUrl;
  }
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (res.status === 401) {
    go("/login");
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; code?: string; upgradeUrl?: string } | null;
    throw new ApiError(body?.error ?? res.statusText, res.status, body);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  if (init?.method && init.method !== "GET") {
    store.clear();
    early.clear();
    return fetchJson<T>(path, init);
  }
  const asked = scope;
  const keep = (data: unknown) => { if (asked === scope) store.set(path, { at: Date.now(), data }); };
  const pending = takeEarly(path);
  if (pending) {
    try {
      const data = await pending;
      keep(data);
      return data as T;
    } catch { /* fall through to a fresh request */ }
  }
  const hit = store.get(path);
  if (hit && Date.now() < armedUntil && Date.now() - hit.at < STORE_TTL) {
    store.delete(path);
    fetchJson<T>(path, init).then((fresh) => {
      if (asked !== scope) return;
      keep(fresh);
      if (JSON.stringify(fresh) !== JSON.stringify(hit.data)) window.dispatchEvent(new Event("ou:stale"));
    }).catch(() => {});
    return hit.data as T;
  }
  const data = await fetchJson<T>(path, init);
  keep(data);
  return data;
}

export type AlertDelivery = {
  id: string; channelId: string | null; channelName: string; channelType: string;
  kind: "incident.opened" | "incident.resolved" | "incident.reminder" | "incident.escalated" | "test" | string;
  monitorName: string | null; ok: boolean; error: string | null; createdAt: string;
  /** null on rows written before delivery states existed */
  status?: "pending" | "sending" | "sent" | "failed" | "skipped" | null;
  /** why a delivery was skipped or failed, in words */
  statusMessage?: string | null;
  /** when the incident was acknowledged after this alert went out */
  acknowledgedAt?: string | null;
};

export type ProjectAlerting = {
  reminderIntervalMin: number | null;
  reminderEmail: boolean;
  escalation: { channelIds: string[]; escalateAfterMin: number }[];
};

export type TimeCoverage = {
  from: string; to: string; totalMs: number;
  states: Record<"up" | "down" | "degraded" | "paused" | "unknown", number>;
  observedMaintenanceMs: number; policy: "bounded-observation-v1";
};

export const api = {
  timeCoverage: (id: string, days: 7 | 30) => req<TimeCoverage>(`/monitors/${id}/time-coverage?days=${days}`),
  monitors: () => req<Monitor[]>("/monitors"),
  monitor: (id: string) => req<Monitor & { results: CheckResult[]; regionStats: RegionStat[] }>(`/monitors/${id}`),
  regions: () => req<RegionList>("/regions"),
  createMonitor: (b: Partial<Monitor> & { name: string }) => req<Monitor>("/monitors", { method: "POST", body: JSON.stringify(b) }),
  updateMonitor: (id: string, b: Partial<Monitor>) => req<Monitor>(`/monitors/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  deleteMonitor: (id: string) => req<void>(`/monitors/${id}`, { method: "DELETE" }),
  previewMcp: (body: { region?: string; monitorId?: string; target: string; headers: Record<string, string>; timeoutMs: number; mcpConfig: McpConfig }) => req<McpPreview>("/monitors/mcp/preview", { method: "POST", body: JSON.stringify(body) }),
  mcpHistory: (id: string, days: 7 | 30) => req<McpHistory>(`/monitors/${id}/mcp-history?days=${days}&limit=120`),
  acceptMcpBaseline: (id: string, observationId: string, schemaHash: string) => req<{ ok: true }>(`/monitors/${id}/mcp-baseline/accept`, { method: "POST", body: JSON.stringify({ observationId, schemaHash }) }),
  /** Without `region` the monitor's own check runs and is recorded; with it one request is sent from there and only returned. */
  checkNow: (id: string, region?: string) => req<SpotCheck>(`/monitors/${id}/check`, { method: "POST", ...(region ? { body: JSON.stringify({ region }) } : {}) }),
  me: () => req<{ userId: string; organization: { id: string; name: string }; projectId: string; user: { name: string; email: string; locale: string | null; emailVerified?: boolean; twoFactorEnabled?: boolean | null } | null }>("/me"),
  setLocale: (locale: "en" | "zh-CN") => req<{ locale: string }>("/me/locale", { method: "PATCH", body: JSON.stringify({ locale }) }),
  counts: () => req<Record<string, number>>("/counts"),
  usage: () => req<Usage>("/usage"),
  projects: () => req<Project[]>("/projects"),
  projectOverview: () => req<ProjectOverview[]>("/projects/overview"),
  createWorkspace: (name: string) => req<{ id: string; name: string }>("/workspaces", { method: "POST", body: JSON.stringify({ name }) }),
  createProject: (name: string) => req<Project>("/projects", { method: "POST", body: JSON.stringify({ name }) }),
  renameProject: (id: string, name: string) => req<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteProject: (id: string) => req<void>(`/projects/${id}`, { method: "DELETE" }),
  maintenance: () => req<Maintenance[]>("/maintenance"),
  createMaintenance: (b: Omit<Maintenance, "id">) => req<Maintenance>("/maintenance", { method: "POST", body: JSON.stringify(b) }),
  endMaintenance: (id: string) => req<{ ok: boolean }>(`/maintenance/${id}/end`, { method: "POST" }),
  cancelMaintenanceSeries: (id: string) => req<void>(`/maintenance/series/${id}`, { method: "DELETE" }),
  deleteMaintenance: (id: string) => req<void>(`/maintenance/${id}`, { method: "DELETE" }),
  /** What this deployment can do (public). */
  config: () => req<{ push?: { apns: boolean } }>("/config"),
  channels: () => req<Channel[]>("/channels"),
  projectAlerting: (projectId: string) => req<ProjectAlerting>(`/projects/${projectId}/alerting`),
  saveProjectAlerting: (projectId: string, b: ProjectAlerting) => req<ProjectAlerting>(`/projects/${projectId}/alerting`, { method: "PUT", body: JSON.stringify(b) }),
  alertLog: (limit = 30) => req<AlertDelivery[]>(`/alert-log?limit=${limit}`),
  settings: () => req<WorkspaceSettings>("/settings"),
  updateSettings: (b: Partial<WorkspaceSettings>) =>
    req<WorkspaceSettings>("/settings", { method: "PATCH", body: JSON.stringify(b) }),
  createChannel: (b: { type: Channel["type"]; name: string; config: Record<string, string>; autoEnable?: boolean }) =>
    req<Channel>("/channels", { method: "POST", body: JSON.stringify(b) }),
  updateChannel: (id: string, b: { name?: string; enabled?: boolean; autoEnable?: boolean; config?: Record<string, string> }) => req<Channel>(`/channels/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  testChannel: (id: string) => req<{ ok: boolean }>(`/channels/${id}/test`, { method: "POST" }),
  deleteChannel: (id: string) => req<void>(`/channels/${id}`, { method: "DELETE" }),
  statusPages: () => req<StatusPage[]>("/status-pages"),
  subscribers: (pageId: string) => req<Subscriber[]>(`/status-pages/${pageId}/subscribers`),
  deleteSubscriber: (pageId: string, id: string) => req<void>(`/status-pages/${pageId}/subscribers/${id}`, { method: "DELETE" }),
  statusPage: (id: string) => req<StatusPage>(`/status-pages/${id}`),
  createStatusPage: (b: { slug: string; title: string; monitorIds: string[] }) =>
    req<StatusPage>("/status-pages", { method: "POST", body: JSON.stringify(b) }),
  updateStatusPage: (id: string, b: Partial<StatusPage>) => req(`/status-pages/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  deleteStatusPage: (id: string) => req<void>(`/status-pages/${id}`, { method: "DELETE" }),
  incidents: () => req<Incident[]>("/incidents"),
  declareIncident: (b: { title: string; body?: string; severity?: "minor" | "major"; monitorId?: string | null; visibility?: "public" | "internal" }) =>
    req<Incident>("/incidents", { method: "POST", body: JSON.stringify(b) }),
  incident: (id: string) => req<Incident>(`/incidents/${id}`),
  postUpdate: (id: string, b: { status: Incident["status"]; body: string; visibility?: "public" | "internal" }) =>
    req(`/incidents/${id}/updates`, { method: "POST", body: JSON.stringify(b) }),
  saveWriteUp: (id: string, b: { rootCause?: string | null; postmortem?: string | null; publishPostmortem?: boolean }) =>
    req<Incident>(`/incidents/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  ack: (id: string) => req(`/incidents/${id}/ack`, { method: "POST" }),
};

/** A check interval in its shortest form: 30s, 5m, 2h, 1d (45m stays 45m; 90 s stays 90s). */
export const everyShort = (sec: number) => {
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60]] as const) if (sec >= size && sec % size === 0) return `${sec / size}${unit}`;
  return `${sec}s`;
};

export const ago = (iso: string | null) => {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
