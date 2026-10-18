import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth-schema";

export const monitorType = pgEnum("monitor_type", ["http", "tcp", "dns", "heartbeat", "postgres", "mysql", "redis"]);
export const monitorStatus = pgEnum("monitor_status", ["pending", "up", "degraded", "down", "paused"]);
export const incidentStatus = pgEnum("incident_status", ["investigating", "identified", "monitoring", "resolved"]);
export const incidentSeverity = pgEnum("incident_severity", ["minor", "major"]);
export const channelType = pgEnum("channel_type", ["email", "slack", "telegram", "webhook", "pagerduty", "lark", "push"]);

/** A project groups monitors, status pages, channels and maintenance inside one workspace (organization). */
export const project = pgTable(
  "project",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Repeat a push alert every N minutes until the incident is acknowledged or resolved; null = off. */
    reminderIntervalMin: integer("reminder_interval_min"),
    /** Whether repeats also go to email channels (push channels always get them when repeats are on). */
    reminderEmail: boolean("reminder_email").notNull().default(false),
    /** Ordered escalation steps: [{ channelIds, escalateAfterMin }], minutes counted from the start of the incident. */
    escalation: jsonb("escalation").$type<{ channelIds: string[]; escalateAfterMin: number }[]>().notNull().default([]),
  },
  (t) => [index("project_org_idx").on(t.organizationId)],
);

const projectRef = () => uuid("project_id").references(() => project.id, { onDelete: "cascade" });

export const monitor = pgTable(
  "monitor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    projectId: projectRef(),
    name: text("name").notNull(),
    type: monitorType("type").notNull().default("http"),
    /** URL for http, host:port for tcp / postgres / mysql / redis, hostname for dns. */
    target: text("target").notNull(),
    method: text("method").notNull().default("GET"),
    expectedStatus: integer("expected_status").notNull().default(200),
    intervalSec: integer("interval_sec").notNull().default(60),
    timeoutMs: integer("timeout_ms").notNull().default(10000),
    /** consecutive failures before an incident is opened */
    failureThreshold: integer("failure_threshold").notNull().default(3),
    regions: text("regions").array().notNull().default(["auto"]),
    status: monitorStatus("status").notNull().default("pending"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
    /** due time the claim of the run that started last had assigned; a redelivered queue message carries the same one */
    lastRunToken: timestamp("last_run_token", { withTimezone: true }),
    paused: boolean("paused").notNull().default(false),
    heartbeatToken: text("heartbeat_token"),
    /** http: response body must contain (or, with keywordMode "absent", must not contain) this text */
    keyword: text("keyword"),
    keywordMode: text("keyword_mode").notNull().default("contains"),
    /** http: extra request headers (also used for bearer / basic auth) */
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    /** heartbeat: how long after the expected ping we wait before declaring it missed */
    graceSec: integer("grace_sec").notNull().default(0),
    /** alert only these channels; empty = every enabled channel in the org */
    channelIds: uuid("channel_ids").array().notNull().default([]),
    /** free-form labels for grouping and filtering */
    tags: text("tags").array().notNull().default([]),
    /** a successful check slower than this marks the monitor "degraded" */
    slowThresholdMs: integer("slow_threshold_ms").notNull().default(1500),
    /** open a "slow" incident after this many consecutive slow checks; 0 = never alert on latency */
    slowAlertAfter: integer("slow_alert_after").notNull().default(0),
    consecutiveSlow: integer("consecutive_slow").notNull().default(0),
    /** while this monitor is down, a failure of this one opens no incident and sends no alert (same project, never a cycle) */
    dependsOnMonitorId: uuid("depends_on_monitor_id").references((): AnyPgColumn => monitor.id, { onDelete: "set null" }),
    /** several regions: this many must fail before the monitor goes down; 0 = a majority of the regions that answered */
    minRegionsFailing: integer("min_regions_failing").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("monitor_org_idx").on(t.organizationId), index("monitor_due_idx").on(t.nextCheckAt)],
);

export const checkResult = pgTable(
  "check_result",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    monitorId: uuid("monitor_id").notNull().references(() => monitor.id, { onDelete: "cascade" }),
    region: text("region").notNull().default("auto"),
    ok: boolean("ok").notNull(),
    statusCode: integer("status_code"),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("check_result_monitor_time_idx").on(t.monitorId, t.checkedAt)],
);

/** Pre-aggregated check results per monitor and hour: uptime and latency stats read this instead of scanning check_result. */
export const checkRollup = pgTable(
  "check_rollup",
  {
    monitorId: uuid("monitor_id").notNull().references(() => monitor.id, { onDelete: "cascade" }),
    bucket: timestamp("bucket", { withTimezone: true }).notNull(),
    total: integer("total").notNull().default(0),
    ok: integer("ok").notNull().default(0),
    latencySum: bigint("latency_sum", { mode: "number" }).notNull().default(0),
    latencyN: integer("latency_n").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.monitorId, t.bucket] })],
);

export const incident = pgTable(
  "incident",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    monitorId: uuid("monitor_id").references(() => monitor.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    status: incidentStatus("status").notNull().default("investigating"),
    severity: incidentSeverity("severity").notNull().default("major"),
    auto: boolean("auto").notNull().default(false),
    assigneeId: text("assignee_id").references(() => user.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** short human-readable reason an automatic incident opened or was reopened ("3 of 3 regions failed") */
    evaluationNote: text("evaluation_note"),
    /** When the next repeat alert is due; null once acknowledged, resolved, capped or when repeats are off. */
    nextReminderAt: timestamp("next_reminder_at", { withTimezone: true }),
    reminderCount: integer("reminder_count").notNull().default(0),
    /** How many escalation steps have fired, and when the next one is due (null = none left). */
    escalationLevel: integer("escalation_level").notNull().default(0),
    nextEscalationAt: timestamp("next_escalation_at", { withTimezone: true }),
  },
  (t) => [
    index("incident_org_idx").on(t.organizationId, t.startedAt),
    // at most one open automatic outage and one open automatic latency incident per monitor, even when two checks race
    uniqueIndex("incident_open_auto_idx")
      .on(t.monitorId, sql`(${t.severity} = 'minor')`)
      .where(sql`${t.auto} and ${t.resolvedAt} is null and ${t.monitorId} is not null`),
  ],
);

export const incidentUpdate = pgTable("incident_update", {
  id: uuid("id").primaryKey().defaultRandom(),
  incidentId: uuid("incident_id").notNull().references(() => incident.id, { onDelete: "cascade" }),
  status: incidentStatus("status").notNull(),
  body: text("body").notNull(),
  authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const alertChannel = pgTable("alert_channel", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  projectId: projectRef(),
  type: channelType("type").notNull(),
  name: text("name").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  /** New monitors (of the channel's project, or of every project for a workspace-wide channel) start out alerting this channel. */
  autoEnable: boolean("auto_enable").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A phone registered for push alerts. Belongs to a user, not to a channel: a `push` channel reaches every member's devices. */
export const pushDevice = pgTable(
  "push_device",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    /** the APNs device token (hex); one device is one row, whoever registered it last owns it */
    token: text("token").notNull(),
    platform: text("platform").notNull().default("ios"),
    /** sandbox | production: which APNs host the token belongs to */
    environment: text("environment").notNull().default("production"),
    locale: text("locale"),
    name: text("name"),
    /** opted in to critical alerts: a "down" push may break through Do Not Disturb */
    critical: boolean("critical").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("push_device_token_idx").on(t.token), index("push_device_user_idx").on(t.userId)],
);

/** One row per attempt to notify a channel (or the subscribers of a status page), kept for the workspace's retention window. */
export const alertDelivery = pgTable(
  "alert_delivery",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    projectId: projectRef(),
    /** no foreign key: the log outlives a removed channel, so the name and type are snapshotted */
    channelId: uuid("channel_id"),
    channelName: text("channel_name").notNull(),
    channelType: text("channel_type").notNull(),
    /** incident.opened | incident.resolved | test | subscribers */
    kind: text("kind").notNull(),
    incidentId: uuid("incident_id"),
    monitorName: text("monitor_name"),
    ok: boolean("ok").notNull(),
    error: text("error"),
    /** pending | sending | sent | failed | skipped; null on rows written before delivery states existed */
    status: text("status").$type<"pending" | "sending" | "sent" | "failed" | "skipped">(),
    /** human reason shown next to the status, e.g. "failed: HTTP 500" or "skipped: channel disabled" */
    statusMessage: text("status_message"),
    /** set when a worker took the row (pending -> sending); a row stuck in sending is handed back after a few minutes */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** set when the incident was acknowledged after this alert went out */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(1),
    /** set while a failed incident alert is waiting for another attempt */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("alert_delivery_org_time_idx").on(t.organizationId, t.createdAt), index("alert_delivery_retry_idx").on(t.nextAttemptAt), index("alert_delivery_status_idx").on(t.status, t.claimedAt), index("alert_delivery_incident_idx").on(t.incidentId)],
);

/** Per-workspace preferences; a missing row means defaults. */
export const workspaceSetting = pgTable("workspace_setting", {
  organizationId: text("organization_id").primaryKey().references(() => organization.id, { onDelete: "cascade" }),
  alertLogRetentionDays: integer("alert_log_retention_days").notNull().default(30),
  /** raw check results older than this are deleted (hourly rollups are kept for a year regardless) */
  checkRetentionDays: integer("check_retention_days").notNull().default(90),
  /** opt-in: email the owners a summary of the previous month on the first days of each month */
  monthlyReport: boolean("monthly_report").notNull().default(false),
  /** the month (YYYY-MM) a report was last claimed for, so each month is sent once */
  lastReportMonth: text("last_report_month"),
});

/** While a window is active, monitors it covers keep being checked but open no incidents and send no alerts. */
export const maintenanceWindow = pgTable(
  "maintenance_window",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    projectId: projectRef(),
    name: text("name").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    /** empty = all monitors in the org */
    monitorIds: uuid("monitor_ids").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("maintenance_org_idx").on(t.organizationId, t.startsAt)],
);

export const statusPage = pgTable(
  "status_page",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    projectId: projectRef(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    customDomain: text("custom_domain"),
    theme: text("theme").notNull().default("light"),
    showLatency: boolean("show_latency").notNull().default(true),
    externalUrl: text("external_url"),
    hideBranding: boolean("hide_branding").notNull().default(false),
    /** uptime bars are green at or above this percentage, amber at or above `uptimeWarnPct`, red below */
    uptimeOkPct: doublePrecision("uptime_ok_pct").notNull().default(99.9),
    uptimeWarnPct: doublePrecision("uptime_warn_pct").notNull().default(98),
    /** whether the public MCP tools may serve this page */
    mcpEnabled: boolean("mcp_enabled").notNull().default(true),
    /** subscribers get a reminder this many hours before maintenance starts; 0 turns it off */
    maintenanceReminderHours: integer("maintenance_reminder_hours").notNull().default(24),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("status_page_slug_idx").on(t.slug)],
);

/** Fixed-window counters for public endpoints; shared across Worker isolates via Postgres. */
export const rateLimit = pgTable("rate_limit", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
  count: integer("count").notNull().default(0),
});

export const statusSubscriber = pgTable(
  "status_subscriber",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    statusPageId: uuid("status_page_id").notNull().references(() => statusPage.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    /** doubles as the confirm and unsubscribe secret */
    token: text("token").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /** language of the subscribe request, used for the emails they get */
    locale: text("locale"),
    /** components (monitors) the subscriber wants mail about; empty = all of the page */
    monitorIds: uuid("monitor_ids").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("status_subscriber_page_email_idx").on(t.statusPageId, t.email), uniqueIndex("status_subscriber_token_idx").on(t.token)],
);

/** One row per maintenance window and status page whose subscribers were reminded; inserting it first is the claim. */
export const maintenanceReminder = pgTable(
  "maintenance_reminder",
  {
    maintenanceId: uuid("maintenance_id").notNull().references(() => maintenanceWindow.id, { onDelete: "cascade" }),
    statusPageId: uuid("status_page_id").notNull().references(() => statusPage.id, { onDelete: "cascade" }),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.maintenanceId, t.statusPageId] })],
);

export const statusPageComponent = pgTable("status_page_component", {
  id: uuid("id").primaryKey().defaultRandom(),
  statusPageId: uuid("status_page_id").notNull().references(() => statusPage.id, { onDelete: "cascade" }),
  monitorId: uuid("monitor_id").notNull().references(() => monitor.id, { onDelete: "cascade" }),
  groupName: text("group_name").notNull().default("Services"),
  position: integer("position").notNull().default(0),
  visible: boolean("visible").notNull().default(true),
});

export const monitorRelations = relations(monitor, ({ many }) => ({
  results: many(checkResult),
  incidents: many(incident),
}));
export const checkResultRelations = relations(checkResult, ({ one }) => ({
  monitor: one(monitor, { fields: [checkResult.monitorId], references: [monitor.id] }),
}));
export const incidentRelations = relations(incident, ({ one, many }) => ({
  monitor: one(monitor, { fields: [incident.monitorId], references: [monitor.id] }),
  updates: many(incidentUpdate),
}));
export const incidentUpdateRelations = relations(incidentUpdate, ({ one }) => ({
  incident: one(incident, { fields: [incidentUpdate.incidentId], references: [incident.id] }),
}));
export const statusPageRelations = relations(statusPage, ({ many }) => ({ components: many(statusPageComponent) }));
export const statusPageComponentRelations = relations(statusPageComponent, ({ one }) => ({
  page: one(statusPage, { fields: [statusPageComponent.statusPageId], references: [statusPage.id] }),
  monitor: one(monitor, { fields: [statusPageComponent.monitorId], references: [monitor.id] }),
}));
