import {
  DEFAULT_ALERT_LOG_DAYS,
  PUSH_DEVICE_STALE_DAYS,
  DEFAULT_CHECK_RETENTION_DAYS,
  MAX_REMINDERS,
  ROLLUP_RETENTION_DAYS,
  type AlertDelivery,
  type DeliveryRetry,
  type EscalationDue,
  type ReminderDue,
  type IncidentWithUpdates,
  type PushDevice,
  type Repo,
  type Scope,
} from "@openuptime/repo";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { Db } from "./client";
import * as schema from "./schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `col in (scope)` for a limited API key, nothing otherwise; spread into `and(...)`. */
const inScope = (scope: Scope, col: Parameters<typeof inArray>[0]): SQL | undefined => (scope ? inArray(col, scope) : undefined);

/** True when the last "resolved" update of the incident was written by a person (not by the checks); survives the account being deleted. */
const resolvedByPerson = (incidentId: Parameters<typeof inArray>[0]): SQL =>
  sql`coalesce((select u.by_person from incident_update u where u.incident_id = ${incidentId} and u.status = 'resolved' order by u.created_at desc limit 1), false)`;

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

  /** The project a page belongs to; a page without one falls back to the workspace's oldest project, as incident numbering does. */
  async function pageProjectId(page: { organizationId: string; projectId: string | null }) {
    if (page.projectId) return page.projectId;
    const [p] = await db.select({ id: schema.project.id }).from(schema.project).where(eq(schema.project.organizationId, page.organizationId)).orderBy(asc(schema.project.createdAt), asc(schema.project.id)).limit(1);
    return p?.id ?? null;
  }

  /** Incidents shown on a page: those of its own monitors, plus manual ones (no monitor) of the page's own project. */
  function pageScope(orgId: string, projectId: string | null, monitorIds: string[] | SQLWrapper) {
    const manual = and(isNull(schema.incident.monitorId), projectId ? eq(schema.incident.projectId, projectId) : isNull(schema.incident.projectId));
    const own = Array.isArray(monitorIds) ? (monitorIds.length ? inArray(schema.incident.monitorId, monitorIds) : undefined) : inArray(schema.incident.monitorId, monitorIds);
    return and(eq(schema.incident.organizationId, orgId), own ? or(manual, own) : manual);
  }

  async function withUpdates(list: (typeof schema.incident.$inferSelect)[]): Promise<IncidentWithUpdates[]> {
    const ids = list.map((i) => i.id);
    const updates = ids.length
      ? await db
          .select()
          .from(schema.incidentUpdate)
          // withUpdates feeds public pages, feeds and subscriber mail only: internal updates never go through here
          .where(and(inArray(schema.incidentUpdate.incidentId, ids), eq(schema.incidentUpdate.visibility, "public")))
          .orderBy(desc(schema.incidentUpdate.createdAt))
      : [];
    return list.map((i) => ({ ...i, updates: updates.filter((u) => u.incidentId === i.id) }));
  }

  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  /**
   * Hands out the next incident number of the incident's project. The counter row is bumped with one UPDATE inside the
   * caller's transaction, so concurrent creators queue on the row lock and never see the same number; a rolled-back
   * insert rolls the counter back with it.
   */
  async function allocateNumber(tx: Tx, inc: { organizationId: string; monitorId?: string | null; projectId?: string | null }) {
    let projectId = inc.projectId ?? null;
    if (inc.monitorId) {
      const [m] = await tx.select({ projectId: schema.monitor.projectId }).from(schema.monitor).where(eq(schema.monitor.id, inc.monitorId));
      projectId = m?.projectId ?? projectId;
    }
    if (!projectId) {
      const [p] = await tx.select({ id: schema.project.id }).from(schema.project).where(eq(schema.project.organizationId, inc.organizationId)).orderBy(asc(schema.project.createdAt), asc(schema.project.id)).limit(1);
      projectId = p?.id ?? null;
    }
    if (!projectId) return { projectId: null, number: null };
    const [p] = await tx
      .update(schema.project)
      .set({ incidentSeq: sql`${schema.project.incidentSeq} + 1` })
      .where(and(eq(schema.project.id, projectId), eq(schema.project.organizationId, inc.organizationId)))
      .returning({ n: schema.project.incidentSeq });
    return p ? { projectId, number: p.n } : { projectId: null, number: null };
  }

  /** Count one run in the monitor's hourly rollup. */
  async function foldIntoRollup(monitorId: string, ok: boolean, latencyMs: number | null) {
    await db
      .insert(schema.checkRollup)
      .values({
        monitorId,
        bucket: sql`date_trunc('hour', now())`,
        total: 1,
        ok: ok ? 1 : 0,
        latencySum: latencyMs ?? 0,
        latencyN: latencyMs == null ? 0 : 1,
      })
      .onConflictDoUpdate({
        target: [schema.checkRollup.monitorId, schema.checkRollup.bucket],
        set: {
          total: sql`${schema.checkRollup.total} + 1`,
          ok: sql`${schema.checkRollup.ok} + ${ok ? 1 : 0}`,
          latencySum: sql`${schema.checkRollup.latencySum} + ${latencyMs ?? 0}`,
          latencyN: sql`${schema.checkRollup.latencyN} + ${latencyMs == null ? 0 : 1}`,
        },
      });
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
        .onConflictDoUpdate({ target: schema.oauthResource.identifier, set: { allowedScopes: scopes, updatedAt: now }, setWhere: sql`${schema.oauthResource.allowedScopes} is distinct from ${sql.raw(`array[${scopes.map((x) => `'${x.replace(/'/g, "''")}'`).join(",")}]::text[]`)}` });
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
          monitors: await q(sql`select id, project_id, name, type, target, method, expected_status, interval_sec, timeout_ms, failure_threshold, keyword, keyword_mode, expected_location, headers, ws_message, tags, slow_threshold_ms, slow_alert_after, created_at from monitor where organization_id = ${id}`),
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

    async activeMonitorCount(o) {
      const r = await rows<{ n: number }>(db.execute(sql`select count(*)::int as n from monitor where organization_id = ${o} and status <> 'paused'`));
      return r[0]?.n ?? 0;
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
    async projectOverview(orgId, scope) {
      const list = await db
        .select({ id: schema.project.id, name: schema.project.name })
        .from(schema.project)
        .where(and(eq(schema.project.organizationId, orgId), inScope(scope, schema.project.id)))
        .orderBy(asc(schema.project.createdAt));
      if (!list.length) return [];
      const ids = sql.join(list.map((p) => sql`${p.id}::uuid`), sql`, `);
      const [mon, inc] = await Promise.all([
        rows<{ project_id: string; monitors: number; down: number }>(
          db.execute(sql`select project_id, count(*)::int as monitors, (count(*) filter (where status = 'down'))::int as down
            from monitor where organization_id = ${orgId} and project_id in (${ids}) group by project_id`),
        ),
        // an incident belongs to the project that numbered it; one without falls back to its monitor's project
        rows<{ project_id: string; n: number }>(
          db.execute(sql`select coalesce(i.project_id, m.project_id) as project_id, count(*)::int as n
            from incident i left join monitor m on m.id = i.monitor_id
            where i.organization_id = ${orgId} and i.status <> 'resolved' and coalesce(i.project_id, m.project_id) in (${ids}) group by 1`),
        ),
      ]);
      return list.map((p) => {
        const m = mon.find((x) => x.project_id === p.id);
        return { id: p.id, name: p.name, monitors: m?.monitors ?? 0, down: m?.down ?? 0, openIncidents: inc.find((x) => x.project_id === p.id)?.n ?? 0 };
      });
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
      const ids = ([] as string[]).concat(projectId);
      if (!ids.length) return [];
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
          .where(and(eq(schema.monitor.organizationId, orgId), inArray(schema.monitor.projectId, ids)))
          .groupBy(schema.monitor.id)
          .orderBy(schema.monitor.name),
        // last 30 latency samples per monitor, for the list sparkline
        rows<{ monitor_id: string; latency_ms: number | null }>(
          db.execute(sql`
            select monitor_id, latency_ms from (
              select r.monitor_id, r.latency_ms, row_number() over (partition by r.monitor_id order by r.checked_at desc) rn
              from check_result r join monitor m on m.id = r.monitor_id
              where m.organization_id = ${orgId} and m.project_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) and r.checked_at >= ${since.toISOString()}::timestamptz
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
      const [results, statRows, p95Rows, incidents, regionRows] = await Promise.all([
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
        rows<{ region: string; n: number; ok_n: number; avg: number | null }>(
          db.execute(sql`select region, count(*)::int as n, count(*) filter (where ok)::int as ok_n,
            round(avg(latency_ms) filter (where ok))::int as avg
            from check_result where monitor_id = ${monitorId} and checked_at >= ${day}::timestamptz group by region order by region`),
        ),
      ]);
      const st = { ...(statRows[0] ?? {}), ...(p95Rows[0] ?? {}) };
      const pct = (ok: number | null, n: number | null) => (n ? Math.round(((ok ?? 0) / n) * 10000) / 100 : null);
      return {
        results,
        incidents,
        stats: { uptime24h: pct(st.ok24, st.n24), uptime7d: pct(st.ok7, st.n7), avg24h: st.avg24 ?? null, p95: st.p95 ?? null },
        regionStats: regionRows.map((r) => {
          // `results` is newest first, so the first row of a region is its latest
          const last = results.find((x) => x.region === r.region);
          return {
            region: r.region,
            checks24h: r.n,
            uptime24h: pct(r.ok_n, r.n),
            avgLatency24h: r.avg ?? null,
            last: last ? { ok: last.ok, statusCode: last.statusCode, latencyMs: last.latencyMs, error: last.error, checkedAt: last.checkedAt } : null,
          };
        }),
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
        .set({ ...patch, ...(patch.paused !== undefined ? { consecutiveSuccesses: 0 } : {}) })
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

    async recordHeartbeatSuccess(id) {
      const [row] = await db.update(schema.monitor).set({
        consecutiveSuccesses: sql`least(${schema.monitor.consecutiveSuccesses} + 1, ${schema.monitor.recoveryThreshold})`,
        consecutiveFailures: 0,
        lastCheckedAt: new Date(),
        nextCheckAt: sql`now() + make_interval(secs => ${schema.monitor.intervalSec} + ${schema.monitor.graceSec})`,
      }).where(and(eq(schema.monitor.id, id), eq(schema.monitor.paused, false))).returning();
      return row ?? null;
    },

    // ── checking ───────────────────────────────────────────────────────────────
    claimDue: (limit) =>
      db
        .update(schema.monitor)
        // advance from the scheduled time, so finishing a check late never pushes the next one past a whole cron tick;
        // a monitor that is far behind (paused, outage of the scheduler) restarts from now instead of catching up in a burst
        .set({
          runGeneration: sql`${schema.monitor.runGeneration} + 1`,
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
      // The row lock serializes duplicate starts. Generations never move backwards when an interval is shortened.
      const started = await Promise.all(
        runs.map(async ({ id, token, generation }) => {
          if (generation !== undefined && (!Number.isSafeInteger(generation) || generation <= 0)) throw new Error("Invalid run generation");
          const newer = generation === undefined
            // Legacy messages can finish until this monitor starts using generation-based claims.
            ? and(eq(schema.monitor.lastRunGeneration, 0), or(isNull(schema.monitor.lastRunToken), sql`${schema.monitor.lastRunToken} < ${token.toISOString()}::timestamptz`))
            : sql`${schema.monitor.lastRunGeneration} < ${generation} and ${schema.monitor.runGeneration} >= ${generation}`;
          const won = await db
            .update(schema.monitor)
            .set({ lastRunToken: token, ...(generation !== undefined ? { lastRunGeneration: generation } : {}) })
            .where(and(eq(schema.monitor.id, id), newer))
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
      await db.insert(schema.checkResult).values({ monitorId: r.monitorId, region: r.region ?? "auto", ok: r.ok, statusCode: r.statusCode, latencyMs: r.latencyMs, error: r.error });
      await foldIntoRollup(r.monitorId, r.ok, r.latencyMs ?? null);
    },
    async recordRegionResults(monitorId, results, summary) {
      if (!results.length) return;
      await db.insert(schema.checkResult).values(
        results.map((r) => ({ monitorId, region: r.region, ok: r.ok, statusCode: r.statusCode, latencyMs: r.latencyMs, error: r.error })),
      );
      await foldIntoRollup(monitorId, summary.ok, summary.latencyMs ?? null);
    },
    async setMonitorState(id, state) {
      // a changed status starts a new streak
      const changed = state.status ? { statusChangedAt: sql`case when ${schema.monitor.status} is distinct from ${state.status} then now() else ${schema.monitor.statusChangedAt} end` } : {};
      await db.update(schema.monitor).set({ ...state, ...changed }).where(eq(schema.monitor.id, id));
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
      // counters only matter within their window (the longest is an hour)
      await db.execute(sql`delete from rate_limit where window_start < now() - interval '1 day'`);
      await db.execute(sql`delete from alert_delivery d
        where d.created_at < now() - make_interval(days => coalesce((select s.alert_log_retention_days from workspace_setting s where s.organization_id = d.organization_id), ${DEFAULT_ALERT_LOG_DAYS}))`);
      // a phone that has not opened the app (which re-registers on launch) for half a year is gone or has a stale token
      await db.delete(schema.pushDevice).where(lte(schema.pushDevice.lastSeenAt, new Date(Date.now() - PUSH_DEVICE_STALE_DAYS * 864e5)));
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
      const ids = ([] as string[]).concat(projectId);
      if (!ids.length) return [];
      const r = await db
        .select({ i: schema.incident, monitorName: schema.monitor.name })
        .from(schema.incident)
        .leftJoin(schema.monitor, eq(schema.monitor.id, schema.incident.monitorId))
        // an incident belongs to the project that numbered it; one without (it predates numbering) falls back to its monitor
        .where(and(eq(schema.incident.organizationId, orgId), or(inArray(schema.incident.projectId, ids), and(isNull(schema.incident.projectId), or(inArray(schema.monitor.projectId, ids), isNull(schema.incident.monitorId))))))
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
        .where(and(eq(schema.incident.id, id), eq(schema.incident.organizationId, orgId), or(inArray(schema.incident.projectId, scope), and(isNull(schema.incident.projectId), or(inArray(schema.monitor.projectId, scope), isNull(schema.incident.monitorId))))));
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
        const { projectId, number } = await allocateNumber(tx, inc);
        const [row] = await tx
          .insert(schema.incident)
          .values({ organizationId: inc.organizationId, monitorId: inc.monitorId ?? null, projectId, number, title: inc.title, severity: inc.severity, auto: inc.auto, assigneeId: inc.assigneeId, evaluationNote: inc.evaluationNote })
          .returning();
        if (firstUpdate) await tx.insert(schema.incidentUpdate).values({ incidentId: row.id, status: firstUpdate.status, body: firstUpdate.body, authorId: firstUpdate.authorId, byPerson: !!firstUpdate.authorId, visibility: firstUpdate.visibility });
        return row;
      });
    },
    async openAutoIncident(inc, firstUpdate) {
      const lost = new Error("incident already open");
      try {
        return await db.transaction(async (tx) => {
          const { projectId, number } = await allocateNumber(tx, inc);
          const [row] = await tx
            .insert(schema.incident)
            .values({ organizationId: inc.organizationId, monitorId: inc.monitorId ?? null, projectId, number, title: inc.title, severity: inc.severity, auto: true, assigneeId: inc.assigneeId, evaluationNote: inc.evaluationNote })
            .onConflictDoNothing()
            .returning();
          // losing the race to another open incident rolls the transaction back, so the number is not burned
          if (!row) throw lost;
          await tx.insert(schema.incidentUpdate).values({ incidentId: row.id, status: firstUpdate.status, body: firstUpdate.body, authorId: firstUpdate.authorId, byPerson: !!firstUpdate.authorId, visibility: firstUpdate.visibility });
          return row;
        });
      } catch (e) {
        if (e === lost) return null;
        throw e;
      }
    },
    async postIncidentUpdate(orgId, id, u) {
      const [incident] = await db
        .update(schema.incident)
        .set({ status: u.status, resolvedAt: u.status === "resolved" ? new Date() : null, ...(u.status === "resolved" ? { nextReminderAt: null, nextEscalationAt: null } : { postmortemPublishedAt: sql`case when ${schema.incident.resolvedAt} is not null then null else ${schema.incident.postmortemPublishedAt} end` }) })
        .where(and(eq(schema.incident.id, id), eq(schema.incident.organizationId, orgId)))
        .returning();
      if (!incident) return null;
      const [update] = await db.insert(schema.incidentUpdate).values({ incidentId: id, status: u.status, body: u.body, authorId: u.authorId, byPerson: !!u.authorId, visibility: u.visibility }).returning();
      return { incident, update };
    },
    async updateIncidentWriteUp(orgId, id, w) {
      const set: Partial<typeof schema.incident.$inferInsert> = {};
      if (w.rootCause !== undefined) set.rootCause = w.rootCause;
      if (w.postmortem !== undefined) set.postmortem = w.postmortem;
      if (w.publish !== undefined) set.postmortemPublishedAt = w.publish ? new Date() : null;
      const where = and(eq(schema.incident.id, id), eq(schema.incident.organizationId, orgId));
      if (!Object.keys(set).length) return db.select().from(schema.incident).where(where).then((r) => r[0] ?? null);
      const [row] = await db.update(schema.incident).set(set).where(where).returning();
      return row ?? null;
    },
    async acknowledgeIncident(orgId, id, userId) {
      const [inc] = await db
        .update(schema.incident)
        .set({ acknowledgedAt: new Date(), assigneeId: userId, nextReminderAt: null, nextEscalationAt: null })
        .where(and(eq(schema.incident.id, id), eq(schema.incident.organizationId, orgId)))
        .returning();
      // the alerts that went out before the acknowledgement are marked as seen
      if (inc) await db.update(schema.alertDelivery).set({ acknowledgedAt: inc.acknowledgedAt }).where(and(eq(schema.alertDelivery.incidentId, id), isNull(schema.alertDelivery.acknowledgedAt), inArray(schema.alertDelivery.kind, ["incident.opened", "incident.reminder", "incident.escalated"])));
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
        .where(and(eq(schema.incident.monitorId, monitorId), gte(schema.incident.startedAt, since), sql`not (${schema.incident.auto} and ${schema.incident.severity} = 'minor')`, sql`not ${resolvedByPerson(schema.incident.id)}`))
        .limit(1);
      return !!r;
    },
    async reopenIncident(monitorId, since, body, evaluationNote) {
      try {
        return await db.transaction(async (tx) => {
          // a person's resolution stands: only an incident the checks resolved themselves is reopened
          const byPerson = resolvedByPerson(schema.incident.id);
          const [last] = await tx
            .select({ id: schema.incident.id })
            .from(schema.incident)
            .where(and(eq(schema.incident.monitorId, monitorId), eq(schema.incident.auto, true), eq(schema.incident.severity, "major"), gte(schema.incident.resolvedAt, since), sql`not ${byPerson}`))
            .orderBy(desc(schema.incident.resolvedAt))
            .limit(1);
          if (!last) return null;
          // the unique index on open automatic incidents makes a concurrent reopen (or open) lose here instead of duplicating;
          // the follow-up clocks start over, as for a new incident
          const [row] = await tx
            .update(schema.incident)
            .set({ status: "investigating", resolvedAt: null, evaluationNote, acknowledgedAt: null, postmortemPublishedAt: null, reminderCount: 0, escalationLevel: 0, nextReminderAt: null, nextEscalationAt: null })
            .where(and(eq(schema.incident.id, last.id), sql`${schema.incident.resolvedAt} is not null`))
            .returning();
          if (!row) return null;
          await tx.insert(schema.incidentUpdate).values({ incidentId: row.id, status: "investigating", body });
          return row;
        });
      } catch (e) {
        // a unique violation: another check opened (or reopened) an incident for this monitor first
        const code = (e as { code?: string; cause?: { code?: string } });
        if (code?.code === "23505" || code?.cause?.code === "23505") return null;
        throw e;
      }
    },
    async outageHandledByPerson(monitorId) {
      // The current failing streak started after the last passing run and after the monitor's last status change (a region that
      // fails for good means no run ever passes, so the status change is what keeps an old resolve from counting forever).
      const res = await db.execute(sql`
        select exists (
          select 1 from incident i
          where i.monitor_id = ${monitorId} and not (i.auto and i.severity = 'minor') and i.resolved_at is not null
            -- a run passed when none of its region rows failed (the rows of one run share a timestamp)
            and i.resolved_at > coalesce((select max(c.checked_at) from check_result c where c.monitor_id = ${monitorId} and c.ok
              and not exists (select 1 from check_result f where f.monitor_id = c.monitor_id and f.checked_at = c.checked_at and not f.ok)), 'epoch'::timestamptz)
            and i.resolved_at > coalesce((select m.status_changed_at from monitor m where m.id = ${monitorId}), 'epoch'::timestamptz)
            and coalesce((select u.by_person from incident_update u where u.incident_id = i.id and u.status = 'resolved' order by u.created_at desc limit 1), false)
        ) as handled`);
      return !!(res as unknown as { handled: boolean }[])[0]?.handled;
    },
    openIncidents(monitorId, slow) {
      const isSlow = sql`(${schema.incident.auto} and ${schema.incident.severity} = 'minor')`;
      return db
        .select()
        .from(schema.incident)
        .where(and(eq(schema.incident.monitorId, monitorId), isNull(schema.incident.resolvedAt), slow ? isSlow : sql`not ${isSlow}`));
    },
    async resolveIncident(id, body) {
      // only the caller that flips it from open to resolved gets true (and so sends the recovery alert)
      const [done] = await db
        .update(schema.incident)
        .set({ status: "resolved", resolvedAt: new Date(), nextReminderAt: null, nextEscalationAt: null })
        .where(and(eq(schema.incident.id, id), isNull(schema.incident.resolvedAt)))
        .returning({ id: schema.incident.id });
      if (!done) return false;
      await db.insert(schema.incidentUpdate).values({ incidentId: id, status: "resolved", body });
      return true;
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
    async upsertPushDevice(userId, d) {
      const now = new Date();
      const [row] = await db
        .insert(schema.pushDevice)
        .values({ userId, token: d.token, platform: d.platform, environment: d.environment, locale: d.locale ?? null, name: d.name ?? null, critical: d.critical ?? false, lastSeenAt: now })
        .onConflictDoUpdate({
          target: schema.pushDevice.token,
          set: { userId, platform: d.platform, environment: d.environment, locale: d.locale ?? null, name: d.name ?? null, ...(d.critical === undefined ? {} : { critical: d.critical }), lastSeenAt: now },
        })
        .returning();
      return row as PushDevice;
    },
    async listPushDevices(userId) {
      return (await db.select().from(schema.pushDevice).where(eq(schema.pushDevice.userId, userId)).orderBy(asc(schema.pushDevice.createdAt))) as PushDevice[];
    },
    async deletePushDevice(userId, token) {
      const gone = await db.delete(schema.pushDevice).where(and(eq(schema.pushDevice.userId, userId), eq(schema.pushDevice.token, token))).returning({ id: schema.pushDevice.id });
      return gone.length > 0;
    },
    async pushDevicesForOrganization(orgId) {
      const rows = await db
        .select({ d: schema.pushDevice })
        .from(schema.pushDevice)
        .innerJoin(schema.member, eq(schema.member.userId, schema.pushDevice.userId))
        .where(eq(schema.member.organizationId, orgId));
      return rows.map((r) => r.d) as PushDevice[];
    },
    async deletePushDeviceByToken(token) {
      await db.delete(schema.pushDevice).where(eq(schema.pushDevice.token, token));
    },
    async managedOrgsWithoutPushChannel(userId) {
      const rows = await db
        .select({ id: schema.member.organizationId })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.userId, userId),
            inArray(schema.member.role, ["owner", "admin"]),
            sql`not exists (select 1 from ${schema.alertChannel} where ${schema.alertChannel.organizationId} = ${schema.member.organizationId} and ${schema.alertChannel.type} = 'push')`,
          ),
        );
      return rows.map((r) => r.id);
    },
    channelsToAlert: (orgId, o) =>
      db
        .select()
        .from(schema.alertChannel)
        .where(
          and(
            eq(schema.alertChannel.organizationId, orgId),
            o.withDisabled ? undefined : eq(schema.alertChannel.enabled, true),
            o.channelIds.length ? inArray(schema.alertChannel.id, o.channelIds) : undefined,
            // without an explicit list, only the monitor's own project (plus any workspace-wide legacy channel) is alerted
            !o.channelIds.length && o.projectId ? or(eq(schema.alertChannel.projectId, o.projectId), isNull(schema.alertChannel.projectId)) : undefined,
          ),
        ),
    channelsByIds: (orgId, ids) =>
      ids.length ? db.select().from(schema.alertChannel).where(and(eq(schema.alertChannel.organizationId, orgId), inArray(schema.alertChannel.id, ids))) : Promise.resolve([]),
    async logDeliveries(list) {
      if (!list.length) return;
      // best effort: a failure to write the log must never break alerting
      const values = list.map((r) => ({ ...r, status: r.status ?? (r.ok ? ("sent" as const) : ("failed" as const)), nextAttemptAt: null }));
      await db.insert(schema.alertDelivery).values(values).catch((e) => console.error("alert log write failed", e));
    },
    async queueDeliveries(list) {
      if (!list.length) return [];
      try {
        return (await db.insert(schema.alertDelivery).values(list.map((r) => ({ ...r, ok: false, status: "pending" as const, attempts: 0 }))).returning()) as AlertDelivery[];
      } catch (e) {
        console.error("alert log write failed", e);
        return [];
      }
    },
    async claimDelivery(id) {
      const t = schema.alertDelivery;
      // a row that waits for a retry is claimable only once its time has come
      const [row] = await db
        .update(t)
        .set({ status: "sending", claimedAt: sql`now()` })
        .where(and(eq(t.id, id), eq(t.status, "pending"), or(isNull(t.nextAttemptAt), lte(t.nextAttemptAt, sql`now()`))))
        .returning();
      return (row as AlertDelivery) ?? null;
    },
    async finishDelivery(id, r) {
      const t = schema.alertDelivery;
      const again = r.status === "failed" && r.retryInSec != null;
      await db
        .update(t)
        .set({
          status: again ? "pending" : r.status,
          ok: r.status === "sent",
          error: r.error,
          statusMessage: r.message,
          // a skip is not an attempt
          attempts: r.status === "skipped" ? t.attempts : sql`${t.attempts} + 1`,
          nextAttemptAt: again ? sql`now() + make_interval(secs => ${r.retryInSec})` : null,
        })
        .where(and(eq(t.id, id), eq(t.status, "sending")));
    },
    async claimRetries(limit) {
      const t = schema.alertDelivery;
      // rows from before delivery states existed count as pending when they failed and wait for a retry
      const due = sql`(${t.status} = 'pending' or (${t.status} is null and ${t.ok} = false)) and ${t.nextAttemptAt} <= now()`;
      const claimed = await db
        .update(t)
        .set({ status: "sending", claimedAt: sql`now()`, nextAttemptAt: null })
        .where(inArray(t.id, sql`(select id from alert_delivery where ${due} order by next_attempt_at limit ${limit} for update skip locked)`))
        .returning();
      const out: DeliveryRetry[] = [];
      for (const delivery of claimed as AlertDelivery[]) {
        const [incident] = delivery.incidentId ? await db.select().from(schema.incident).where(eq(schema.incident.id, delivery.incidentId)) : [];
        const [monitor] = incident?.monitorId ? await db.select().from(schema.monitor).where(eq(schema.monitor.id, incident.monitorId)) : [];
        const [channel] = delivery.channelId ? await db.select().from(schema.alertChannel).where(eq(schema.alertChannel.id, delivery.channelId)) : [];
        if (incident && monitor && channel?.enabled) out.push({ delivery, incident, monitor, channel });
        else {
          // nothing left to deliver: say why instead of leaving the row hanging
          const why = !incident || !monitor ? "skipped: the incident or monitor was removed" : !channel ? "skipped: the channel was removed" : "skipped: channel disabled";
          await db.update(t).set({ status: "skipped", ok: false, statusMessage: why, error: why }).where(and(eq(t.id, delivery.id), eq(t.status, "sending")));
        }
      }
      return out;
    },
    async sweepStuckDeliveries(o) {
      const t = schema.alertDelivery;
      // an interrupted attempt counts as an attempt: after the last one the row is failed for good
      const gaveUp = await db
        .update(t)
        .set({ status: "failed", ok: false, attempts: sql`${t.attempts} + 1`, error: "The worker stopped before the alert was confirmed", statusMessage: "failed: the worker stopped before the alert was confirmed" })
        .where(and(eq(t.status, "sending"), lt(t.claimedAt, sql`now() - make_interval(secs => ${o.stuckSec})`), sql`${t.attempts} + 1 >= ${o.maxAttempts}`))
        .returning({ id: t.id });
      const back = await db
        .update(t)
        .set({ status: "pending", attempts: sql`${t.attempts} + 1`, nextAttemptAt: sql`now()`, statusMessage: "retrying: the worker stopped before the alert was confirmed" })
        .where(and(eq(t.status, "sending"), lt(t.claimedAt, sql`now() - make_interval(secs => ${o.stuckSec})`)))
        .returning({ id: t.id });
      // rows queued but never claimed (the dispatcher died in between) become retries too
      const orphans = await db
        .update(t)
        .set({ nextAttemptAt: sql`now()` })
        .where(and(eq(t.status, "pending"), isNull(t.nextAttemptAt), lt(t.createdAt, sql`now() - make_interval(secs => ${o.stuckSec})`)))
        .returning({ id: t.id });
      return gaveUp.length + back.length + orphans.length;
    },
    incidentDeliveries: (orgId, incidentId) =>
      db
        .select()
        .from(schema.alertDelivery)
        .where(and(eq(schema.alertDelivery.organizationId, orgId), eq(schema.alertDelivery.incidentId, incidentId)))
        .orderBy(asc(schema.alertDelivery.createdAt)) as unknown as Promise<AlertDelivery[]>,

    async scheduleFollowUps(inc, projectId) {
      if (!projectId) return;
      const [p] = await db.select().from(schema.project).where(eq(schema.project.id, projectId));
      if (!p) return;
      const first = p.escalation[0];
      const set: Partial<typeof schema.incident.$inferInsert> = {};
      if (p.reminderIntervalMin) set.nextReminderAt = new Date(Date.now() + p.reminderIntervalMin * 60_000);
      if (first) set.nextEscalationAt = new Date(inc.startedAt.getTime() + first.escalateAfterMin * 60_000);
      if (Object.keys(set).length) await db.update(schema.incident).set(set).where(and(eq(schema.incident.id, inc.id), isNull(schema.incident.resolvedAt), isNull(schema.incident.acknowledgedAt)));
    },
    async claimReminders(limit, skip) {
      const i = schema.incident;
      const out: ReminderDue[] = [];
      // Monitors under maintenance are left out in SQL, so a pile of them cannot fill the pages ahead of the incidents that
      // are due. `skip` covers whatever else the caller wants held back; those rows stay due, so a page of candidates can
      // consist of them alone: keep paging past them until `limit` is filled or nothing is left. The answer is remembered
      // per monitor within the call.
      const underMaintenance = sql`exists (
        select 1 from maintenance_window w
        where w.organization_id = ${schema.monitor.organizationId}
          and (w.project_id is null or w.project_id = ${schema.monitor.projectId})
          and w.starts_at <= now() and w.ends_at >= now()
          and (cardinality(w.monitor_ids) = 0 or ${schema.monitor.id} = any(w.monitor_ids))
      )`;
      const skipped = new Map<string, boolean>();
      const seen: string[] = [];
      const pageSize = Math.max(limit, 20);
      try {
        for (let page = 0; page < 20 && out.length < limit; page++) {
          const candidates = await db
            .select({ incident: i, monitor: schema.monitor, project: schema.project })
            .from(i)
            .innerJoin(schema.monitor, eq(schema.monitor.id, i.monitorId))
            .innerJoin(schema.project, eq(schema.project.id, schema.monitor.projectId))
            .where(and(lte(i.nextReminderAt, sql`now()`), isNull(i.acknowledgedAt), isNull(i.resolvedAt), sql`not ${underMaintenance}`, seen.length ? notInArray(i.id, seen) : undefined))
            .orderBy(asc(i.nextReminderAt))
            .limit(pageSize);
          for (const c of candidates) {
            if (out.length >= limit) break;
            seen.push(c.incident.id);
            if (skip) {
              if (!skipped.has(c.monitor.id)) {
                // a failing check of the skip rule must not hold the reminder back: when in doubt, send it
                skipped.set(c.monitor.id, await skip(c.monitor).catch((e) => (console.error("reminder skip check failed, not skipping", e), false)));
              }
              if (skipped.get(c.monitor.id)) continue;
            }
            const interval = c.project.reminderIntervalMin;
            const last = c.incident.reminderCount + 1 >= MAX_REMINDERS;
            // One conditional UPDATE decides who sends: it only matches the exact count and due time that were read, so a
            // second worker sees no row. The next repeat is counted from now, which folds any missed intervals into this one.
            const [won] = await db
              .update(i)
              .set(
                interval
                  ? { reminderCount: sql`${i.reminderCount} + 1`, nextReminderAt: last ? null : sql`now() + make_interval(mins => ${interval})` }
                  : { nextReminderAt: null },
              )
              .where(and(eq(i.id, c.incident.id), eq(i.reminderCount, c.incident.reminderCount), lte(i.nextReminderAt, sql`now()`), isNull(i.acknowledgedAt), isNull(i.resolvedAt)))
              .returning();
            // repeats switched off since the incident opened: the clock is simply cleared
            if (won && interval) out.push({ incident: won, monitor: c.monitor, project: { reminderIntervalMin: interval, reminderEmail: c.project.reminderEmail, escalation: c.project.escalation }, number: won.reminderCount });
          }
          if (candidates.length < pageSize) break;
        }
      } catch (e) {
        // rows already claimed have used up their repeat: hand them back to be sent rather than lose them with the error
        console.error("claiming reminders stopped early", e);
      }
      return out as unknown as ReminderDue[];
    },
    async claimEscalations(limit) {
      const i = schema.incident;
      const candidates = await db
        .select({ incident: i, monitor: schema.monitor, project: schema.project })
        .from(i)
        .innerJoin(schema.monitor, eq(schema.monitor.id, i.monitorId))
        .innerJoin(schema.project, eq(schema.project.id, schema.monitor.projectId))
        .where(and(lte(i.nextEscalationAt, sql`now()`), isNull(i.acknowledgedAt), isNull(i.resolvedAt)))
        .orderBy(asc(i.nextEscalationAt))
        .limit(limit);
      const out: EscalationDue[] = [];
      for (const c of candidates) {
        const steps = c.project.escalation;
        const step = steps[c.incident.escalationLevel];
        const after = steps[c.incident.escalationLevel + 1];
        const [won] = await db
          .update(i)
          .set({ escalationLevel: sql`${i.escalationLevel} + 1`, nextEscalationAt: after ? new Date(c.incident.startedAt.getTime() + after.escalateAfterMin * 60_000) : null })
          .where(and(eq(i.id, c.incident.id), eq(i.escalationLevel, c.incident.escalationLevel), lte(i.nextEscalationAt, sql`now()`), isNull(i.acknowledgedAt), isNull(i.resolvedAt)))
          .returning();
        // the step list was shortened since: nothing to send, the clock is cleared above
        if (won && step) out.push({ incident: won, monitor: c.monitor, step, level: won.escalationLevel });
      }
      return out;
    },
    async getProjectAlerting(orgId, projectId) {
      const [p] = await db.select().from(schema.project).where(and(eq(schema.project.id, projectId), eq(schema.project.organizationId, orgId)));
      return p ? { reminderIntervalMin: p.reminderIntervalMin, reminderEmail: p.reminderEmail, escalation: p.escalation } : null;
    },
    async saveProjectAlerting(orgId, projectId, v) {
      const [p] = await db.update(schema.project).set(v).where(and(eq(schema.project.id, projectId), eq(schema.project.organizationId, orgId))).returning();
      return p ? { reminderIntervalMin: p.reminderIntervalMin, reminderEmail: p.reminderEmail, escalation: p.escalation } : null;
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
    async subscribersFor(orgId, monitorId, projectId) {
      const base = db
        .select({ email: schema.statusSubscriber.email, locale: schema.statusSubscriber.locale, token: schema.statusSubscriber.token, slug: schema.statusPage.slug, title: schema.statusPage.title, hideBranding: schema.statusPage.hideBranding, monitorIds: schema.statusSubscriber.monitorIds })
        .from(schema.statusSubscriber)
        .innerJoin(schema.statusPage, eq(schema.statusPage.id, schema.statusSubscriber.statusPageId));
      // a manual incident has no monitor: it reaches only the pages of its own project (a page without one counts as the oldest project's)
      if (!monitorId) {
        const pid = projectId ?? null;
        const pageProject = sql`coalesce(${schema.statusPage.projectId}, (select p.id from project p where p.organization_id = ${schema.statusPage.organizationId} order by p.created_at, p.id limit 1))`;
        return base.where(and(eq(schema.statusPage.organizationId, orgId), isNotNull(schema.statusSubscriber.confirmedAt), sql`${pageProject} is not distinct from ${pid}::uuid`));
      }
      return base
        .innerJoin(
          schema.statusPageComponent,
          and(eq(schema.statusPageComponent.statusPageId, schema.statusPage.id), eq(schema.statusPageComponent.monitorId, monitorId), eq(schema.statusPageComponent.visible, true)),
        )
        .where(
          and(
            isNotNull(schema.statusSubscriber.confirmedAt),
            // a subscriber who picked components only hears about those
            or(sql`cardinality(${schema.statusSubscriber.monitorIds}) = 0`, sql`${monitorId} = any(${schema.statusSubscriber.monitorIds})`),
          ),
        );
    },
    async getSettings(orgId) {
      const [row] = await db.select().from(schema.workspaceSetting).where(eq(schema.workspaceSetting.organizationId, orgId));
      return {
        alertLogRetentionDays: row?.alertLogRetentionDays ?? DEFAULT_ALERT_LOG_DAYS,
        checkRetentionDays: row?.checkRetentionDays ?? DEFAULT_CHECK_RETENTION_DAYS,
        monthlyReport: row?.monthlyReport ?? false,
      };
    },
    async saveSettings(orgId, patch) {
      const [row] = await db
        .insert(schema.workspaceSetting)
        .values({ organizationId: orgId, ...patch })
        .onConflictDoUpdate({ target: schema.workspaceSetting.organizationId, set: patch })
        .returning();
      return { alertLogRetentionDays: row.alertLogRetentionDays, checkRetentionDays: row.checkRetentionDays, monthlyReport: row.monthlyReport };
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
      const projectId = await pageProjectId(page);
      // Everything below selects the page's monitors itself, so the reads run together instead of one after another.
      const shown = db
        .select({ id: schema.statusPageComponent.monitorId })
        .from(schema.statusPageComponent)
        .where(and(eq(schema.statusPageComponent.statusPageId, page.id), eq(schema.statusPageComponent.visible, true)));
      const mine = inArray(schema.checkRollup.monitorId, shown);

      // 90 buckets: daily for the last 90 days, or hourly while the history is still short
      // (otherwise one bad day at launch paints the whole bar red even after recovery)
      const series = (unit: "hour" | "day", since: Date) =>
        db
          .select({
            monitorId: schema.checkRollup.monitorId,
            day: sql<string>`to_char(date_trunc(${sql.raw(`'${unit}'`)}, ${schema.checkRollup.bucket}), ${sql.raw(unit === "hour" ? `'YYYY-MM-DD"T"HH24'` : `'YYYY-MM-DD'`)})`,
            total: sql<number>`sum(${schema.checkRollup.total})::int`,
            ok: sql<number>`sum(${schema.checkRollup.ok})::int`,
          })
          .from(schema.checkRollup)
          .where(and(mine, gte(schema.checkRollup.bucket, since)))
          .groupBy(schema.checkRollup.monitorId, sql`date_trunc(${sql.raw(`'${unit}'`)}, ${schema.checkRollup.bucket})`)
          .orderBy(sql`date_trunc(${sql.raw(`'${unit}'`)}, ${schema.checkRollup.bucket})`);
      const [comps, firstRows, hourlyDays, dailyDays, open] = await Promise.all([
        db
          .select({ c: schema.statusPageComponent, m: schema.monitor })
          .from(schema.statusPageComponent)
          .innerJoin(schema.monitor, eq(schema.monitor.id, schema.statusPageComponent.monitorId))
          .where(and(eq(schema.statusPageComponent.statusPageId, page.id), eq(schema.statusPageComponent.visible, true)))
          .orderBy(asc(schema.statusPageComponent.position)),
        db.select({ at: sql<string | null>`min(${schema.checkRollup.bucket})` }).from(schema.checkRollup).where(mine),
        series("hour", new Date(Date.now() - 90 * 36e5)),
        series("day", new Date(Date.now() - 90 * 864e5)),
        db
          .select()
          .from(schema.incident)
          .where(and(pageScope(page.organizationId, projectId, shown), isNull(schema.incident.resolvedAt)))
          .orderBy(desc(schema.incident.startedAt)),
      ]);
      const first = firstRows[0]?.at;
      const hourly = !first || Date.now() - new Date(first).getTime() < 4 * 864e5;
      const unit = hourly ? "hour" : "day";
      const days = hourly ? hourlyDays : dailyDays;

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
        .where(and(pageScope(page.organizationId, await pageProjectId(page), await pageMonitorIds(page.id)), o.before ? lt(schema.incident.startedAt, o.before) : undefined))
        .orderBy(desc(schema.incident.startedAt))
        .limit(o.limit);
      return withUpdates(list);
    },
    async subscriberCount(pageId) {
      const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.statusSubscriber).where(eq(schema.statusSubscriber.statusPageId, pageId));
      return r.n;
    },
    async addSubscriber(s) {
      const monitorIds = s.monitorIds ?? [];
      const [row] = await db
        .insert(schema.statusSubscriber)
        .values({ statusPageId: s.pageId, email: s.email, token: s.token, locale: s.locale, monitorIds })
        .onConflictDoNothing()
        .returning();
      if (row) return { locale: row.locale, token: row.token, confirmed: false, created: true };
      const [old] = await db
        .select()
        .from(schema.statusSubscriber)
        .where(and(eq(schema.statusSubscriber.statusPageId, s.pageId), eq(schema.statusSubscriber.email, s.email)));
      // A pending row takes the newest language and component choice: the confirmation mail is the consent, and the
      // person who asked again is the one holding the link. A confirmed row is never touched by a form anyone can submit.
      if (!old.confirmedAt) {
        const [fresh] = await db
          .update(schema.statusSubscriber)
          .set({ locale: s.locale, monitorIds })
          .where(and(eq(schema.statusSubscriber.id, old.id), isNull(schema.statusSubscriber.confirmedAt)))
          .returning();
        if (fresh) return { locale: fresh.locale, token: fresh.token, confirmed: false, created: false };
      }
      return { locale: old.locale, token: old.token, confirmed: !!old.confirmedAt, created: false };
    },
    async pageMaintenance(page, o) {
      const ids = await pageMonitorIds(page.id);
      const projectId = await pageProjectId(page);
      return db
        .select()
        .from(schema.maintenanceWindow)
        .where(
          and(
            eq(schema.maintenanceWindow.organizationId, page.organizationId),
            projectId ? or(isNull(schema.maintenanceWindow.projectId), eq(schema.maintenanceWindow.projectId, projectId)) : isNull(schema.maintenanceWindow.projectId),
            o.since ? gte(schema.maintenanceWindow.endsAt, o.since) : undefined,
            ids.length
              ? or(sql`cardinality(${schema.maintenanceWindow.monitorIds}) = 0`, sql`${schema.maintenanceWindow.monitorIds} && ${sql.raw("array[")}${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}${sql.raw("]")}`)
              : sql`cardinality(${schema.maintenanceWindow.monitorIds}) = 0`,
          ),
        )
        .orderBy(desc(schema.maintenanceWindow.startsAt))
        .limit(o.limit);
    },
    async claimMaintenanceReminders(limit) {
      const now = new Date();
      const due = await db
        .select({ w: schema.maintenanceWindow, p: schema.statusPage })
        .from(schema.maintenanceWindow)
        .innerJoin(
          schema.statusPage,
          and(
            eq(schema.statusPage.organizationId, schema.maintenanceWindow.organizationId),
            or(
              isNull(schema.maintenanceWindow.projectId),
              // a page without a project belongs to the workspace's oldest one, as everywhere else
              eq(schema.maintenanceWindow.projectId, sql`coalesce(${schema.statusPage.projectId}, (select p.id from project p where p.organization_id = ${schema.statusPage.organizationId} order by p.created_at, p.id limit 1))`),
            ),
          ),
        )
        .where(
          and(
            sql`${schema.statusPage.maintenanceReminderHours} > 0`,
            gte(schema.maintenanceWindow.startsAt, now),
            sql`${schema.maintenanceWindow.startsAt} <= now() + ${schema.statusPage.maintenanceReminderHours} * interval '1 hour'`,
            sql`not exists (select 1 from maintenance_reminder r where r.maintenance_id = ${schema.maintenanceWindow.id} and r.status_page_id = ${schema.statusPage.id})`,
            // nobody to remind: leave the window unclaimed, so a subscriber who joins later still hears about it. Tested here, not
            // after the limit, so windows nobody follows cannot crowd out ones somebody does.
            sql`exists (
              select 1 from status_subscriber s
              where s.status_page_id = ${schema.statusPage.id} and s.confirmed_at is not null
                and (cardinality(s.monitor_ids) = 0 or exists (
                  select 1 from status_page_component c
                  where c.status_page_id = ${schema.statusPage.id} and c.visible and c.monitor_id = any(s.monitor_ids)
                    and (cardinality(${schema.maintenanceWindow.monitorIds}) = 0 or c.monitor_id = any(${schema.maintenanceWindow.monitorIds}))
                ))
            )`,
            or(
              sql`cardinality(${schema.maintenanceWindow.monitorIds}) = 0`,
              sql`exists (select 1 from status_page_component c where c.status_page_id = ${schema.statusPage.id} and c.visible and c.monitor_id = any(${schema.maintenanceWindow.monitorIds}))`,
            ),
          ),
        )
        .limit(limit);
      const out: Awaited<ReturnType<Repo["claimMaintenanceReminders"]>> = [];
      for (const { w, p } of due) {
        const affected = w.monitorIds.length ? new Set(w.monitorIds) : null;
        const shown = new Set(await pageMonitorIds(p.id));
        const subs = await db
          .select()
          .from(schema.statusSubscriber)
          .where(and(eq(schema.statusSubscriber.statusPageId, p.id), isNotNull(schema.statusSubscriber.confirmedAt)));
        const subscribers = subs
          .filter((x) => !x.monitorIds.length || x.monitorIds.some((m) => shown.has(m) && (!affected || affected.has(m))))
          .map((x) => ({ email: x.email, locale: x.locale, token: x.token, slug: p.slug, title: p.title, hideBranding: p.hideBranding, monitorIds: x.monitorIds }));
        if (!subscribers.length) continue;
        // inserting the row is the claim: whoever gets it back sends, anyone else skips
        const claimed = await db.insert(schema.maintenanceReminder).values({ maintenanceId: w.id, statusPageId: p.id }).onConflictDoNothing().returning({ id: schema.maintenanceReminder.maintenanceId });
        if (!claimed.length) continue;
        out.push({ window: w, page: p, subscribers });
      }
      return out;
    },
    async releaseMaintenanceReminder(maintenanceId, statusPageId) {
      await db.delete(schema.maintenanceReminder).where(and(eq(schema.maintenanceReminder.maintenanceId, maintenanceId), eq(schema.maintenanceReminder.statusPageId, statusPageId)));
    },
    async claimMonthlyReports(month, limit) {
      const rows_ = await rows<{ organization_id: string }>(
        db.execute(sql`update workspace_setting set last_report_month = ${month}
          where organization_id in (select organization_id from workspace_setting where monthly_report and last_report_month is distinct from ${month} limit ${limit} for update skip locked)
          returning organization_id`),
      );
      return rows_.map((r) => r.organization_id);
    },
    async monthlyReport(orgId, from, to) {
      const comps = await db.select().from(schema.monitor).where(eq(schema.monitor.organizationId, orgId)).orderBy(asc(schema.monitor.name));
      if (!comps.length) return [];
      const ids = comps.map((m) => m.id);
      const [sums, incs] = await Promise.all([
        db
          .select({ monitorId: schema.checkRollup.monitorId, total: sql<number>`sum(${schema.checkRollup.total})::int`, ok: sql<number>`sum(${schema.checkRollup.ok})::int` })
          .from(schema.checkRollup)
          .where(and(inArray(schema.checkRollup.monitorId, ids), gte(schema.checkRollup.bucket, from), lt(schema.checkRollup.bucket, to)))
          .groupBy(schema.checkRollup.monitorId),
        db
          .select()
          .from(schema.incident)
          .where(and(inArray(schema.incident.monitorId, ids), lt(schema.incident.startedAt, to), or(isNull(schema.incident.resolvedAt), gte(schema.incident.resolvedAt, from)))),
      ]);
      return comps
        .map((m) => {
          const s = sums.find((x) => x.monitorId === m.id);
          const mine = incs.filter((i) => i.monitorId === m.id);
          const downMs = mine.reduce((a, i) => a + Math.max(0, Math.min(i.resolvedAt?.getTime() ?? to.getTime(), to.getTime()) - Math.max(i.startedAt.getTime(), from.getTime())), 0);
          return { name: m.name, uptime: s?.total ? Math.round((s.ok / s.total) * 10000) / 100 : null, downtimeMinutes: Math.round(downMs / 60000), incidents: mine.length, checked: !!s?.total };
        })
        .filter((c) => c.checked || c.incidents > 0)
        .map(({ checked: _c, ...c }) => c);
    },
    async ownerContacts(orgId) {
      return db
        .select({ email: schema.user.email, locale: schema.user.locale })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")));
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
