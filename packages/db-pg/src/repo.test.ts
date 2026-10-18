import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createRepo, eq, schema } from "./index";

const url = process.env.DATABASE_URL;
const db = url ? createDb(url, { max: 4 }) : (undefined as never);
const repo = url ? createRepo(db) : (undefined as never);

describe.skipIf(!url)("withinLimit", () => {
  it("allows up to the limit then blocks, per key", async () => {
    const k = `test:${crypto.randomUUID()}`;
    const r = [];
    for (let i = 0; i < 4; i++) r.push(await repo.withinLimit(k, 3, 60));
    expect(r).toEqual([true, true, true, false]);
    expect(await repo.withinLimit(`${k}:other`, 3, 60)).toBe(true);
  });

  it("starts a fresh window once the old one expires", async () => {
    const k = `test:${crypto.randomUUID()}`;
    expect(await repo.withinLimit(k, 1, 1)).toBe(true);
    expect(await repo.withinLimit(k, 1, 1)).toBe(false);
    await new Promise((r) => setTimeout(r, 1200));
    expect(await repo.withinLimit(k, 1, 1)).toBe(true);
  });
});

// Needs a migrated Postgres; skipped when DATABASE_URL is not set.
describe.skipIf(!url)("monitors and maintenance", () => {
  const orgId = `test-org-${crypto.randomUUID()}`;

  beforeAll(async () => {
    await db.insert(schema.organization).values({ id: orgId, name: "Test", slug: orgId, createdAt: new Date() });
  });
  afterAll(async () => {
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
  });

  const seed = (n: number) =>
    db
      .insert(schema.monitor)
      .values(Array.from({ length: n }, (_, i) => ({ organizationId: orgId, name: `m${i}`, type: "tcp" as const, target: "127.0.0.1:1", intervalSec: 60 })))
      .returning({ id: schema.monitor.id });

  it("leases each due monitor exactly once under concurrent claims", async () => {
    await seed(40);
    const claims = await Promise.all([repo.claimDue(1000), repo.claimDue(1000), repo.claimDue(1000)]);
    const mine = claims.flat().filter((m) => m.organizationId === orgId);
    expect(mine).toHaveLength(40);
    expect(new Set(mine.map((m) => m.id)).size).toBe(40);
    // leased monitors are no longer due
    expect((await repo.claimDue(1000)).filter((m) => m.organizationId === orgId)).toHaveLength(0);
  });

  it("honours maintenance windows scoped to a monitor or to the whole org", async () => {
    const [a, b] = await seed(2);
    const hour = 3600_000;
    await db.insert(schema.maintenanceWindow).values({
      organizationId: orgId, name: "scoped", startsAt: new Date(Date.now() - hour), endsAt: new Date(Date.now() + hour), monitorIds: [a.id],
    });
    const org = { organizationId: orgId, projectId: null };
    expect(await repo.underMaintenance({ id: a.id, ...org })).toBe(true);
    expect(await repo.underMaintenance({ id: b.id, ...org })).toBe(false);
    await db.insert(schema.maintenanceWindow).values({
      organizationId: orgId, name: "all", startsAt: new Date(Date.now() - hour), endsAt: new Date(Date.now() + hour), monitorIds: [],
    });
    expect(await repo.underMaintenance({ id: b.id, ...org })).toBe(true);
    // a window in the past does not count
    await db.delete(schema.maintenanceWindow).where(eq(schema.maintenanceWindow.organizationId, orgId));
    await db.insert(schema.maintenanceWindow).values({
      organizationId: orgId, name: "past", startsAt: new Date(Date.now() - 3 * hour), endsAt: new Date(Date.now() - 2 * hour), monitorIds: [],
    });
    expect(await repo.underMaintenance({ id: a.id, ...org })).toBe(false);
  });

  it("keeps a maintenance window inside its own project", async () => {
    const [pa] = await db.insert(schema.project).values({ organizationId: orgId, name: "A" }).returning();
    const [pb] = await db.insert(schema.project).values({ organizationId: orgId, name: "B" }).returning();
    const hour = 3600_000;
    await db.delete(schema.maintenanceWindow).where(eq(schema.maintenanceWindow.organizationId, orgId));
    await db.insert(schema.maintenanceWindow).values({
      organizationId: orgId, projectId: pa.id, name: "A only", startsAt: new Date(Date.now() - hour), endsAt: new Date(Date.now() + hour), monitorIds: [],
    });
    const m = { id: crypto.randomUUID(), organizationId: orgId };
    expect(await repo.underMaintenance({ ...m, projectId: pa.id })).toBe(true);
    expect(await repo.underMaintenance({ ...m, projectId: pb.id })).toBe(false);
  });

  it("anchors the next due time to the schedule, not to when the check finished", async () => {
    const [m] = await seed(1);
    const due = new Date(Date.now() - 5_000);
    await db.update(schema.monitor).set({ nextCheckAt: due }).where(eq(schema.monitor.id, m.id));
    const [leased] = (await repo.claimDue(1000)).filter((x) => x.id === m.id);
    expect(leased.nextCheckAt.getTime()).toBe(due.getTime() + 60_000);
    // a monitor that fell far behind restarts from now instead of catching up
    await db.update(schema.monitor).set({ nextCheckAt: new Date(Date.now() - 3600_000) }).where(eq(schema.monitor.id, m.id));
    const [late] = (await repo.claimDue(1000)).filter((x) => x.id === m.id);
    expect(late.nextCheckAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
  });

  it("starts a claimed run once, and hands unqueued claims back", async () => {
    const [m] = await seed(1);
    await db.update(schema.monitor).set({ nextCheckAt: new Date(Date.now() - 5_000) }).where(eq(schema.monitor.id, m.id));
    const [claim] = (await repo.claimDue(1000)).filter((x) => x.id === m.id);
    const run = { id: m.id, token: claim.nextCheckAt };
    // duplicates racing for the same run: exactly one wins
    const results = await Promise.all([repo.beginRuns([run]), repo.beginRuns([run]), repo.beginRuns([run])]);
    expect(results.flat()).toEqual([m.id]);
    // the next claim is a different run
    expect(await repo.beginRuns([{ id: m.id, token: new Date(run.token.getTime() + 60_000) }])).toEqual([m.id]);
    // an unqueued claim comes due again immediately
    await repo.releaseClaims([run]);
    const [again] = (await repo.claimDue(1000)).filter((x) => x.id === m.id);
    expect(again).toBeDefined();
    // a claim that has moved on since is left alone
    await repo.releaseClaims([run]);
    expect((await repo.claimDue(1000)).filter((x) => x.id === m.id)).toHaveLength(0);
  });

  it("dedupes outages separately from latency incidents", async () => {
    const [m] = await seed(1);
    await repo.createIncident({ organizationId: orgId, monitorId: m.id, title: "slow", auto: true, severity: "minor" });
    expect(await repo.hasOpenIncident(m.id, true)).toBe(true);
    expect(await repo.hasOpenIncident(m.id, false)).toBe(false);
    expect(await repo.hadIncidentSince(m.id, new Date(Date.now() - 60_000))).toBe(false);
    await repo.createIncident({ organizationId: orgId, monitorId: m.id, title: "down", auto: true });
    expect(await repo.hasOpenIncident(m.id, false)).toBe(true);
  });

  it("opens one automatic incident of a kind at a time and resolves each only once", async () => {
    const [m] = await seed(1);
    const open = (title: string, severity?: "minor") => repo.openAutoIncident({ organizationId: orgId, monitorId: m.id, title, auto: true, severity }, { status: "investigating", body: "x" });
    const racing = await Promise.all([open("down"), open("down"), open("down")]);
    expect(racing.filter(Boolean)).toHaveLength(1);
    // a latency incident is a different kind
    const slow = await open("slow", "minor");
    expect(slow).not.toBeNull();
    expect(await open("slow", "minor")).toBeNull();
    const down = racing.find(Boolean)!;
    const resolved = await Promise.all([repo.resolveIncident(down.id, "ok"), repo.resolveIncident(down.id, "ok")]);
    expect(resolved.filter(Boolean)).toHaveLength(1);
    // once resolved, a new outage may open
    expect(await open("down again")).not.toBeNull();
  });
});

describe.skipIf(!url)("status page reminders and monthly reports", () => {
  const orgId = `test-org-${crypto.randomUUID()}`;
  const hour = 3600_000;

  beforeAll(async () => {
    await db.insert(schema.organization).values({ id: orgId, name: "Test", slug: orgId, createdAt: new Date() });
  });
  afterAll(async () => {
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await db.$client.end();
  });

  async function page(reminderHours: number) {
    const [m] = await db.insert(schema.monitor).values({ organizationId: orgId, name: "api", type: "tcp", target: "127.0.0.1:1", intervalSec: 60 }).returning();
    const p = await repo.createStatusPage(orgId, (await db.insert(schema.project).values({ organizationId: orgId, name: `P${Math.random()}` }).returning())[0].id, { slug: `s${crypto.randomUUID().slice(0, 8)}`, title: "Acme" });
    await repo.updateStatusPage(p.id, { maintenanceReminderHours: reminderHours });
    await db.insert(schema.statusPageComponent).values({ statusPageId: p.id, monitorId: m.id });
    return { p, m };
  }
  const sub = (pageId: string, email: string, confirmed: boolean, monitorIds: string[] = []) =>
    db.insert(schema.statusSubscriber).values({ statusPageId: pageId, email, token: crypto.randomUUID(), confirmedAt: confirmed ? new Date() : null, monitorIds });

  it("claims each due reminder once, for confirmed subscribers who follow an affected component", async () => {
    const { p, m } = await page(24);
    const other = (await db.insert(schema.monitor).values({ organizationId: orgId, name: "other", type: "tcp", target: "127.0.0.1:1", intervalSec: 60 }).returning())[0];
    await sub(p.id, "all@example.com", true);
    await sub(p.id, "api@example.com", true, [m.id]);
    await sub(p.id, "other@example.com", true, [other.id]);
    await sub(p.id, "pending@example.com", false);
    await db.insert(schema.maintenanceWindow).values({
      organizationId: orgId, projectId: p.projectId, name: "soon", startsAt: new Date(Date.now() + 10 * hour), endsAt: new Date(Date.now() + 11 * hour), monitorIds: [m.id],
    });
    const mine = (r: Awaited<ReturnType<typeof repo.claimMaintenanceReminders>>) => r.filter((x) => x.page.id === p.id);
    const claims = (await Promise.all([repo.claimMaintenanceReminders(50), repo.claimMaintenanceReminders(50), repo.claimMaintenanceReminders(50)])).flatMap(mine);
    expect(claims).toHaveLength(1);
    expect(claims[0].subscribers.map((s) => s.email).sort()).toEqual(["all@example.com", "api@example.com"]);
    expect(mine(await repo.claimMaintenanceReminders(50))).toHaveLength(0);
  });

  it("does not remind early, when the page turned reminders off, or after the window started", async () => {
    const { p } = await page(0);
    const { p: later } = await page(2);
    await sub(p.id, "a@example.com", true);
    await sub(later.id, "b@example.com", true);
    for (const [name, start] of [["far", 30 * hour], ["past", -hour]] as const) {
      await db.insert(schema.maintenanceWindow).values({ organizationId: orgId, projectId: p.projectId, name, startsAt: new Date(Date.now() + start), endsAt: new Date(Date.now() + start + hour), monitorIds: [] });
      await db.insert(schema.maintenanceWindow).values({ organizationId: orgId, projectId: later.projectId, name, startsAt: new Date(Date.now() + start), endsAt: new Date(Date.now() + start + hour), monitorIds: [] });
    }
    // 10h ahead is inside 24h but outside this page's 2h lead
    await db.insert(schema.maintenanceWindow).values({ organizationId: orgId, projectId: later.projectId, name: "mid", startsAt: new Date(Date.now() + 10 * hour), endsAt: new Date(Date.now() + 11 * hour), monitorIds: [] });
    const got = (await repo.claimMaintenanceReminders(100)).filter((x) => x.page.id === p.id || x.page.id === later.id);
    expect(got).toHaveLength(0);
  });

  it("claims a monthly report once per workspace and month", async () => {
    await db.insert(schema.workspaceSetting).values({ organizationId: orgId, monthlyReport: true }).onConflictDoUpdate({ target: schema.workspaceSetting.organizationId, set: { monthlyReport: true, lastReportMonth: null } });
    const month = "2026-09";
    const claims = (await Promise.all([repo.claimMonthlyReports(month, 500), repo.claimMonthlyReports(month, 500)])).flat().filter((id) => id === orgId);
    expect(claims).toHaveLength(1);
    expect((await repo.claimMonthlyReports("2026-10", 500)).filter((id) => id === orgId)).toHaveLength(1);
  });

  it("summarises a month per component: uptime, downtime and incidents", async () => {
    const [m] = await db.insert(schema.monitor).values({ organizationId: orgId, name: "aaa-report", type: "tcp", target: "127.0.0.1:1", intervalSec: 60 }).returning();
    const from = new Date("2026-09-01T00:00:00Z");
    const to = new Date("2026-10-01T00:00:00Z");
    await db.insert(schema.checkRollup).values({ monitorId: m.id, bucket: new Date("2026-09-10T00:00:00Z"), total: 1000, ok: 990 } as never);
    await db.insert(schema.incident).values({ monitorId: m.id, organizationId: orgId, title: "down", status: "resolved", startedAt: new Date("2026-09-10T10:00:00Z"), resolvedAt: new Date("2026-09-10T10:30:00Z") } as never);
    const row = (await repo.monthlyReport(orgId, from, to)).find((c) => c.name === "aaa-report");
    expect(row).toEqual({ name: "aaa-report", uptime: 99, downtimeMinutes: 30, incidents: 1 });
    expect((await repo.ownerContacts(orgId)).length).toBe(0);
  });
});
