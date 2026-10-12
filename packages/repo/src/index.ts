/**
 * Storage contract of OpenUptime. `apps/api` talks to the database only through `Repo`; a backend
 * (`packages/db-pg` today) implements it and owns its schema, migrations and SQL dialect.
 * Entities are plain data: timestamps are `Date`, no ORM types leak through.
 */

export const DEFAULT_CHECK_RETENTION_DAYS = 90;
/** Hourly rollups are tiny (one row per monitor-hour) so they outlive the raw rows. */
export const ROLLUP_RETENTION_DAYS = 400;
export const DEFAULT_ALERT_LOG_DAYS = 30;

export type MonitorType = "http" | "tcp" | "dns" | "heartbeat" | "postgres" | "mysql" | "redis";
export type MonitorStatus = "pending" | "up" | "degraded" | "down" | "paused";
export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";
export type IncidentSeverity = "minor" | "major";
export type ChannelType = "email" | "slack" | "telegram" | "webhook" | "pagerduty" | "lark";

/** Project ids a limited API key may touch; `null` = no limit (sessions and unrestricted keys). */
export type Scope = string[] | null;

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  createdAt: Date;
}

export interface Monitor {
  id: string;
  organizationId: string;
  projectId: string | null;
  name: string;
  type: MonitorType;
  target: string;
  method: string;
  expectedStatus: number;
  intervalSec: number;
  timeoutMs: number;
  failureThreshold: number;
  regions: string[];
  status: MonitorStatus;
  consecutiveFailures: number;
  lastCheckedAt: Date | null;
  nextCheckAt: Date;
  paused: boolean;
  heartbeatToken: string | null;
  keyword: string | null;
  keywordMode: string;
  headers: Record<string, string>;
  graceSec: number;
  channelIds: string[];
  tags: string[];
  slowThresholdMs: number;
  slowAlertAfter: number;
  consecutiveSlow: number;
  createdAt: Date;
}

/** Fields a user can set when creating a monitor. */
export type MonitorInput = Pick<
  Monitor,
  | "name" | "type" | "target" | "method" | "expectedStatus" | "intervalSec" | "timeoutMs" | "failureThreshold" | "regions"
  | "keyword" | "keywordMode" | "headers" | "graceSec" | "channelIds" | "tags" | "slowThresholdMs" | "slowAlertAfter"
>;
export type NewMonitor = MonitorInput & { heartbeatToken?: string | null; nextCheckAt?: Date };
/** Only named fields change; the type is immutable. */
export type MonitorPatch = Partial<Omit<MonitorInput, "type">> & { paused?: boolean; status?: MonitorStatus; nextCheckAt?: Date };
/** Bookkeeping written by the checker and the heartbeat endpoint. */
export type MonitorState = Partial<Pick<Monitor, "status" | "consecutiveFailures" | "consecutiveSlow" | "lastCheckedAt" | "nextCheckAt">>;

export interface MonitorListItem extends Monitor {
  uptime24h: number | null;
  avgLatency24h: number | null;
  /** last latency samples, oldest first */
  spark: (number | null)[];
}

export interface CheckResult {
  id: string;
  monitorId: string;
  region: string;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
  checkedAt: Date;
}
export type NewCheck = { monitorId: string; ok: boolean; statusCode?: number | null; latencyMs?: number | null; error?: string | null };

export interface MonitorDetail {
  results: CheckResult[];
  incidents: Incident[];
  stats: { uptime24h: number | null; uptime7d: number | null; avg24h: number | null; p95: number | null };
}

export interface Incident {
  id: string;
  organizationId: string;
  monitorId: string | null;
  title: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  auto: boolean;
  assigneeId: string | null;
  startedAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
}
export interface IncidentUpdate {
  id: string;
  incidentId: string;
  status: IncidentStatus;
  body: string;
  authorId: string | null;
  createdAt: Date;
}
export type NewIncident = {
  organizationId: string;
  monitorId?: string | null;
  title: string;
  severity?: IncidentSeverity;
  auto?: boolean;
  assigneeId?: string | null;
};
export type NewIncidentUpdate = { status: IncidentStatus; body: string; authorId?: string | null };
export type IncidentWithMonitor = Incident & { monitorName: string | null };
export type IncidentWithUpdates = Incident & { updates: IncidentUpdate[] };
export interface IncidentDetail {
  incident: Incident;
  updates: IncidentUpdate[];
  monitor: Pick<Monitor, "id" | "name" | "status" | "target" | "type"> | null;
  assignee: { name: string; email: string } | null;
  /** failed checks inside the incident window, newest first */
  checks: Pick<CheckResult, "id" | "ok" | "statusCode" | "latencyMs" | "error" | "checkedAt">[];
}

export interface AlertChannel {
  id: string;
  organizationId: string;
  projectId: string | null;
  type: ChannelType;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  /** New monitors of the project start out alerting this channel. */
  autoEnable: boolean;
  createdAt: Date;
}
export type NewChannel = Pick<AlertChannel, "type" | "name" | "config" | "enabled"> & Partial<Pick<AlertChannel, "autoEnable">>;
export type ChannelPatch = Partial<Pick<AlertChannel, "name" | "config" | "enabled" | "autoEnable">>;

export interface AlertDelivery {
  id: string;
  organizationId: string;
  projectId: string | null;
  channelId: string | null;
  channelName: string;
  channelType: string;
  /** incident.opened | incident.resolved | incident.muted | test | subscribers */
  kind: string;
  incidentId: string | null;
  monitorName: string | null;
  ok: boolean;
  error: string | null;
  /** how many times delivery was tried (failed incident alerts are retried a few times) */
  attempts: number;
  createdAt: Date;
}
export type NewDelivery = Omit<AlertDelivery, "id" | "createdAt" | "attempts" | "projectId" | "channelId" | "incidentId" | "monitorName" | "error"> &
  Partial<Pick<AlertDelivery, "projectId" | "channelId" | "incidentId" | "monitorName" | "error">>;

export interface DeliveryRetry {
  delivery: AlertDelivery;
  incident: Incident;
  monitor: Monitor;
  channel: AlertChannel;
}

export interface WorkspaceSettings {
  alertLogRetentionDays: number;
  checkRetentionDays: number;
}

export interface MaintenanceWindow {
  id: string;
  organizationId: string;
  projectId: string | null;
  name: string;
  startsAt: Date;
  endsAt: Date;
  /** empty = all monitors in the workspace */
  monitorIds: string[];
  createdAt: Date;
}
export type NewMaintenance = Pick<MaintenanceWindow, "name" | "startsAt" | "endsAt" | "monitorIds">;

export interface StatusPage {
  id: string;
  organizationId: string;
  projectId: string | null;
  slug: string;
  title: string;
  customDomain: string | null;
  theme: string;
  showLatency: boolean;
  /** optional website the page header links to (http/https) */
  externalUrl: string | null;
  createdAt: Date;
}
export type NewStatusPage = { slug: string; title: string; theme?: string; showLatency?: boolean; externalUrl?: string | null };
export type StatusPagePatch = Partial<Pick<StatusPage, "title" | "theme" | "showLatency" | "externalUrl">>;
export type PageComponentInput = { monitorId: string; groupName?: string };
export interface Subscriber {
  id: string;
  email: string;
  confirmedAt: Date | null;
  createdAt: Date;
}
export interface SubscriberTarget {
  email: string;
  locale: string | null;
  token: string;
  slug: string;
  title: string;
}
export interface StatusBoard {
  /** granularity of each component's `days` */
  bucket: "hour" | "day";
  components: {
    id: string;
    name: string;
    group: string;
    status: MonitorStatus;
    uptime90d: number | null;
    days: { day: string; uptime: number }[];
  }[];
  /** unresolved incidents of the page, newest first */
  incidents: IncidentWithUpdates[];
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  createdAt: Date;
  metadata: string | null;
}
export interface UserProfile {
  name: string;
  email: string;
  locale: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean | null;
}
export interface OwnedWorkspace {
  id: string;
  name: string;
  /** number of members, owner included */
  members: number;
}
export interface AccountExport {
  user: { id: string; name: string; email: string; emailVerified: boolean; locale: string | null; twoFactorEnabled: boolean | null; createdAt: Date } | null;
  sessions: unknown[];
  workspaces: unknown[];
}
export interface Counts {
  monitors: number;
  incidents: number;
  "status-pages": number;
  alerting: number;
}

export interface Repo {
  // ── workspaces, users, projects ──────────────────────────────────────────────
  isMember(userId: string, orgId: string): Promise<boolean>;
  /** Has this address been invited to a workspace and not answered yet (case-insensitive)? */
  hasPendingInvitation(email: string): Promise<boolean>;
  /** The member's role in the workspace (owner, admin, member), or null when they are not a member. */
  memberRole(userId: string, orgId: string): Promise<string | null>;
  /** The workspace a user belongs to (first found), for API keys without one. */
  anyWorkspaceOf(userId: string): Promise<string | null>;
  /** True while the user's grant to this OAuth client is on file (deleting it revokes the agent at once). */
  hasOAuthConsent(userId: string, clientId: string): Promise<boolean>;
  /** Registers an OAuth protected resource (identifier = its URL) if it is not there yet. */
  ensureOAuthResource(identifier: string, name: string, scopes: string[]): Promise<void>;
  /** Every workspace a user belongs to (for picking one when authorizing an agent). */
  workspacesOf(userId: string): Promise<{ id: string; name: string }[]>;
  organization(orgId: string): Promise<Organization | null>;
  userProfile(userId: string): Promise<UserProfile | null>;
  setUserLocale(userId: string, locale: string): Promise<void>;
  /** Stored language of the account with this e-mail, if any. */
  localeByEmail(email: string): Promise<string | null>;
  /** Language of the workspace owner. */
  ownerLocale(orgId: string): Promise<string | null>;
  exportAccount(userId: string): Promise<AccountExport>;
  counts(orgId: string, projectId: string): Promise<Counts>;
  /** Monitors of the workspace (every project) that are not paused: what a plan's monitor cap counts. */
  activeMonitorCount(orgId: string): Promise<number>;

  /** Workspaces this user owns (for the account-deletion guard). */
  ownedWorkspaces(userId: string): Promise<OwnedWorkspace[]>;
  deleteWorkspaces(ids: string[]): Promise<void>;
  /** A personal workspace with its default project. */
  createPersonalWorkspace(w: { id: string; name: string; slug: string; ownerId: string }): Promise<void>;
  /** Workspace to activate on sign-in: the previous session's if still a member, else the most recently joined. */
  preferredWorkspace(userId: string): Promise<string | null>;

  listProjects(orgId: string, scope: Scope): Promise<Pick<Project, "id" | "name" | "createdAt">[]>;
  countProjects(orgId: string): Promise<number>;
  createProject(orgId: string, name: string): Promise<Project>;
  renameProject(orgId: string, id: string, name: string): Promise<Project | null>;
  deleteProject(orgId: string, id: string): Promise<void>;
  /** The requested project if it belongs to the workspace, else the oldest (created on first use). */
  resolveProject(orgId: string, wanted?: string): Promise<string>;
  ensureDefaultProject(orgId: string): Promise<string>;

  // ── monitors ─────────────────────────────────────────────────────────────────
  listMonitors(orgId: string, projectId: string): Promise<MonitorListItem[]>;
  exportMonitors(orgId: string, projectId: string): Promise<Monitor[]>;
  getMonitor(orgId: string, id: string, scope: Scope): Promise<Monitor | null>;
  monitorDetail(monitorId: string): Promise<MonitorDetail>;
  createMonitor(orgId: string, projectId: string, input: NewMonitor): Promise<Monitor>;
  createMonitors(orgId: string, projectId: string, inputs: NewMonitor[]): Promise<void>;
  updateMonitor(orgId: string, id: string, scope: Scope, patch: MonitorPatch): Promise<Monitor | null>;
  deleteMonitor(orgId: string, id: string, scope: Scope): Promise<void>;
  /** Which of `ids` belong to the workspace (and the key's projects). */
  ownedMonitorIds(orgId: string, ids: string[], scope: Scope): Promise<string[]>;
  monitorByHeartbeatToken(token: string): Promise<Monitor | null>;

  // ── checking ─────────────────────────────────────────────────────────────────
  /**
   * Atomically lease due monitors; concurrent callers never get the same monitor. The next due time moves one interval past
   * the previous *scheduled* time (not the time the check finished), so a fixed cron tick never skips a whole interval.
   */
  claimDue(limit: number): Promise<Monitor[]>;
  monitorsByIds(ids: string[]): Promise<Monitor[]>;
  /**
   * Mark claimed runs as started. A run is identified by its monitor and the due time its claim assigned (`token`, the
   * `nextCheckAt` that `claimDue` returned). Returns the monitors whose run had not been started yet, so a redelivered
   * queue message never runs (or bills) the same check twice.
   */
  beginRuns(runs: { id: string; token: Date }[]): Promise<string[]>;
  /** Hand claimed monitors back, due right now, when their work could not be queued. Monitors that moved on since are left alone. */
  releaseClaims(runs: { id: string; token: Date }[]): Promise<void>;
  /** Store a raw result and fold it into its hourly rollup. */
  recordCheck(r: NewCheck): Promise<void>;
  setMonitorState(id: string, state: MonitorState): Promise<void>;
  /** Is a maintenance window of the monitor's project (or a workspace-wide one) covering it right now? */
  underMaintenance(m: Pick<Monitor, "id" | "organizationId" | "projectId">): Promise<boolean>;
  /** Delete raw results and alert history past each workspace's retention, and old rollups. */
  purgeExpired(): Promise<void>;
  /** Fixed-window counter shared across isolates; true while within `limit`. */
  withinLimit(key: string, limit: number, windowSec: number): Promise<boolean>;

  // ── incidents ────────────────────────────────────────────────────────────────
  listIncidents(orgId: string, projectId: string): Promise<IncidentWithMonitor[]>;
  /** Is the incident on one of the key's projects (or not tied to a monitor)? */
  incidentVisible(orgId: string, id: string, scope: Scope): Promise<boolean>;
  incidentDetail(orgId: string, id: string): Promise<IncidentDetail | null>;
  createIncident(inc: NewIncident, firstUpdate?: NewIncidentUpdate): Promise<Incident>;
  /**
   * Opens an automatic incident unless the monitor already has an open one of that kind (outage or latency): then
   * nothing is written and null comes back, so only the check that really opened it sends the alert.
   */
  openAutoIncident(inc: NewIncident, firstUpdate: NewIncidentUpdate): Promise<Incident | null>;
  /** Set the status (stamping `resolvedAt` when resolved) and append an update. */
  postIncidentUpdate(orgId: string, id: string, u: NewIncidentUpdate): Promise<{ incident: Incident; update: IncidentUpdate } | null>;
  acknowledgeIncident(orgId: string, id: string, userId: string): Promise<Incident | null>;
  /** An unresolved incident of the monitor: an automatic latency one with `slow`, otherwise any other (outage or manual) one. */
  hasOpenIncident(monitorId: string, slow: boolean): Promise<boolean>;
  hadIncidentSince(monitorId: string, since: Date): Promise<boolean>;
  /** Unresolved incidents of the monitor: its outage ones, or with `slow` only the automatic latency ones. */
  openIncidents(monitorId: string, slow: boolean): Promise<Incident[]>;
  /** Resolves an open incident; false when it was already resolved (another check got there first). */
  resolveIncident(id: string, body: string): Promise<boolean>;
  /** Was this incident's alert suppressed (flapping)? */
  incidentMuted(id: string): Promise<boolean>;

  // ── alerting ─────────────────────────────────────────────────────────────────
  listChannels(orgId: string, projectId: string): Promise<AlertChannel[]>;
  getChannel(orgId: string, id: string, scope: Scope): Promise<AlertChannel | null>;
  /** `projectId` null = a workspace-wide channel, shared by every project. */
  createChannel(orgId: string, projectId: string | null, c: NewChannel): Promise<AlertChannel>;
  updateChannel(orgId: string, id: string, scope: Scope, patch: ChannelPatch): Promise<AlertChannel | null>;
  deleteChannel(orgId: string, id: string, scope: Scope): Promise<void>;
  /** Enabled channels (the project's own and the workspace-wide ones) that new monitors of the project start out with. */
  autoEnabledChannelIds(orgId: string, projectId: string): Promise<string[]>;
  /** Monitors that list the channel explicitly (a monitor with no list alerts every channel, so it does not count). */
  monitorsUsingChannel(orgId: string, channelId: string): Promise<{ id: string; name: string }[]>;
  /** Enabled channels to alert: the listed ones, or (no list) the project's own plus workspace-wide ones. */
  channelsToAlert(orgId: string, o: { channelIds: string[]; projectId?: string | null }): Promise<AlertChannel[]>;
  logDeliveries(rows: NewDelivery[]): Promise<void>;
  /** Lease failed incident alerts that are due a retry (a few attempts, with backoff). */
  claimRetries(limit: number): Promise<DeliveryRetry[]>;
  /** Record a retry's outcome; `retryInSec` schedules another attempt (null = give up). */
  finishRetry(id: string, r: { ok: boolean; error: string | null; retryInSec: number | null }): Promise<void>;
  /** Deliveries of the project (and workspace-wide ones), newest first. */
  listDeliveries(orgId: string, projectId: string, o: { limit: number; before?: Date }): Promise<AlertDelivery[]>;
  /** Confirmed subscribers of the pages showing this monitor (every page of the workspace when `monitorId` is null). */
  subscribersFor(orgId: string, monitorId: string | null | undefined): Promise<SubscriberTarget[]>;
  getSettings(orgId: string): Promise<WorkspaceSettings>;
  saveSettings(orgId: string, patch: Partial<WorkspaceSettings>): Promise<WorkspaceSettings>;

  listMaintenance(orgId: string, projectId: string): Promise<MaintenanceWindow[]>;
  createMaintenance(orgId: string, projectId: string, w: NewMaintenance): Promise<MaintenanceWindow>;
  deleteMaintenance(orgId: string, id: string, scope: Scope): Promise<void>;

  // ── status pages ─────────────────────────────────────────────────────────────
  listStatusPages(orgId: string, projectId: string): Promise<StatusPage[]>;
  getStatusPage(orgId: string, id: string, scope: Scope): Promise<StatusPage | null>;
  slugTaken(slug: string): Promise<boolean>;
  createStatusPage(orgId: string, projectId: string, p: NewStatusPage): Promise<StatusPage>;
  updateStatusPage(id: string, patch: StatusPagePatch): Promise<void>;
  deleteStatusPage(id: string): Promise<void>;
  pageComponents(pageId: string): Promise<{ monitorId: string; groupName: string }[]>;
  /** Replace the page's components; monitors not in the workspace (or the key's projects) are dropped. */
  setPageComponents(pageId: string, orgId: string, comps: PageComponentInput[], scope: Scope): Promise<void>;
  listSubscribers(pageId: string): Promise<Subscriber[]>;
  deleteSubscriber(pageId: string, subscriberId: string): Promise<void>;

  // public read model + subscriptions (no workspace context)
  statusPageBySlug(slug: string): Promise<StatusPage | null>;
  statusBoard(page: StatusPage): Promise<StatusBoard>;
  /** Incidents shown on a page (its monitors' plus workspace-level ones), newest first. */
  pageIncidents(page: StatusPage, o: { limit: number; before?: Date }): Promise<IncidentWithUpdates[]>;
  subscriberCount(pageId: string): Promise<number>;
  /** Returns the new row's locale, or null when the address was already subscribed. */
  addSubscriber(s: { pageId: string; email: string; token: string; locale: string }): Promise<{ locale: string | null } | null>;
  /** Marks the token confirmed; returns the page slug it belongs to (null for unknown tokens). */
  confirmSubscriber(token: string): Promise<string | null>;
  removeSubscriber(token: string): Promise<string | null>;
}

/** An open database: the repo plus the pieces that are tied to a specific backend. */
export interface Database {
  repo: Repo;
  /** The `database` option of Better Auth, built for this backend. */
  authDatabase: unknown;
  /** Apply the embedded schema migrations; returns the tags applied. */
  migrate(): Promise<string[]>;
  /**
   * Run a parameterised SQL statement ($1, $2, …) and return its rows. For editions that keep their own tables next to
   * ours (the hosted edition's subscriptions and usage) so they need neither a second connection nor changes to `Repo`.
   */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  close(timeoutSec?: number): Promise<void>;
}
export type OpenDatabase = (connectionString: string, opts?: { max?: number }) => Database;
