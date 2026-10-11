import {
  DEFAULT_ALERT_LOG_DAYS,
  DEFAULT_CHECK_RETENTION_DAYS,
  ROLLUP_RETENTION_DAYS,
  type DeliveryRetry,
  type IncidentWithUpdates,
  type Repo,
  type Scope,
} from "@openuptime/repo";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "./client";
import * as schema from "./schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `col in (scope)` for a limited API key, nothing otherwise; spread into `and(...)`. */
const inScope = (scope: Scope, col: Parameters<typeof inArray>[0]): SQL | undefined => (scope ? inArray(col, scope) : undefined);

/** Postgres implementation of the storage contract, on drizzle + postgres.js. */
export function createRepo(db: Db): Repo {
  const rows = async <T>(q: PromiseLike<unknown>) => (await q) as unknown as T[];

  async function ensureDefaultProject(orgId: string) {
    return db.transaction(async (tx) => {
      // serialise first-use creation so parallel first requests end up with exactly one project
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"project:" + orgId}))`);
      const [first] = await tx.select({ id: schema.project.id }).from(schema.project).where(eq(schema.project.organizationId, orgId)).orderBy(asc(schema.project.createdAt)).limit(1);
      if (first) return first.id;
      const [created] = await tx.insert(schema.project).values({ organizationId: orgId, name: "Default" }).returning({ id: schema.project.id });
      return created.id;
    });
  }

  async function pageMonitorIds(pageId: string) {
    const r = await db
      .select({ id: schema.statusPageComponent.monitorId })
      .from(schema.statusPageComponent)
      .where(and(eq(schema.statusPageComponent.statusPageId, pageId), eq(schema.statusPageComponent.visible, true)));
    return r.map((x) => x.id);
  }

  /** Incidents shown on a page: those of its own monitors, plus workspace-level ones not tied to a monitor. */
  function pageScope(orgId: string, monitorIds: string[]) {
    return and(
      eq(schema.incident.organizationId, orgId),
      monitorIds.length ? or(isNull(schema.incident.monitorId), inArray(schema.incident.monitorId, monitorIds)) : isNull(schema.incident.monitorId),
    );
  }

  async function withUpdates(list: (typeof schema.incident.$inferSelect)[]): Promise<IncidentWithUpdates[]> {
    const ids = list.map((i) => i.id);
    const updates = ids.length
      ? await db.select().from(schema.incidentUpdate).where(inArray(schema.incidentUpdate.incidentId, ids)).orderBy(desc(schema.incidentUpdate.createdAt))
      : [];
    return list.map((i) => ({ ...i, updates: updates.filter((u) => u.incidentId === i.id) }));
  }

  const repo: Repo = {
    // ── workspaces, users, projects ────────────────────────────────────────────
    async isMember(userId, orgId) {
      const [ok] = await db
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(and(eq(schema.member.userId, userId), eq(schema.member.organizationId, orgId)))
        .limit(1);
      return !!ok;
    },
    async hasPendingInvitation(email) {
      const [row] = await db
        .select({ id: schema.invitation.id })
        .from(schema.invitation)
        .where(and(sql`lower(${schema.invitation.email}) = ${email.trim().toLowerCase()}`, eq(schema.invitation.status, "pending"), gte(schema.invitation.expiresAt, new Date())))
        .limit(1);
      return !!row;
    },
    async memberRole(userId, orgId) {
      const [m] = await db
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(and(eq(schema.member.userId, userId), eq(schema.member.organizationId, orgId)))
        .limit(1);
      return m?.role ?? null;
    },
    async anyWorkspaceOf(userId) {
      const [m] = await db.select({ id: schema.member.organizationId }).from(schema.member).where(eq(schema.member.userId, userId)).limit(1);
      return m?.id ?? null;
    },
    async hasOAuthConsent(userId, clientId) {
      const [row] = await db
        .select({ id: schema.oauthConsent.id })
        .from(schema.oauthConsent)
        .where(and(eq(schema.oauthConsent.userId, userId), eq(schema.oauthConsent.clientId, clientId)))
        .limit(1);
      return !!row;
    },
    async ensureOAuthResource(identifier, name, scopes) {
      const now = new Date();
      await db
        .insert(schema.oauthResource)
        .values({ id: crypto.randomUUID(), identifier, name, allowedScopes: scopes, createdAt: now, updatedAt: now })
        .onConflictDoNothing({ target: schema.oauthResource.identifier });
    },
    async workspacesOf(userId) {
      return db
        .select({ id: schema.organization.id, name: schema.organization.name })
        .from(schema.member)
        .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
        .where(eq(schema.member.userId, userId));
    },
    async organization(orgId) {
      const [o] = await db.select().from(schema.organization).where(eq(schema.organization.id, orgId));
      return o ?? null;
    },
    async userProfile(userId) {
      const [u] = await db
        .select({ name: schema.user.name, email: schema.user.email, locale: schema.user.locale, emailVerified: schema.user.emailVerified, twoFactorEnabled: schema.user.twoFactorEnabled })
        .from(schema.user)
        .where(eq(schema.user.id, userId));
      return u ?? null;
    },
    async setUserLocale(userId, locale) {
      await db.update(schema.user).set({ locale }).where(eq(schema.user.id, userId));
    },
    async localeByEmail(email) {
      const [u] = await db.select({ locale: schema.user.locale }).from(schema.user).where(eq(schema.user.email, email.toLowerCase())).limit(1);
      return u?.locale ?? null;
    },
    async ownerLocale(orgId) {
      const [r] = await db
        .select({ locale: schema.user.locale })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")))
        .limit(1);
      return r?.locale ?? null;
    },
    async exportAccount(uid) {
      const [u] = await db.select().from(schema.user).where(eq(schema.user.id, uid));
      const memberships = await db
        .select({ organizationId: schema.member.organizationId, role: schema.member.role, joinedAt: schema.member.createdAt, name: schema.organization.name })
        .from(schema.member)
        .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
        .where(eq(schema.member.userId, uid));
      const admin = memberships.filter((m) => m.role === "owner" || m.role === "admin").map((m) => m.organizationId);
      const q = <T>(s: SQL) => rows<T>(db.execute(s));
      const workspaces: unknown[] = [];
      for (const m of memberships) {
        const base = { id: m.organizationId, name: m.name, role: m.role, joinedAt: m.joinedAt };
        if (!admin.includes(m.organizationId)) { workspaces.push(base); continue; }
        const id = m.organizationId;
        workspaces.push({
          ...base,
          projects: await q(sql`select id, name, created_at from project where organization_id = ${id}`),
          monitors: await q(sql`select id, project_id, name, type, target, method, expected_status, interval_sec, timeout_ms, failure_threshold, keyword, keyword_mode, headers, tags, slow_threshold_ms, slow_alert_after, created_at from monitor where organization_id = ${id}`),
          channels: await q(sql`select id, project_id, name, type, config, enabled, created_at from alert_channel where organization_id = ${id}`),
          incidents: await q(sql`select id, monitor_id, title, status, severity, auto, started_at, resolved_at from incident where organization_id = ${id}`),
          statusPages: await q(sql`select id, project_id, slug, title, theme, created_at from status_page where organization_id = ${id}`),
          maintenanceWindows: await q(sql`select id, name, starts_at, ends_at from maintenance_window where organization_id = ${id}`),
          members: await q(sql`select u.name, u.email, m.role, m.created_at from member m join "user" u on u.id = m.user_id where m.organization_id = ${id}`),
        });
      }
      const sessions = await q(sql`select ip_address, user_agent, created_at, expires_at from session where user_id = ${uid}`);
      return {
        user: u ? { id: u.id, name: u.name, email: u.email, emailVerified: u.emailVerified, locale: u.locale, twoFactorEnabled: u.twoFactorEnabled, createdAt: u.createdAt } : null,
        sessions,
        workspaces,
      };
    },
    async counts(o, p) {
      const r = await rows<Record<string, number>>(db.execute(sql`select
        (select count(*)::int from monitor where organization_id = ${o} and project_id = ${p}) as monitors,
        (select count(*)::int from incident i left join monitor m on m.id = i.monitor_id
           where i.organization_id = ${o} and i.status <> 'resolved' and (m.project_id = ${p} or i.monitor_id is null)) as incidents,
        (select count(*)::int from status_page where organization_id = ${o} and project_id = ${p}) as "status-pages",
        (select count(*)::int from alert_channel where organization_id = ${o} and (project_id = ${p} or project_id is null)) as alerting`));
      return r[0] as never;
    },

    async ownedWorkspaces(userId) {
      const owned = await db
        .select({ id: schema.organization.id, name: schema.organization.name })
        .from(schema.member)
        .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
        .where(and(eq(schema.member.userId, userId), eq(schema.member.role, "owner")));
      const out = [];
      for (const o of owned) {
        const [n] = await db.select({ n: count() }).from(schema.member).where(eq(schema.member.organizationId, o.id));
        out.push({ ...o, members: n.n });
      }
      return out;
    },
    async deleteWorkspaces(ids) {
      for (const id of ids) await db.delete(schema.organization).where(eq(schema.organization.id, id));
    },
    async createPersonalWorkspace(w) {
      await db.insert(schema.organization).values({ id: w.id, name: w.name, slug: w.slug, createdAt: new Date() });
      await db.insert(schema.member).values({ id: crypto.randomUUID(), organizationId: w.id, userId: w.ownerId, role: "owner", createdAt: new Date() });
      await ensureDefaultProject(w.id);
    },
    async preferredWorkspace(userId) {
      const mine = await db
        .select({ organizationId: schema.member.organizationId })
        .from(schema.member)
        .where(eq(schema.member.userId, userId))
        .orderBy(desc(schema.member.createdAt));
      const [last] = await db
        .select({ organizationId: schema.session.activeOrganizationId })
        .from(schema.session)
        .where(eq(schema.session.userId, userId))
        .orderBy(desc(schema.session.createdAt))
        .limit(1);
      return (mine.find((x) => x.organizationId === last?.organizationId) ?? mine[0])?.organizationId ?? null;
    },

    listProjects: (orgId, scope) =>
      db
        .select({ id: schema.project.id, name: schema.project.name, createdAt: schema.project.createdAt })
        .from(schema.project)
        .where(and(eq(schema.project.organizationId, orgId), inScope(scope, schema.project.id)))
        .orderBy(asc(schema.project.createdAt)),
    async countProjects(orgId) {
      const [n] = await db.select({ n: count() }).from(schema.project).where(eq(schema.project.organizationId, orgId));
      return n.n;
    },
    async createProject(orgId, name) {
      const [row] = await db.insert(schema.project).values({ organizationId: orgId, name }).returning();
      return row;
    },
    async renameProject(orgId, id, name) {
      const [row] = await db
        .update(schema.project)
        .set({ name })
        .where(and(eq(schema.project.id, id), eq(schema.project.organizationId, orgId)))
        .returning();
      return row ?? null;
    },
    async deleteProject(orgId, id) {
      await db.delete(schema.project).where(and(eq(schema.project.id, id), eq(schema.project.organizationId, orgId)));
    },
    async resolveProject(orgId, wanted) {
      if (wanted && UUID.test(wanted)) {
        const [p] = await db
          .select({ id: schema.project.id })
          .from(schema.project)
          .where(and(eq(schema.project.id, wanted), eq(schema.project.organizationId, orgId)));
        if (p) return p.id;
      }
      const [first] = await db.select({ id: schema.project.id }).from(schema.project).where(eq(schema.project.organizationId, orgId)).orderBy(asc(schema.project.createdAt)).limit(1);
      return first ? first.id : ensureDefaultProject(orgId);
    },
    ensureDefaultProject,

    // ── monitors ───────────────────────────────────────────────────────────────
    async listMonitors(orgId, projectId) {
      const since = new Date(Date.now() - 864e5);
      const [list, series] = await Promise.all([
        db
          .select({
            m: schema.monitor,
            total: sql<number>`coalesce(sum(${schema.checkRollup.total}), 0)::int`,
            okCount: sql<number>`coalesce(sum(${schema.checkRollup.ok}), 0)::int`,
            avgLatency: sql<number | null>`round(sum(${schema.checkRollup.latencySum})::numeric / nullif(sum(${schema.checkRollup.latencyN}), 0))::int`,
          })
          .from(schema.monitor)
          .leftJoin(schema.checkRollup, and(eq(schema.checkRollup.monitorId, schema.monitor.id), gte(schema.checkRollup.bucket, since)))
          .where(and(eq(schema.monitor.organizationId, orgId), eq(schema.monitor.projectId, projectId)))
          .groupBy(schema.monitor.id)
          .orderBy(schema.monitor.name),
        // last 30 latency samples per monitor, for the list sparkline
        rows<{ monitor_id: string; latency_ms: number | null }>(
          db.execute(sql`
            select monitor_id, latency_ms from (
              select r.monitor_id, r.latency_ms, row_number() over (partition by r.monitor_id order by r.checked_at desc) rn
              from check_result r join monitor m on m.id = r.monitor_id
              where m.organization_id = ${orgId} and m.project_id = ${projectId} and r.checked_at >= ${since.toISOString()}::timestamptz
            ) x where rn <= 30 order by monitor_id, rn desc`),
        ),
      ]);
      const spark = new Map<string, (number | null)[]>();
      for (const r of series) (spark.get(r.monitor_id) ?? spark.set(r.monitor_id, []).get(r.monitor_id)!).push(r.latency_ms);
      return list.map(({ m, total, okCount, avgLatency }) => ({
        ...m,
        uptime24h: total ? Math.round((okCount / total) * 10000) / 100 : null,
        avgLatency24h: avgLatency,
        spark: spark.get(m.id) ?? [],
      }));
    },
    exportMonitors: (orgId, projectId) =>
      db
        .select()
        .from(schema.monitor)
        .where(and(eq(schema.monitor.organizationId, orgId), eq(schema.monitor.projectId, projectId)))
        .orderBy(schema.monitor.name),
    async getMonitor(orgId, id, scope) {
      const [m] = await db
        .select()
        .from(schema.monitor)
        .where(and(eq(schema.monitor.id, id), eq(schema.monitor.organizationId, orgId), inScope(scope, schema.monitor.projectId)));
      return m ?? null;
    },
    async monitorDetail(monitorId) {
      const day = new Date(Date.now() - 864e5).toISOString();
      const week = new Date(Date.now() - 7 * 864e5).toISOString();
      const [results, statRows, p95Rows, incidents] = await Promise.all([
        db.select().from(schema.checkResult).where(eq(schema.checkResult.monitorId, monitorId)).orderBy(desc(schema.checkResult.checkedAt)).limit(120),
        // uptime and averages come from the hourly rollup; only the p95 needs the raw rows of the last day
        rows<Record<string, number | null>>(
          db.execute(sql`select
            coalesce(sum(total) filter (where bucket >= ${day}::timestamptz), 0)::int as n24,
            coalesce(sum(ok) filter (where bucket >= ${day}::timestamptz), 0)::int as ok24,
            coalesce(sum(total), 0)::int as n7,
            coalesce(sum(ok), 0)::int as ok7,
            round(sum(latency_sum) filter (where bucket >= ${day}::timestamptz)::numeric / nullif(sum(latency_n) filter (where bucket >= ${day}::timestamptz), 0))::int as avg24
            from check_rollup where monitor_id = ${monitorId} and bucket >= ${week}::timestamptz`),
        ),
        rows<Record<string, number | null>>(
          db.execute(sql`select round((percentile_cont(0.95) within group (order by latency_ms))::numeric)::int as p95
            from check_result where monitor_id = ${monitorId} and checked_at >= ${day}::timestamptz`),
        ),
        db.select().from(schema.incident).where(eq(schema.incident.monitorId, monitorId)).orderBy(desc(schema.incident.startedAt)).limit(5),
      ]);
      const st = { ...(statRows[0] ?? {}), ...(p95Rows[0] ?? {}) };
      const pct = (ok: number | null, n: number | null) => (n ? Math.round(((ok ?? 0) / n) * 10000) / 100 : null);
      return {
        results,
        incidents,
        stats: { uptime24h: pct(st.ok24, st.n24), uptime7d: pct(st.ok7, st.n7), avg24h: st.avg24 ?? null, p95: st.p95 ?? null },
      };
    },
    async createMonitor(orgId, projectId, input) {
      const [row] = await db.insert(schema.monitor).values({ ...input, organizationId: orgId, projectId }).returning();
      return row;
    },
    async createMonitors(orgId, projectId, inputs) {
      if (inputs.length) await db.insert(schema.monitor).values(inputs.map((v) => ({ ...v, organizationId: orgId, projectId })));
    },
    async updateMonitor(orgId, id, scope, patch) {
      const [row] = await db
        .update(schema.monitor)
        .set(patch)
        .where(and(eq(schema.monitor.id, id), eq(schema.monitor.organizationId, orgId), inScope(scope, schema.monitor.projectId)))
        .returning();
      return row ?? null;
    },
    async deleteMonitor(orgId, id, scope) {
      await db.delete(schema.monitor).where(and(eq(schema.monitor.id, id), eq(schema.monitor.organizationId, orgId), inScope(scope, schema.monitor.projectId)));
    },
    async ownedMonitorIds(orgId, ids, scope) {
      if (!ids.length) return [];
      const r = await db
        .select({ id: schema.monitor.id })
        .from(schema.monitor)
        .where(and(eq(schema.monitor.organizationId, orgId), inArray(schema.monitor.id, ids), inScope(scope, schema.monitor.projectId)));
      return r.map((m) => m.id);
    },
    async monitorByHeartbeatToken(token) {
      const [m] = await db.select().from(schema.monitor).where(eq(schema.monitor.heartbeatToken, token));
      return m ?? null;
    },

    // ── checking ───────────────────────────────────────────────────────────────
    claimDue: (limit) =>
      db
        .update(schema.monitor)
        // advance from the scheduled time, so finishing a check late never pushes the next one past a whole cron tick;
        // a monitor that is far behind (paused, outage of the scheduler) restarts from now instead of catching up in a burst
        .set({
          nextCheckAt: sql`case when ${schema.monitor.nextCheckAt} + make_interval(secs => ${schema.monitor.intervalSec}) > now()
            then ${schema.monitor.nextCheckAt} + make_interval(secs => ${schema.monitor.intervalSec})
            else now() + make_interval(secs => ${schema.monitor.intervalSec}) end`,
        })
        .where(
          inArray(
            schema.monitor.id,
            // SKIP LOCKED: overlapping cron runs (or several workers) never pick up the same monitor
            sql`(select id from monitor where paused = false and next_check_at <= now() order by next_check_at limit ${limit} for update skip locked)`,
          ),
        )
        .returning(),
    async monitorsByIds(ids) {
      return ids.length ? db.select().from(schema.monitor).where(inArray(schema.monitor.id, ids)) : [];
    },
    async beginRuns(runs) {
      // one conditional update per monitor: the row lock makes concurrent duplicates take turns, and only the first sees the old token
      const started = await Promise.all(
        runs.map(async ({ id, token }) => {
          const won = await db
            .update(schema.monitor)
            .set({ lastRunToken: token })
            .where(and(eq(schema.monitor.id, id), or(isNull(schema.monitor.lastRunToken), sql`${schema.monitor.lastRunToken} <> ${token.toISOString()}::timestamptz`)))
            .returning({ id: schema.monitor.id });
          return won.length ? id : null;
        }),
      );
      return started.filter((id): id is string => id !== null);
    },
    async releaseClaims(runs) {
      await Promise.all(
        runs.map(({ id, token }) =>
          db
            .update(schema.monitor)
            .set({ nextCheckAt: sql`now()` })
            // the stored time has microseconds, the token (a JS date) milliseconds
            .where(and(eq(schema.monitor.id, id), sql`date_trunc('milliseconds', ${schema.monitor.nextCheckAt}) = ${token.toISOString()}::timestamptz`)),
        ),
      );
    },
    async recordCheck(r) {
      await db.insert(schema.checkResult).values({ monitorId: r.monitorId, ok: r.ok, statusCode: r.statusCode, latencyMs: r.latencyMs, error: r.error });
      const lat = r.latencyMs ?? null;
      await db
        .insert(schema.checkRollup)
        .values({
          monitorId: r.monitorId,
          bucket: sql`date_trunc('hour', now())`,
          total: 1,
          ok: r.ok ? 1 : 0,
          latencySum: lat ?? 0,
          latencyN: lat == null ? 0 : 1,
        })
        .onConflictDoUpdate({
          target: [schema.checkRollup.monitorId, schema.checkRollup.bucket],
          set: {
            total: sql`${schema.checkRollup.total} + 1`,
            ok: sql`${schema.checkRollup.ok} + ${r.ok ? 1 : 0}`,
            latencySum: sql`${schema.checkRollup.latencySum} + ${lat ?? 0}`,
            latencyN: sql`${schema.checkRollup.latencyN} + ${lat == null ? 0 : 1}`,
          },
        });
    },
    async setMonitorState(id, state) {
      await db.update(schema.monitor).set(state).where(eq(schema.monitor.id, id));
    },
    async underMaintenance(m) {
      const now = new Date();
      const [w] = await db
        .select({ id: schema.maintenanceWindow.id })
        .from(schema.maintenanceWindow)
        .where(
          and(
            eq(schema.maintenanceWindow.organizationId, m.organizationId),
            // a window belongs to one project (null = the whole workspace); it never reaches another project's monitors
            m.projectId ? or(isNull(schema.maintenanceWindow.projectId), eq(schema.maintenanceWindow.projectId, m.projectId)) : isNull(schema.maintenanceWindow.projectId),
            lte(schema.maintenanceWindow.startsAt, now),
            gte(schema.maintenanceWindow.endsAt, now),
            or(sql`cardinality(${schema.maintenanceWindow.monitorIds}) = 0`, sql`${m.id} = any(${schema.maintenanceWindow.monitorIds})`),
          ),
        )
        .limit(1);
      return !!w;
    },
    async purgeExpired() {
      // raw results are kept per workspace for its configured number of days; hourly rollups far longer
      await db.execute(sql`delete from check_result r using monitor m
        where m.id = r.monitor_id
          and r.checked_at < now() - make_interval(days => coalesce((select s.check_retention_days from workspace_setting s where s.organization_id = m.organization_id), ${DEFAULT_CHECK_RETENTION_DAYS}))`);
      await db.delete(schema.checkRollup).where(lte(schema.checkRollup.bucket, new Date(Date.now() - ROLLUP_RETENTION_DAYS * 864e5)));
      await db.execute(sql`delete from alert_delivery d
        where d.created_at < now() - make_interval(days => coalesce((select s.alert_log_retention_days from workspace_setting s where s.organization_id = d.organization_id), ${DEFAULT_ALERT_LOG_DAYS}))`);
    },
    async withinLimit(key, limit, windowSec) {
      const t = schema.rateLimit;
      const expired = sql`${t.windowStart} < now() - make_interval(secs => ${windowSec})`;
      const [row] = await db
        .insert(t)
        .values({ key, count: 1 })
        .onConflictDoUpdate({
          target: t.key,
          set: {
            count: sql`case when ${expired} then 1 else ${t.count} + 1 end`,
            windowStart: sql`case when ${expired} then now() else ${t.windowStart} end`,
          },
        })
        .returning({ count: t.count });
      // opportunistic cleanup keeps the table small without a separate job
      if (Math.random() < 0.01) await db.delete(t).where(sql`${t.windowStart} < now() - interval '1 day'`).catch(() => {});
      return row.count <= limit;
    },

    // ── incidents ──────────────────────────────────────────────────────────────
    async listIncidents(orgId, projectId) {
      const r = await db
        .select({ i: schema.incident, monitorName: schema.monitor.name })
        .from(schema.incident)
        .leftJoin(schema.monitor, eq(schema.monitor.id, schema.incident.monitorId))
        .where(and(eq(schema.incident.organizationId, orgId), or(eq(schema.monitor.projectId, projectId), isNull(schema.incident.monitorId))))
        .orderBy(desc(schema.incident.startedAt))
        .limit(100);
      return r.map((x) => ({ ...x.i, monitorName: x.monitorName }));
    },
    async incidentVisible(orgId, id, scope) {
      if (!scope) return true;
      const [row] = await db
        .select({ id: schema.incident.id })
        .from(schema.incident)
        .leftJoin(schema.monitor, eq(schema.monitor.id, schema.incident.monitorId))
        .where(and(eq(schema.incident.id, id), eq(schema.incident.organizationId, orgId), or(inArray(schema.monitor.projectId, scope), isNull(schema.incident.monitorId))));
      return !!row;
    },
    async incidentDetail(orgId, id) {
      const [inc] = await db.select().from(schema.incident).where(and(eq(schema.incident.id, id), eq(schema.incident.organizationId, orgId)));
      if (!inc) return null;
      const [updates, monitor, assignee, checks] = await Promise.all([
        db.select().from(schema.incidentUpdate).where(eq(schema.incidentUpdate.incidentId, inc.id)).orderBy(asc(schema.incidentUpdate.createdAt)),
        inc.monitorId
          ? db.select({ id: schema.monitor.id, name: schema.monitor.name, status: schema.monitor.status, target: schema.monitor.target, type: schema.monitor.type })
              .from(schema.monitor).where(eq(schema.monitor.id, inc.monitorId)).then((r) => r[0] ?? null)
          : null,
        inc.assigneeId
          ? db.select({ name: schema.user.name, email: schema.user.email }).from(schema.user).where(eq(schema.user.id, inc.assigneeId)).then((r) => r[0] ?? null)
          : null,
        inc.monitorId
          ? db.select({ id: schema.checkResult.id, ok: schema.checkResult.ok, statusCode: schema.checkResult.statusCode, latencyMs: schema.checkResult.latencyMs, error: schema.checkResult.error, checkedAt: schema.checkResult.checkedAt })
              .from(schema.checkResult)
              .where(and(eq(schema.checkResult.monitorId, inc.monitorId), eq(schema.checkResult.ok, false), gte(schema.checkResult.checkedAt, inc.startedAt), inc.resolvedAt ? lte(schema.checkResult.checkedAt, inc.resolvedAt) : undefined))
              .orderBy(desc(schema.checkResult.checkedAt)).limit(8)
          : [],
      ]);
      return { incident: inc, updates, monitor, assignee, checks };
    },
    async createIncident(inc, firstUpdate) {
      // the incident and its first update land together or not at all
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(schema.incident)
          .values({ organizationId: inc.organizationId, monitorId: inc.monitorId ?? null, title: inc.title, severity: inc.severity, auto: inc.auto, assigneeId: inc.assigneeId })
          .returning();
        if (firstUpdate) await tx.insert(schema.incidentUpdate).values({ incidentId: row.id, status: firstUpdate.status, body: firstUpdate.body, authorId: firstUpdate.authorId });
        return row;
      });
    },
    async postIncidentUpdate(orgId, id, u) {
      const [incident] = await db
        .update(schema.incident)
        .set({ status: u.status, resolvedAt: u.status === "resolved" ? new Date() : null })
        .where(and(eq(schema.incident.id, id), eq(schema.incident.organizationId, orgId)))
        .returning();
      if (!incident) return null;
      const [update] = await db.insert(schema.incidentUpdate).values({ incidentId: id, status: u.status, body: u.body, authorId: u.authorId }).returning();
      return { incident, update };
    },
    async acknowledgeIncident(orgId, id, userId) {
      const [inc] = await db
        .update(schema.incident)
        .set({ acknowledgedAt: new Date(), assigneeId: userId })
        .where(and(eq(schema.incident.id, id), eq(schema.incident.organizationId, orgId)))
        .returning();
      return inc ?? null;
    },
    async hasOpenIncident(monitorId, slow) {
      // a latency incident is automatic and minor; every other open incident counts as an outage for deduplication
      const isSlow = sql`(${schema.incident.auto} and ${schema.incident.severity} = 'minor')`;
      const [r] = await db
        .select({ id: schema.incident.id })
        .from(schema.incident)
        .where(and(eq(schema.incident.monitorId, monitorId), isNull(schema.incident.resolvedAt), slow ? isSlow : sql`not ${isSlow}`))
        .limit(1);
      return !!r;
    },
    async hadIncidentSince(monitorId, since) {
      const [r] = await db
        .select({ id: schema.incident.id })
        .from(schema.incident)
        .where(and(eq(schema.incident.monitorId, monitorId), gte(schema.incident.startedAt, since), sql`not (${schema.incident.auto} and ${schema.incident.severity} = 'minor')`))
        .limit(1);
      return !!r;
    },
    openIncidents(monitorId, slow) {
      const isSlow = sql`(${schema.incident.auto} and ${schema.incident.severity} = 'minor')`;
      return db
        .select()
        .from(schema.incident)
        .where(and(eq(schema.incident.monitorId, monitorId), isNull(schema.incident.resolvedAt), slow ? isSlow : sql`not ${isSlow}`));
    },
    async resolveIncident(id, body) {
      await db.update(schema.incident).set({ status: "resolved", resolvedAt: new Date() }).where(eq(schema.incident.id, id));
      await db.insert(schema.incidentUpdate).values({ incidentId: id, status: "resolved", body });
    },
    async incidentMuted(id) {
      const [muted] = await db
        .select({ id: schema.alertDelivery.id })
        .from(schema.alertDelivery)
        .where(and(eq(schema.alertDelivery.incidentId, id), eq(schema.alertDelivery.kind, "incident.muted")))
        .limit(1);
      return !!muted;
    },

    // ── alerting ───────────────────────────────────────────────────────────────
    listChannels: (orgId, projectId) =>
      // the project's own channels plus the workspace-wide ones (no project)
      db.select().from(schema.alertChannel).where(and(eq(schema.alertChannel.organizationId, orgId), or(eq(schema.alertChannel.projectId, projectId), isNull(schema.alertChannel.projectId)))),
    async getChannel(orgId, id, scope) {
      const [ch] = await db
        .select()
        .from(schema.alertChannel)
        // a key limited to some projects still reaches the workspace-wide channels (to test them), but not to change them
        .where(and(eq(schema.alertChannel.id, id), eq(schema.alertChannel.organizationId, orgId), scope ? or(inArray(schema.alertChannel.projectId, scope), isNull(schema.alertChannel.projectId)) : undefined));
      return ch ?? null;
    },
    async createChannel(orgId, projectId, c) {
      const [row] = await db.insert(schema.alertChannel).values({ ...c, organizationId: orgId, projectId }).returning();
      return row;
    },
    async updateChannel(orgId, id, scope, patch) {
      const [row] = await db
        .update(schema.alertChannel)
        .set(patch)
        .where(and(eq(schema.alertChannel.id, id), eq(schema.alertChannel.organizationId, orgId), inScope(scope, schema.alertChannel.projectId)))
        .returning();
      return row ?? null;
    },
    async deleteChannel(orgId, id, scope) {
      await db
        .delete(schema.alertChannel)
        .where(and(eq(schema.alertChannel.id, id), eq(schema.alertChannel.organizationId, orgId), inScope(scope, schema.alertChannel.projectId)));
    },
    async autoEnabledChannelIds(orgId, projectId) {
      const rows = await db
        .select({ id: schema.alertChannel.id })
        .from(schema.alertChannel)
        .where(and(eq(schema.alertChannel.organizationId, orgId), or(eq(schema.alertChannel.projectId, projectId), isNull(schema.alertChannel.projectId)), eq(schema.alertChannel.autoEnable, true), eq(schema.alertChannel.enabled, true)));
      return rows.map((r) => r.id);
    },
    monitorsUsingChannel: (orgId, channelId) =>
      db
        .select({ id: schema.monitor.id, name: schema.monitor.name })
        .from(schema.monitor)
        .where(and(eq(schema.monitor.organizationId, orgId), sql`${schema.monitor.channelIds} @> ARRAY[${channelId}]::uuid[]`)),
    channelsToAlert: (orgId, o) =>
      db
        .select()
        .from(schema.alertChannel)
        .where(
          and(
            eq(schema.alertChannel.organizationId, orgId),
            eq(schema.alertChannel.enabled, true),
            o.channelIds.length ? inArray(schema.alertChannel.id, o.channelIds) : undefined,
            // without an explicit list, only the monitor's own project (plus any workspace-wide legacy channel) is alerted
            !o.channelIds.length && o.projectId ? or(eq(schema.alertChannel.projectId, o.projectId), isNull(schema.alertChannel.projectId)) : undefined,
          ),
        ),
    async logDeliveries(list) {
      if (!list.length) return;
      // best effort: a failure to write the log must never break alerting
      // a failed incident alert is queued for another attempt a minute later
      const values = list.map((r) => ({
        ...r,
        nextAttemptAt: !r.ok && r.channelId && (r.kind === "incident.opened" || r.kind === "incident.resolved") ? sql`now() + interval '60 seconds'` : null,
      }));
      await db.insert(schema.alertDelivery).values(values).catch((e) => console.error("alert log write failed", e));
    },
    async claimRetries(limit) {
      const t = schema.alertDelivery;
      const leased = await db
        .update(t)
        .set({ nextAttemptAt: null })
        .where(inArray(t.id, sql`(select id from alert_delivery where ok = false and next_attempt_at <= now() order by next_attempt_at limit ${limit} for update skip locked)`))
        .returning();
      const out: DeliveryRetry[] = [];
      for (const delivery of leased) {
        const [incident] = delivery.incidentId ? await db.select().from(schema.incident).where(eq(schema.incident.id, delivery.incidentId)) : [];
        const [monitor] = incident?.monitorId ? await db.select().from(schema.monitor).where(eq(schema.monitor.id, incident.monitorId)) : [];
        const [channel] = delivery.channelId ? await db.select().from(schema.alertChannel).where(eq(schema.alertChannel.id, delivery.channelId)) : [];
        // the incident, monitor or channel is gone (or the channel was switched off): nothing left to deliver
        if (incident && monitor && channel?.enabled) out.push({ delivery, incident, monitor, channel });
      }
      return out;
    },
    async finishRetry(id, r) {
      const t = schema.alertDelivery;
      await db
        .update(t)
        .set({
          ok: r.ok,
          error: r.error,
          attempts: sql`${t.attempts} + 1`,
          nextAttemptAt: r.ok || r.retryInSec == null ? null : sql`now() + make_interval(secs => ${r.retryInSec})`,
        })
        .where(eq(t.id, id));
    },
    listDeliveries: (orgId, projectId, o) =>
      db
        .select()
        .from(schema.alertDelivery)
        .where(
          and(
            eq(schema.alertDelivery.organizationId, orgId),
            or(eq(schema.alertDelivery.projectId, projectId), isNull(schema.alertDelivery.projectId)),
            o.before ? lt(schema.alertDelivery.createdAt, o.before) : undefined,
          ),
        )
        .orderBy(desc(schema.alertDelivery.createdAt))
        .limit(o.limit),
    async subscribersFor(orgId, monitorId) {
      const base = db
        .select({ email: schema.statusSubscriber.email, locale: schema.statusSubscriber.locale, token: schema.statusSubscriber.token, slug: schema.statusPage.slug, title: schema.statusPage.title })
        .from(schema.statusSubscriber)
        .innerJoin(schema.statusPage, eq(schema.statusPage.id, schema.statusSubscriber.statusPageId));
      if (!monitorId) return base.where(and(eq(schema.statusPage.organizationId, orgId), isNotNull(schema.statusSubscriber.confirmedAt)));
      return base
        .innerJoin(
          schema.statusPageComponent,
          and(eq(schema.statusPageComponent.statusPageId, schema.statusPage.id), eq(schema.statusPageComponent.monitorId, monitorId), eq(schema.statusPageComponent.visible, true)),
        )
        .where(isNotNull(schema.statusSubscriber.confirmedAt));
    },
    async getSettings(orgId) {
      const [row] = await db.select().from(schema.workspaceSetting).where(eq(schema.workspaceSetting.organizationId, orgId));
      return {
        alertLogRetentionDays: row?.alertLogRetentionDays ?? DEFAULT_ALERT_LOG_DAYS,
        checkRetentionDays: row?.checkRetentionDays ?? DEFAULT_CHECK_RETENTION_DAYS,
      };
    },
    async saveSettings(orgId, patch) {
      const [row] = await db
        .insert(schema.workspaceSetting)
        .values({ organizationId: orgId, ...patch })
        .onConflictDoUpdate({ target: schema.workspaceSetting.organizationId, set: patch })
        .returning();
      return { alertLogRetentionDays: row.alertLogRetentionDays, checkRetentionDays: row.checkRetentionDays };
    },

    listMaintenance: (orgId, projectId) =>
      db
        .select()
        .from(schema.maintenanceWindow)
        .where(and(eq(schema.maintenanceWindow.organizationId, orgId), eq(schema.maintenanceWindow.projectId, projectId)))
        .orderBy(desc(schema.maintenanceWindow.startsAt))
        .limit(200),
    async createMaintenance(orgId, projectId, w) {
      const [row] = await db.insert(schema.maintenanceWindow).values({ ...w, organizationId: orgId, projectId }).returning();
      return row;
    },
    async deleteMaintenance(orgId, id, scope) {
      await db
        .delete(schema.maintenanceWindow)
        .where(and(eq(schema.maintenanceWindow.id, id), eq(schema.maintenanceWindow.organizationId, orgId), inScope(scope, schema.maintenanceWindow.projectId)));
    },

    // ── status pages ───────────────────────────────────────────────────────────
    listStatusPages: (orgId, projectId) =>
      db.select().from(schema.statusPage).where(and(eq(schema.statusPage.organizationId, orgId), eq(schema.statusPage.projectId, projectId))),
    async getStatusPage(orgId, id, scope) {
      const [page] = await db
        .select()
        .from(schema.statusPage)
        .where(and(eq(schema.statusPage.id, id), eq(schema.statusPage.organizationId, orgId), inScope(scope, schema.statusPage.projectId)));
      return page ?? null;
    },
    async slugTaken(slug) {
      const [t] = await db.select({ id: schema.statusPage.id }).from(schema.statusPage).where(eq(schema.statusPage.slug, slug));
      return !!t;
    },
    async createStatusPage(orgId, projectId, p) {
      const [page] = await db.insert(schema.statusPage).values({ ...p, organizationId: orgId, projectId }).returning();
      return page;
    },
    async updateStatusPage(id, patch) {
      if (Object.keys(patch).length) await db.update(schema.statusPage).set(patch).where(eq(schema.statusPage.id, id));
    },
    async deleteStatusPage(id) {
      await db.delete(schema.statusPage).where(eq(schema.statusPage.id, id));
    },
    pageComponents: (pageId) =>
      db
        .select({ monitorId: schema.statusPageComponent.monitorId, groupName: schema.statusPageComponent.groupName })
        .from(schema.statusPageComponent)
        .where(eq(schema.statusPageComponent.statusPageId, pageId))
        .orderBy(asc(schema.statusPageComponent.position)),
    async setPageComponents(pageId, orgId, comps, scope) {
      await db.delete(schema.statusPageComponent).where(eq(schema.statusPageComponent.statusPageId, pageId));
      if (!comps.length) return;
      const ok = new Set(await repo.ownedMonitorIds(orgId, comps.map((x) => x.monitorId), scope));
      const list = comps
        .filter((x) => ok.has(x.monitorId))
        .map((x, position) => ({ statusPageId: pageId, monitorId: x.monitorId, position, ...(x.groupName ? { groupName: x.groupName } : {}) }));
      if (list.length) await db.insert(schema.statusPageComponent).values(list);
    },
    listSubscribers: (pageId) =>
      db
        .select({ id: schema.statusSubscriber.id, email: schema.statusSubscriber.email, confirmedAt: schema.statusSubscriber.confirmedAt, createdAt: schema.statusSubscriber.createdAt })
        .from(schema.statusSubscriber)
        .where(eq(schema.statusSubscriber.statusPageId, pageId))
        .orderBy(desc(schema.statusSubscriber.createdAt))
        .limit(1000),
    async deleteSubscriber(pageId, subscriberId) {
      await db.delete(schema.statusSubscriber).where(and(eq(schema.statusSubscriber.id, subscriberId), eq(schema.statusSubscriber.statusPageId, pageId)));
    },

    async statusPageBySlug(slug) {
      const [page] = await db.select().from(schema.statusPage).where(eq(schema.statusPage.slug, slug));
      return page ?? null;
    },
    async statusBoard(page) {
      const comps = await db
        .select({ c: schema.statusPageComponent, m: schema.monitor })
        .from(schema.statusPageComponent)
        .innerJoin(schema.monitor, eq(schema.monitor.id, schema.statusPageComponent.monitorId))
        .where(and(eq(schema.statusPageComponent.statusPageId, page.id), eq(schema.statusPageComponent.visible, true)))
        .orderBy(asc(schema.statusPageComponent.position));
      const ids = comps.map((x) => x.m.id);

      // 90 buckets: daily for the last 90 days, or hourly while the history is still short
      // (otherwise one bad day at launch paints the whole bar red even after recovery)
      const first = ids.length
        ? (await db
            .select({ at: sql<string | null>`min(${schema.checkRollup.bucket})` })
            .from(schema.checkRollup)
            .where(inArray(schema.checkRollup.monitorId, ids)))[0]?.at
        : null;
      const hourly = !first || Date.now() - new Date(first).getTime() < 4 * 864e5;
      const unit = hourly ? "hour" : "day";
      const since = new Date(Date.now() - 90 * (hourly ? 36e5 : 864e5));
      const days = ids.length
        ? await db
            .select({
              monitorId: schema.checkRollup.monitorId,
              day: sql<string>`to_char(date_trunc(${sql.raw(`'${unit}'`)}, ${schema.checkRollup.bucket}), ${sql.raw(hourly ? `'YYYY-MM-DD"T"HH24'` : `'YYYY-MM-DD'`)})`,
              total: sql<number>`sum(${schema.checkRollup.total})::int`,
              ok: sql<number>`sum(${schema.checkRollup.ok})::int`,
            })
            .from(schema.checkRollup)
            .where(and(inArray(schema.checkRollup.monitorId, ids), gte(schema.checkRollup.bucket, since)))
            .groupBy(schema.checkRollup.monitorId, sql`date_trunc(${sql.raw(`'${unit}'`)}, ${schema.checkRollup.bucket})`)
        : [];

      const open = await db
        .select()
        .from(schema.incident)
        .where(and(pageScope(page.organizationId, ids), isNull(schema.incident.resolvedAt)))
        .orderBy(desc(schema.incident.startedAt));

      return {
        bucket: unit,
        components: comps.map(({ c, m }) => {
          const mine = days.filter((d) => d.monitorId === m.id);
          const total = mine.reduce((a, d) => a + d.total, 0);
          const ok = mine.reduce((a, d) => a + d.ok, 0);
          return {
            id: m.id,
            name: m.name,
            group: c.groupName,
            status: m.status,
            uptime90d: total ? Math.round((ok / total) * 10000) / 100 : null,
            days: mine.map((d) => ({ day: d.day, uptime: d.total ? d.ok / d.total : 1 })),
          };
        }),
        incidents: await withUpdates(open),
      };
    },
    async pageIncidents(page, o) {
      const list = await db
        .select()
        .from(schema.incident)
        .where(and(pageScope(page.organizationId, await pageMonitorIds(page.id)), o.before ? lt(schema.incident.startedAt, o.before) : undefined))
        .orderBy(desc(schema.incident.startedAt))
        .limit(o.limit);
      return withUpdates(list);
    },
    async subscriberCount(pageId) {
      const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.statusSubscriber).where(eq(schema.statusSubscriber.statusPageId, pageId));
      return r.n;
    },
    async addSubscriber(s) {
      const [row] = await db
        .insert(schema.statusSubscriber)
        .values({ statusPageId: s.pageId, email: s.email, token: s.token, locale: s.locale })
        .onConflictDoNothing()
        .returning();
      return row ? { locale: row.locale } : null;
    },
    async confirmSubscriber(token) {
      const [r] = await db
        .update(schema.statusSubscriber)
        .set({ confirmedAt: new Date() })
        .where(and(eq(schema.statusSubscriber.token, token), isNull(schema.statusSubscriber.confirmedAt)))
        .returning({ pageId: schema.statusSubscriber.statusPageId });
      const pageId =
        r?.pageId ?? (await db.select({ p: schema.statusSubscriber.statusPageId }).from(schema.statusSubscriber).where(eq(schema.statusSubscriber.token, token)))[0]?.p;
      if (!pageId) return null;
      const [page] = await db.select({ slug: schema.statusPage.slug }).from(schema.statusPage).where(eq(schema.statusPage.id, pageId));
      return page?.slug ?? null;
    },
    async removeSubscriber(token) {
      const [r] = await db.delete(schema.statusSubscriber).where(eq(schema.statusSubscriber.token, token)).returning({ pageId: schema.statusSubscriber.statusPageId });
      if (!r) return null;
      const [page] = await db.select({ slug: schema.statusPage.slug }).from(schema.statusPage).where(eq(schema.statusPage.id, r.pageId));
      return page?.slug ?? null;
    },
  };
  return repo;
}
