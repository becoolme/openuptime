import { resolveRoute } from "./routes";
import { go } from "./locale-path";

export type Monitor = {
  id: string; name: string; type: "http" | "tcp" | "dns" | "heartbeat" | "postgres" | "mysql" | "redis"; target: string; method: string;
  expectedStatus: number; intervalSec: number; timeoutMs: number; failureThreshold: number;
  status: "pending" | "up" | "degraded" | "down" | "paused"; paused: boolean;
  lastCheckedAt: string | null; heartbeatToken: string | null;
  uptime24h?: number | null; avgLatency24h?: number | null; spark?: (number | null)[];
  keyword?: string | null; keywordMode?: "contains" | "absent"; graceSec?: number; channelIds?: string[]; headers?: Record<string, string>;
  tags?: string[]; slowThresholdMs?: number; slowAlertAfter?: number;
};
export type Project = { id: string; name: string };
export type Subscriber = { id: string; email: string; confirmedAt: string | null; createdAt: string };
export type Maintenance = { id: string; name: string; startsAt: string; endsAt: string; monitorIds: string[] };
export type CheckResult = { id: string; ok: boolean; statusCode: number | null; latencyMs: number | null; error: string | null; checkedAt: string };
export type Incident = {
  id: string; title: string; status: "investigating" | "identified" | "monitoring" | "resolved";
  severity: string; startedAt: string; resolvedAt: string | null; acknowledgedAt: string | null; monitorName?: string | null;
  updates?: { id: string; status: Incident["status"]; body: string; createdAt: string }[];
  auto?: boolean;
  monitorId?: string | null;
  monitor?: { id: string; name: string; status: string; target: string; type: string } | null;
  assignee?: { name: string; email: string } | null;
  checks?: CheckResult[];
};

export type Channel = { id: string; type: "slack" | "webhook" | "email" | "telegram" | "pagerduty" | "lark"; name: string; config: { url?: string; secret?: string; to?: string; chatId?: string; botToken?: string; routingKey?: string }; enabled: boolean; autoEnable?: boolean; projectId?: string | null };
export type StatusPage = { id: string; slug: string; title: string; theme: "light" | "dark" | "auto"; showLatency: boolean; externalUrl?: string | null; monitorIds?: string[]; components?: { monitorId: string; groupName: string | null }[] };

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
      plan: { id: string; name: string; maxActiveMonitors: number | null; minIntervalSec: number; upgradeUrl?: string; manageUrl?: string } | null;
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
  kind: "incident.opened" | "incident.resolved" | "test" | string;
  monitorName: string | null; ok: boolean; error: string | null; createdAt: string;
};

export const api = {
  monitors: () => req<Monitor[]>("/monitors"),
  monitor: (id: string) => req<Monitor & { results: CheckResult[] }>(`/monitors/${id}`),
  createMonitor: (b: Partial<Monitor> & { name: string }) => req<Monitor>("/monitors", { method: "POST", body: JSON.stringify(b) }),
  updateMonitor: (id: string, b: Partial<Monitor>) => req<Monitor>(`/monitors/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  deleteMonitor: (id: string) => req<void>(`/monitors/${id}`, { method: "DELETE" }),
  checkNow: (id: string) => req<{ ok: true }>(`/monitors/${id}/check`, { method: "POST" }),
  me: () => req<{ userId: string; organization: { id: string; name: string }; projectId: string; user: { name: string; email: string; locale: string | null; emailVerified?: boolean; twoFactorEnabled?: boolean | null } | null }>("/me"),
  setLocale: (locale: "en" | "zh-CN") => req<{ locale: string }>("/me/locale", { method: "PATCH", body: JSON.stringify({ locale }) }),
  counts: () => req<Record<string, number>>("/counts"),
  usage: () => req<Usage>("/usage"),
  projects: () => req<Project[]>("/projects"),
  createWorkspace: (name: string) => req<{ id: string; name: string }>("/workspaces", { method: "POST", body: JSON.stringify({ name }) }),
  createProject: (name: string) => req<Project>("/projects", { method: "POST", body: JSON.stringify({ name }) }),
  renameProject: (id: string, name: string) => req<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteProject: (id: string) => req<void>(`/projects/${id}`, { method: "DELETE" }),
  maintenance: () => req<Maintenance[]>("/maintenance"),
  createMaintenance: (b: Omit<Maintenance, "id">) => req<Maintenance>("/maintenance", { method: "POST", body: JSON.stringify(b) }),
  deleteMaintenance: (id: string) => req<void>(`/maintenance/${id}`, { method: "DELETE" }),
  channels: () => req<Channel[]>("/channels"),
  alertLog: (limit = 30) => req<AlertDelivery[]>(`/alert-log?limit=${limit}`),
  settings: () => req<{ alertLogRetentionDays: number; checkRetentionDays: number }>("/settings"),
  updateSettings: (b: { alertLogRetentionDays?: number; checkRetentionDays?: number }) =>
    req<{ alertLogRetentionDays: number; checkRetentionDays: number }>("/settings", { method: "PATCH", body: JSON.stringify(b) }),
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
  declareIncident: (b: { title: string; body?: string; severity?: "minor" | "major"; monitorId?: string | null }) =>
    req<Incident>("/incidents", { method: "POST", body: JSON.stringify(b) }),
  incident: (id: string) => req<Incident>(`/incidents/${id}`),
  postUpdate: (id: string, b: { status: Incident["status"]; body: string }) =>
    req(`/incidents/${id}/updates`, { method: "POST", body: JSON.stringify(b) }),
  ack: (id: string) => req(`/incidents/${id}/ack`, { method: "POST" }),
};

export const ago = (iso: string | null) => {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
