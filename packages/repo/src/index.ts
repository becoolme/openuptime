/**
 * Storage contract of OpenUptime. `apps/api` talks to the database only through `Repo`; a backend
 * (`packages/db-pg` today) implements it and owns its schema, migrations and SQL dialect.
 * Entities are plain data: timestamps are `Date`, no ORM types leak through.
 */

export const DEFAULT_CHECK_RETENTION_DAYS = 90;
/** Hourly rollups are tiny (one row per monitor-hour) so they outlive the raw rows. */
export const ROLLUP_RETENTION_DAYS = 400;
/** Push devices not re-registered for this long are dropped by housekeeping. */
export const PUSH_DEVICE_STALE_DAYS = 180;
export const DEFAULT_ALERT_LOG_DAYS = 30;

export type MonitorType = "http" | "tcp" | "dns" | "heartbeat" | "postgres" | "mysql" | "redis";
export type MonitorStatus = "pending" | "up" | "degraded" | "down" | "paused";
export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";
export type IncidentSeverity = "minor" | "major";
export type ChannelType = "email" | "slack" | "telegram" | "webhook" | "pagerduty" | "lark" | "push";

/** Project ids a limited API key may touch; `null` = no limit (sessions and unrestricted keys). */
export type Scope = string[] | null;

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  createdAt: Date;
  reminderIntervalMin: number | null;
  reminderEmail: boolean;
  escalation: EscalationStep[];
}
/** One escalation level: these channels are alerted when the incident is still unacknowledged `escalateAfterMin` minutes after it started. */
export interface EscalationStep {
  channelIds: string[];
  escalateAfterMin: number;
}
export type ProjectAlerting = Pick<Project, "reminderIntervalMin" | "reminderEmail" | "escalation">;
/** Repeats stop after this many, whatever the interval. */
export const MAX_REMINDERS = 10;
export const REMINDER_INTERVALS = [5, 10, 15, 30, 60] as const;

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
  /** while that monitor is down, this one opens no incidents and sends no alerts */
  dependsOnMonitorId: string | null;
  /** several regions: how many must fail before the monitor goes down; 0 = a majority of those that answered */
  minRegionsFailing: number;
  createdAt: Date;
}

/** Fields a user can set when creating a monitor. */
export type MonitorInput = Pick<
  Monitor,
  | "name" | "type" | "target" | "method" | "expectedStatus" | "intervalSec" | "timeoutMs" | "failureThreshold" | "regions"
  | "keyword" | "keywordMode" | "headers" | "graceSec" | "channelIds" | "tags" | "slowThresholdMs" | "slowAlertAfter"
  | "dependsOnMonitorId" | "minRegionsFailing"
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
/** `region` is where the check ran from (default `auto`: the scheduler's own location). */
export type NewCheck = { monitorId: string; ok: boolean; statusCode?: number | null; latencyMs?: number | null; error?: string | null; region?: string };
/** One region's result of a run that was checked from several. */
export type RegionResult = { region: string; ok: boolean; statusCode?: number | null; latencyMs?: number | null; error?: string | null };

/** A monitor's last day from one region, for the regions it has been checked from. */
export interface RegionStat {
  region: string;
  checks24h: number;
  uptime24h: number | null;
  avgLatency24h: number | null;
  /** the most recent result from this region */
  last: Pick<CheckResult, "ok" | "statusCode" | "latencyMs" | "error" | "checkedAt"> | null;
}

export interface MonitorDetail {
  results: CheckResult[];
  incidents: Incident[];
  stats: { uptime24h: number | null; uptime7d: number | null; avg24h: number | null; p95: number | null };
  /** per-region view of the last day; empty until a result exists */
  regionStats: RegionStat[];
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
  /** why an automatic incident opened or was reopened, in a few words */
  evaluationNote: string | null;
  nextReminderAt: Date | null;
  reminderCount: number;
  escalationLevel: number;
  nextEscalationAt: Date | null;
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
  evaluationNote?: string | null;
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
  /** incident.opened | incident.resolved | incident.reminder | incident.escalated | incident.muted | test | subscribers */
  kind: string;
  incidentId: string | null;
  monitorName: string | null;
  ok: boolean;
  error: string | null;
  /** null on rows written before delivery states existed; read those through `ok` */
  status: DeliveryStatus | null;
  /** the reason in words, e.g. "failed: HTTP 500", "skipped: channel disabled" */
  statusMessage: string | null;
  claimedAt: Date | null;
  /** when the incident was acknowledged after this alert went out */
  acknowledgedAt: Date | null;
  /** how many times delivery was tried (failed incident alerts are retried a few times) */
  attempts: number;
  createdAt: Date;
}
export type DeliveryStatus = "pending" | "sending" | "sent" | "failed" | "skipped";
export type NewDelivery = Omit<AlertDelivery, "id" | "createdAt" | "attempts" | "projectId" | "channelId" | "incidentId" | "monitorName" | "error" | "status" | "statusMessage" | "claimedAt" | "acknowledgedAt"> &
  Partial<Pick<AlertDelivery, "projectId" | "channelId" | "incidentId" | "monitorName" | "error" | "status" | "statusMessage">>;

/** A repeat alert whose claim this worker won: the incident, its monitor and the project's settings. */
export interface ReminderDue {
  incident: Incident;
  monitor: Monitor;
  project: ProjectAlerting;
  /** which repeat this is, starting at 1 */
  number: number;
}
export interface EscalationDue {
  incident: Incident;
  monitor: Monitor;
  step: EscalationStep;
  /** which level this is, starting at 1 */
  level: number;
}

export interface DeliveryRetry {
  delivery: AlertDelivery;
  incident: Incident;
  monitor: Monitor;
  channel: AlertChannel;
}

export interface WorkspaceSettings {
  alertLogRetentionDays: number;
  checkRetentionDays: number;
  /** email the owners a summary of the previous month */
  monthlyReport: boolean;
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
  /** the owner asked to leave OpenUptime's name and mark off the page and its mails (only honoured where the plan allows it) */
  hideBranding: boolean;
  /** uptime bars: green at or above `uptimeOkPct`, amber at or above `uptimeWarnPct`, red below (percent) */
  uptimeOkPct: number;
  uptimeWarnPct: number;
  /** the public MCP tools may serve this page */
  mcpEnabled: boolean;
  /** hours before maintenance starts that subscribers are reminded; 0 = never */
  maintenanceReminderHours: number;
  createdAt: Date;
}
export type NewStatusPage = { slug: string; title: string; theme?: string; showLatency?: boolean; externalUrl?: string | null; hideBranding?: boolean };
export type StatusPagePatch = Partial<Pick<StatusPage, "title" | "theme" | "showLatency" | "externalUrl" | "hideBranding" | "uptimeOkPct" | "uptimeWarnPct" | "mcpEnabled" | "maintenanceReminderHours">>;
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
  /** the page asks to hide OpenUptime's branding; the plan decides whether that is honoured */
  hideBranding: boolean;
  /** components the subscriber chose; empty = everything on the page */
  monitorIds: string[];
}

/** A maintenance window whose subscribers are due a reminder; the reminder was claimed for the caller alone. */
export interface MaintenanceReminder {
  window: MaintenanceWindow;
  page: StatusPage;
  subscribers: SubscriberTarget[];
}

/** One component's month, for the monthly report. */
export interface MonthlyComponent {
  name: string;
  /** percent, null when nothing was checked */
  uptime: number | null;
  downtimeMinutes: number;
  incidents: number;
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
export interface PushDevice {
  id: string;
  userId: string;
  token: string;
  platform: string;
  environment: "sandbox" | "production";
  locale: string | null;
  name: string | null;
  /** the person opted in to critical alerts for this device */
  critical: boolean;
  createdAt: Date;
  lastSeenAt: Date;
}
/** `critical` left out keeps the stored value (false for a new device). */
export type NewPushDevice = Pick<PushDevice, "token" | "platform" | "environment"> & { locale?: string | null; name?: string | null; critical?: boolean };

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
  /**
   * Store one raw result per region of a run checked from several, and fold the run into the hourly rollup once, as
   * `summary` (the verdict across regions), so uptime counts runs and not regions.
   */
  recordRegionResults(monitorId: string, results: RegionResult[], summary: { ok: boolean; latencyMs?: number | null }): Promise<void>;
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
  /**
   * Reopens the monitor's automatic outage incident that was resolved at or after `since` (the latest one), appending
   * `body` as an update and replacing its evaluation note. Null when there is none, or when another check reopened it first.
   */
  reopenIncident(monitorId: string, since: Date, body: string, evaluationNote: string): Promise<Incident | null>;
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
  /** Registers a device for the user; a token that belonged to someone else moves to this user. */
  upsertPushDevice(userId: string, d: NewPushDevice): Promise<PushDevice>;
  listPushDevices(userId: string): Promise<PushDevice[]>;
  /** Removes the user's own device; false when they have no such token. */
  deletePushDevice(userId: string, token: string): Promise<boolean>;
  /** Devices of every member of the workspace. */
  pushDevicesForOrganization(orgId: string): Promise<PushDevice[]>;
  /** APNs said the token is dead: forget it, whoever owns it. */
  deletePushDeviceByToken(token: string): Promise<void>;
  /** Workspaces where the user is owner or admin and that have no push channel yet. */
  managedOrgsWithoutPushChannel(userId: string): Promise<string[]>;
  /** Channels to alert; with `withDisabled` the switched-off ones are listed too, so the skip can be recorded. */
  channelsToAlert(orgId: string, o: { channelIds: string[]; projectId?: string | null; withDisabled?: boolean }): Promise<AlertChannel[]>;
  /** Write rows that are already final (skipped, muted, test). Best effort. */
  logDeliveries(rows: NewDelivery[]): Promise<void>;
  /** Write rows as `pending`, ready to be claimed; returns the rows that were stored (none when the log is unavailable). */
  queueDeliveries(rows: NewDelivery[]): Promise<AlertDelivery[]>;
  /** One conditional UPDATE: pending -> sending. Null when another worker holds the row or it is not due. */
  claimDelivery(id: string): Promise<AlertDelivery | null>;
  /**
   * Close a claimed row. `retryInSec` puts a failed row back to pending for another attempt; null leaves it failed.
   * Only a row still in `sending` is touched, so a late finisher cannot overwrite a sweep's decision.
   */
  finishDelivery(id: string, r: { status: "sent" | "failed" | "skipped"; error: string | null; message: string | null; retryInSec?: number | null }): Promise<void>;
  /** Claim failed incident alerts that are due a retry (a few attempts, with backoff). */
  claimRetries(limit: number): Promise<DeliveryRetry[]>;
  /** Housekeeping: hand rows stuck in `sending` back to pending, or fail them after `maxAttempts`. Returns how many moved. */
  sweepStuckDeliveries(o: { stuckSec: number; maxAttempts: number }): Promise<number>;
  /** All alerts of one incident, oldest first. */
  incidentDeliveries(orgId: string, incidentId: string): Promise<AlertDelivery[]>;
  channelsByIds(orgId: string, ids: string[]): Promise<AlertChannel[]>;
  /** Start the incident's repeat and escalation clocks from the project's settings. */
  scheduleFollowUps(incident: Pick<Incident, "id" | "startedAt">, projectId: string | null): Promise<void>;
  /** Claim up to `limit` repeats that are due; each is returned to exactly one caller, and only the latest missed one is sent. */
  claimReminders(limit: number): Promise<ReminderDue[]>;
  claimEscalations(limit: number): Promise<EscalationDue[]>;
  getProjectAlerting(orgId: string, projectId: string): Promise<ProjectAlerting | null>;
  saveProjectAlerting(orgId: string, projectId: string, v: ProjectAlerting): Promise<ProjectAlerting | null>;
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
  /**
   * Adds the address, or finds the row it already has. `token` is the stored one (the given token only for a new row);
   * a pending row takes the new locale and component choice, a confirmed one is left alone.
   */
  addSubscriber(s: { pageId: string; email: string; token: string; locale: string; monitorIds?: string[] }): Promise<{ locale: string | null; token: string; confirmed: boolean; created: boolean }>;
  /** Maintenance windows touching the page (its monitors', plus workspace-wide ones) that end after `since`, newest start first. */
  pageMaintenance(page: StatusPage, o: { since?: Date; limit: number }): Promise<MaintenanceWindow[]>;
  /** Windows that start within their page's reminder lead time, each claimed once per page; claimed rows come back with their subscribers. */
  claimMaintenanceReminders(limit: number): Promise<MaintenanceReminder[]>;
  /** Workspaces that want a report for `month` (YYYY-MM) and had none yet; each is claimed once. */
  claimMonthlyReports(month: string, limit: number): Promise<string[]>;
  /** Per-component uptime, downtime and incident count between the two instants. */
  monthlyReport(orgId: string, from: Date, to: Date): Promise<MonthlyComponent[]>;
  /** Emails and locales of the workspace owners. */
  ownerContacts(orgId: string): Promise<{ email: string; locale: string | null }[]>;
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
