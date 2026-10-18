import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, createRepo, eq, schema, sql } from "./index";

const url = process.env.DATABASE_URL;
const db = url ? createDb(url, { max: 4 }) : (undefined as never);
const repo = url ? createRepo(db) : (undefined as never);

// one shared client for the whole file: closed once, after every suite has cleaned up
afterAll(async () => {
  if (url) await db.$client.end();
});

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

  it("reopens an outage resolved a moment ago, once, and leaves older and latency incidents alone", async () => {
    const [m] = await seed(1);
    const open = (title: string, severity?: "minor") => repo.openAutoIncident({ organizationId: orgId, monitorId: m.id, title, auto: true, severity, evaluationNote: "first" }, { status: "investigating", body: "x" });
    const since = new Date(Date.now() - 600_000);
    // nothing resolved yet
    expect(await repo.reopenIncident(m.id, since, "again", "n")).toBeNull();
    const down = (await open("down"))!;
    expect(down.evaluationNote).toBe("first");
    await repo.resolveIncident(down.id, "ok");
    const again = await Promise.all([repo.reopenIncident(m.id, since, "Failing again", "reopened"), repo.reopenIncident(m.id, since, "Failing again", "reopened")]);
    expect(again.filter(Boolean)).toHaveLength(1);
    const row = again.find(Boolean)!;
    expect(row).toMatchObject({ id: down.id, status: "investigating", resolvedAt: null, evaluationNote: "reopened" });
    const detail = await repo.incidentDetail(orgId, down.id);
    expect(detail!.updates.map((u) => u.body)).toEqual(["x", "ok", "Failing again"]);
    // resolved before the window: not reopened
    await repo.resolveIncident(down.id, "ok");
    expect(await repo.reopenIncident(m.id, new Date(Date.now() + 1000), "late", "n")).toBeNull();
    // a latency incident is never reopened
    const slow = (await open("slow", "minor"))!;
    await repo.resolveIncident(slow.id, "ok");
    await db.update(schema.incident).set({ resolvedAt: new Date(Date.now() - 800_000) }).where(eq(schema.incident.id, down.id));
    expect(await repo.reopenIncident(m.id, since, "x", "n")).toBeNull();
  });

  it("starts a reopened incident over: unacknowledged, with fresh reminder and escalation clocks", async () => {
    const [m] = await seed(1);
    const down = (await repo.openAutoIncident({ organizationId: orgId, monitorId: m.id, title: "down", auto: true }, { status: "investigating", body: "x" }))!;
    await db.update(schema.incident).set({ acknowledgedAt: new Date(), reminderCount: 3, escalationLevel: 2, nextReminderAt: new Date(), nextEscalationAt: new Date() }).where(eq(schema.incident.id, down.id));
    await repo.resolveIncident(down.id, "ok");
    const row = (await repo.reopenIncident(m.id, new Date(Date.now() - 600_000), "again", "n"))!;
    expect(row).toMatchObject({ id: down.id, acknowledgedAt: null, reminderCount: 0, escalationLevel: 0, nextReminderAt: null, nextEscalationAt: null });
  });

  it("leaves an incident a person resolved alone, and says when a person handled the current outage", async () => {
    const [m] = await seed(1);
    const userId = `u-${crypto.randomUUID()}`;
    await db.insert(schema.user).values({ id: userId, name: "T", email: `${userId}@example.test` });
    try {
      const since = new Date(Date.now() - 600_000);
      const down = (await repo.openAutoIncident({ organizationId: orgId, monitorId: m.id, title: "down", auto: true }, { status: "investigating", body: "x" }))!;
      expect(await repo.outageHandledByPerson(m.id)).toBe(false);
      await repo.postIncidentUpdate(orgId, down.id, { status: "resolved", body: "fixed by hand", authorId: userId });
      expect(await repo.reopenIncident(m.id, since, "again", "n")).toBeNull();
      expect(await repo.outageHandledByPerson(m.id)).toBe(true);
      // a passing check afterwards ends that outage: a later one is a new story
      await repo.recordCheck({ monitorId: m.id, region: "auto", ok: true });
      expect(await repo.outageHandledByPerson(m.id)).toBe(false);
    } finally {
      await db.delete(schema.user).where(eq(schema.user.id, userId));
    }
  });

  it("treats a resolve by a person (API key or agent included) as a person's even after the account is deleted, and does not count it as flapping", async () => {
    const [m] = await seed(1);
    const userId = `u-${crypto.randomUUID()}`;
    await db.insert(schema.user).values({ id: userId, name: "T", email: `${userId}@example.test` });
    const down = (await repo.openAutoIncident({ organizationId: orgId, monitorId: m.id, title: "down", auto: true }, { status: "investigating", body: "x" }))!;
    await repo.postIncidentUpdate(orgId, down.id, { status: "resolved", body: "by key", authorId: userId });
    expect(await repo.hadIncidentSince(m.id, new Date(Date.now() - 60_000))).toBe(false);
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    const [u] = await db.select().from(schema.incidentUpdate).where(eq(schema.incidentUpdate.incidentId, down.id));
    expect(u.authorId).toBeNull();
    expect(await repo.reopenIncident(m.id, new Date(Date.now() - 600_000), "again", "n")).toBeNull();
    expect(await repo.outageHandledByPerson(m.id)).toBe(true);
    // an incident the checks resolved still counts for flapping
    const [m2] = await seed(1);
    const auto = (await repo.openAutoIncident({ organizationId: orgId, monitorId: m2.id, title: "down", auto: true }, { status: "investigating", body: "x" }))!;
    await repo.resolveIncident(auto.id, "ok");
    expect(await repo.hadIncidentSince(m2.id, new Date(Date.now() - 60_000))).toBe(true);
  });

  it("ends a person's handling of an outage at the monitor's last status change, even when no run ever passes", async () => {
    const [m] = await seed(1);
    const userId = `u-${crypto.randomUUID()}`;
    await db.insert(schema.user).values({ id: userId, name: "T", email: `${userId}@example.test` });
    try {
      const down = (await repo.openAutoIncident({ organizationId: orgId, monitorId: m.id, title: "down", auto: true }, { status: "investigating", body: "x" }))!;
      await repo.postIncidentUpdate(orgId, down.id, { status: "resolved", body: "by hand", authorId: userId });
      // one region keeps failing, so no run is ever clean
      await repo.recordRegionResults(m.id, [{ region: "a", ok: true }, { region: "b", ok: false, error: "x" }], { ok: false });
      expect(await repo.outageHandledByPerson(m.id)).toBe(true);
      // the monitor went up and down again afterwards: a new outage, nobody has handled it
      await repo.setMonitorState(m.id, { status: "up" });
      await new Promise((r) => setTimeout(r, 10));
      await repo.setMonitorState(m.id, { status: "down" });
      expect(await repo.outageHandledByPerson(m.id)).toBe(false);
    } finally {
      await db.delete(schema.user).where(eq(schema.user.id, userId));
    }
  });

  it("moves the status change time only when the status changes", async () => {
    const [m] = await seed(1);
    const at = async () => (await db.select({ t: schema.monitor.statusChangedAt }).from(schema.monitor).where(eq(schema.monitor.id, m.id)))[0].t.getTime();
    await repo.setMonitorState(m.id, { status: "up" });
    const first = await at();
    await new Promise((r) => setTimeout(r, 20));
    await repo.setMonitorState(m.id, { status: "up", lastCheckedAt: new Date() });
    expect(await at()).toBe(first);
    await repo.setMonitorState(m.id, { status: "down" });
    expect(await at()).toBeGreaterThan(first);
  });

  it("withdraws a published postmortem when the incident is reopened", async () => {
    const [m] = await seed(1);
    const down = (await repo.openAutoIncident({ organizationId: orgId, monitorId: m.id, title: "down", auto: true }, { status: "investigating", body: "x" }))!;
    await repo.resolveIncident(down.id, "ok");
    await repo.updateIncidentWriteUp(orgId, down.id, { postmortem: "pm", publish: true });
    expect((await repo.reopenIncident(m.id, new Date(Date.now() - 600_000), "again", "n"))!.postmortemPublishedAt).toBeNull();
  });

  it("withdraws a published postmortem when a non-resolved update reopens the incident", async () => {
    const [m] = await seed(1);
    const down = (await repo.openAutoIncident({ organizationId: orgId, monitorId: m.id, title: "down", auto: true }, { status: "investigating", body: "x" }))!;
    await repo.postIncidentUpdate(orgId, down.id, { status: "resolved", body: "ok", visibility: "public" });
    await repo.updateIncidentWriteUp(orgId, down.id, { postmortem: "pm", publish: true });
    const open = await repo.postIncidentUpdate(orgId, down.id, { status: "investigating", body: "back", visibility: "public" });
    expect(open!.incident.postmortemPublishedAt).toBeNull();
    expect(open!.incident.postmortem).toBe("pm");
  });

  it("keeps a postmortem published while an update is posted on an incident that was never resolved", async () => {
    const [m] = await seed(1);
    const down = (await repo.openAutoIncident({ organizationId: orgId, monitorId: m.id, title: "down", auto: true }, { status: "investigating", body: "x" }))!;
    await repo.updateIncidentWriteUp(orgId, down.id, { postmortem: "pm", publish: true });
    const r = await repo.postIncidentUpdate(orgId, down.id, { status: "identified", body: "found", visibility: "public" });
    expect(r!.incident.postmortemPublishedAt).not.toBeNull();
  });

  it("does not count a passing region of a failing run as the monitor having passed", async () => {
    const [m] = await seed(1);
    const userId = `u-${crypto.randomUUID()}`;
    await db.insert(schema.user).values({ id: userId, name: "T", email: `${userId}@example.test` });
    try {
      const down = (await repo.openAutoIncident({ organizationId: orgId, monitorId: m.id, title: "down", auto: true }, { status: "investigating", body: "x" }))!;
      await repo.postIncidentUpdate(orgId, down.id, { status: "resolved", body: "by hand", authorId: userId });
      await repo.recordRegionResults(m.id, [{ region: "a", ok: true }, { region: "b", ok: false, error: "x" }], { ok: false });
      expect(await repo.outageHandledByPerson(m.id)).toBe(true);
      await repo.recordRegionResults(m.id, [{ region: "a", ok: true }, { region: "b", ok: true }], { ok: true });
      expect(await repo.outageHandledByPerson(m.id)).toBe(false);
    } finally {
      await db.delete(schema.user).where(eq(schema.user.id, userId));
    }
  });

  it("returns null instead of throwing when another incident is already open for the monitor", async () => {
    const [m] = await seed(1);
    const first = (await repo.openAutoIncident({ organizationId: orgId, monitorId: m.id, title: "down", auto: true }, { status: "investigating", body: "x" }))!;
    await repo.resolveIncident(first.id, "ok");
    const second = (await repo.openAutoIncident({ organizationId: orgId, monitorId: m.id, title: "down again", auto: true }, { status: "investigating", body: "x" }))!;
    // the resolved one cannot come back while the second is open (unique index on open automatic incidents)
    expect(await repo.reopenIncident(m.id, new Date(Date.now() - 600_000), "again", "n")).toBeNull();
    expect((await repo.openIncidents(m.id, false)).map((i) => i.id)).toEqual([second.id]);
  });

  it("clears a dependency when the monitor it points at is deleted", async () => {
    const [parent, child] = await seed(2);
    await db.update(schema.monitor).set({ dependsOnMonitorId: parent.id }).where(eq(schema.monitor.id, child.id));
    await db.delete(schema.monitor).where(eq(schema.monitor.id, parent.id));
    const [row] = await db.select().from(schema.monitor).where(eq(schema.monitor.id, child.id));
    expect(row.dependsOnMonitorId).toBeNull();
    expect(row.minRegionsFailing).toBe(0);
  });
});

// Incident numbers, internal updates and the migration backfill; needs a migrated Postgres.
describe.skipIf(!url)("incident numbers and update visibility", () => {
  const orgId = `test-org-${crypto.randomUUID()}`;
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    await db.insert(schema.organization).values({ id: orgId, name: "Test", slug: orgId, createdAt: new Date() });
    [{ id: projectId }] = await db.insert(schema.project).values({ organizationId: orgId, name: "A" }).returning({ id: schema.project.id });
    [{ id: otherProjectId }] = await db.insert(schema.project).values({ organizationId: orgId, name: "B" }).returning({ id: schema.project.id });
  });
  afterAll(async () => {
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
  });

  const monitorIn = async (project: string) =>
    (await db.insert(schema.monitor).values({ organizationId: orgId, projectId: project, name: "m", type: "tcp" as const, target: "127.0.0.1:1", intervalSec: 60 }).returning())[0];

  it("hands out gap-free numbers per project, also under concurrency", async () => {
    const m = await monitorIn(projectId);
    const made = await Promise.all([
      ...Array.from({ length: 6 }, (_, k) => repo.createIncident({ organizationId: orgId, projectId, title: `w${k}` })),
      ...Array.from({ length: 6 }, (_, k) => repo.createIncident({ organizationId: orgId, monitorId: m.id, title: `m${k}` })),
    ]);
    expect(made.map((i) => i.number).sort((a, b) => a! - b!)).toEqual(Array.from({ length: 12 }, (_, k) => k + 1));
    expect(made.every((i) => i.projectId === projectId)).toBe(true);
    // the other project counts from 1 on its own
    expect((await repo.createIncident({ organizationId: orgId, projectId: otherProjectId, title: "x" })).number).toBe(1);
  });

  it("does not use up a number when an automatic incident loses the race", async () => {
    const m = await monitorIn(otherProjectId);
    const open = () => repo.openAutoIncident({ organizationId: orgId, monitorId: m.id, title: "down", auto: true }, { status: "investigating", body: "x" });
    const won = (await Promise.all([open(), open(), open()])).filter(Boolean);
    expect(won).toHaveLength(1);
    expect(await open()).toBeNull();
    const next = await repo.createIncident({ organizationId: orgId, projectId: otherProjectId, title: "after" });
    expect(next.number).toBe(won[0]!.number! + 1);
  });

  it("keeps the number and project when the monitor is deleted, and filters the list by project", async () => {
    const m = await monitorIn(projectId);
    const inc = await repo.createIncident({ organizationId: orgId, monitorId: m.id, title: "orphan" });
    await db.delete(schema.monitor).where(eq(schema.monitor.id, m.id));
    const [row] = await db.select().from(schema.incident).where(eq(schema.incident.id, inc.id));
    expect(row).toMatchObject({ monitorId: null, projectId, number: inc.number });
    expect((await repo.listIncidents(orgId, projectId)).some((i) => i.id === inc.id)).toBe(true);
    expect((await repo.listIncidents(orgId, otherProjectId)).some((i) => i.id === inc.id)).toBe(false);
    expect(await repo.incidentVisible(orgId, inc.id, [projectId])).toBe(true);
    expect(await repo.incidentVisible(orgId, inc.id, [otherProjectId])).toBe(false);
  });

  it("sets and clears the write-up without touching other fields", async () => {
    const inc = await repo.createIncident({ organizationId: orgId, projectId, title: "wu" });
    expect(await repo.updateIncidentWriteUp(orgId, inc.id, { rootCause: "disk", postmortem: "text" })).toMatchObject({ rootCause: "disk", postmortem: "text" });
    expect(await repo.updateIncidentWriteUp(orgId, inc.id, { rootCause: null })).toMatchObject({ rootCause: null, postmortem: "text" });
    expect(await repo.updateIncidentWriteUp(orgId, inc.id, {})).toMatchObject({ postmortem: "text" });
    expect(await repo.updateIncidentWriteUp(`${orgId}-other`, inc.id, { rootCause: "x" })).toBeNull();
  });

  it("keeps internal updates off every public read path but shows them to the team", async () => {
    const m = await monitorIn(projectId);
    const [page] = await db.insert(schema.statusPage).values({ organizationId: orgId, projectId, slug: `p${crypto.randomUUID().slice(0, 8)}`, title: "T" }).returning();
    await db.insert(schema.statusPageComponent).values({ statusPageId: page.id, monitorId: m.id });
    const inc = await repo.createIncident({ organizationId: orgId, monitorId: m.id, title: "vis" }, { status: "investigating", body: "first-internal", visibility: "internal" });
    await repo.postIncidentUpdate(orgId, inc.id, { status: "identified", body: "shown" });
    await repo.postIncidentUpdate(orgId, inc.id, { status: "monitoring", body: "hidden-note", visibility: "internal" });

    const bodies = (list: { updates: { body: string }[] }[]) => list.flatMap((i) => i.updates.map((u) => u.body));
    const board = await repo.statusBoard(page as never);
    expect(bodies(board.incidents)).toEqual(["shown"]);
    expect(bodies(await repo.pageIncidents(page as never, { limit: 10 }))).toEqual(["shown"]);
    const detail = await repo.incidentDetail(orgId, inc.id);
    expect(detail!.updates.map((u) => [u.body, u.visibility])).toEqual([["first-internal", "internal"], ["shown", "public"], ["hidden-note", "internal"]]);
  });

  it("backfills numbers by start time in the migration", async () => {
    const [p] = await db.insert(schema.project).values({ organizationId: orgId, name: "Legacy" }).returning();
    const m = await monitorIn(p.id);
    const at = (min: number) => new Date(Date.now() - min * 60_000);
    // inserted newest first, without project or number, as they exist before the migration
    const rows = await db.insert(schema.incident).values([
      { organizationId: orgId, monitorId: m.id, title: "third", startedAt: at(1) },
      { organizationId: orgId, monitorId: m.id, title: "first", startedAt: at(30) },
      { organizationId: orgId, monitorId: m.id, title: "second", startedAt: at(10) },
    ]).returning();
    const file = (await import("node:fs")).readFileSync(new URL("../drizzle/0023_lucky_cloak.sql", import.meta.url), "utf8");
    const backfill = file.split("--> statement-breakpoint").map((x) => x.trim()).filter((x) => /UPDATE "(incident|project)"/.test(x));
    expect(backfill.length).toBeGreaterThan(0);
    // run in a transaction that is rolled back, so other rows keep their numbers; the unique index is created after the
    // backfill in the real migration, so it is dropped here
    const rollback = new Error("rollback");
    let byTitle: Record<string, number | null> = {};
    let seq = -1;
    await db
      .transaction(async (tx) => {
        await tx.execute(sql`drop index incident_project_number_idx`);
        for (const stmt of backfill) await tx.execute(sql.raw(stmt));
        byTitle = Object.fromEntries((await tx.select().from(schema.incident).where(eq(schema.incident.projectId, p.id))).map((i) => [i.title, i.number]));
        seq = (await tx.select().from(schema.project).where(eq(schema.project.id, p.id)))[0].incidentSeq;
        throw rollback;
      })
      .catch((e) => {
        if (e !== rollback) throw e;
      });
    expect(byTitle).toEqual({ first: 1, second: 2, third: 3 });
    expect(seq).toBe(3);
    expect(rows).toHaveLength(3);
  });
});

describe.skipIf(!url)("alert deliveries, reminders and escalation", () => {
  const orgId = `test-org-${crypto.randomUUID()}`;
  let projectId: string;
  let channelId: string;
  let monitorId: string;
  const userId = `u-${orgId}`;

  beforeAll(async () => {
    await db.insert(schema.organization).values({ id: orgId, name: "Test", slug: orgId, createdAt: new Date() });
    await db.insert(schema.user).values({ id: userId, name: "T", email: `${userId}@example.test` });
    [{ id: projectId }] = await db.insert(schema.project).values({ organizationId: orgId, name: "P" }).returning({ id: schema.project.id });
    [{ id: channelId }] = await db.insert(schema.alertChannel).values({ organizationId: orgId, projectId, type: "webhook", name: "hook", config: { url: "https://x.example" } }).returning({ id: schema.alertChannel.id });
    [{ id: monitorId }] = await db.insert(schema.monitor).values({ organizationId: orgId, projectId, name: "m", type: "tcp", target: "127.0.0.1:1" }).returning({ id: schema.monitor.id });
  });
  afterAll(async () => {
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
  });

  // One open automatic incident is allowed per monitor, so each incident gets its own monitor.
  const incident = async (over: Partial<typeof schema.incident.$inferInsert> = {}) => {
    const [m] = await db.insert(schema.monitor).values({ organizationId: orgId, projectId, name: "m", type: "tcp", target: "127.0.0.1:1" }).returning({ id: schema.monitor.id });
    return (await db.insert(schema.incident).values({ organizationId: orgId, monitorId: m.id, title: "down", auto: true, severity: "major", ...over }).returning())[0];
  };
  const queue = async (incidentId: string | null, over: Record<string, unknown> = {}) =>
    (await repo.queueDeliveries([{ organizationId: orgId, projectId, channelId, channelName: "hook", channelType: "webhook", kind: "incident.opened", incidentId, ok: false, ...over }]))[0];
  const row = async (id: string) => (await db.select().from(schema.alertDelivery).where(eq(schema.alertDelivery.id, id)))[0];
  const ago = (min: number) => new Date(Date.now() - min * 60_000);

  it("lets exactly one of many concurrent workers claim a delivery", async () => {
    const d = await queue(null);
    const claims = await Promise.all(Array.from({ length: 8 }, () => repo.claimDelivery(d.id)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await row(d.id)).status).toBe("sending");
    expect((await row(d.id)).claimedAt).not.toBeNull();
    await repo.finishDelivery(d.id, { status: "sent", error: null, message: null });
    expect(await repo.claimDelivery(d.id)).toBeNull();
    // a late finisher cannot overwrite the recorded outcome
    await repo.finishDelivery(d.id, { status: "failed", error: "late", message: "failed: late", retryInSec: 60 });
    expect(await row(d.id)).toMatchObject({ status: "sent", ok: true, attempts: 1 });
  });

  it("claims each due retry once under concurrent callers, and only when it is due", async () => {
    const inc = await incident();
    const ds = await Promise.all(Array.from({ length: 6 }, () => queue(inc.id)));
    for (const d of ds) {
      await repo.claimDelivery(d.id);
      await repo.finishDelivery(d.id, { status: "failed", error: "HTTP 500", message: "failed: HTTP 500", retryInSec: 3600 });
    }
    // waiting for its time: not claimable
    expect(await repo.claimDelivery(ds[0].id)).toBeNull();
    expect((await repo.claimRetries(100)).filter((r) => r.delivery.incidentId === inc.id)).toHaveLength(0);
    await db.update(schema.alertDelivery).set({ nextAttemptAt: ago(1) }).where(eq(schema.alertDelivery.incidentId, inc.id));
    const got = (await Promise.all([repo.claimRetries(4), repo.claimRetries(4), repo.claimRetries(4)])).flat().filter((r) => r.delivery.incidentId === inc.id);
    expect(got).toHaveLength(6);
    expect(new Set(got.map((r) => r.delivery.id)).size).toBe(6);
    expect(got.every((r) => r.delivery.status === "sending")).toBe(true);
  });

  it("marks a retry skipped, with the reason, when its channel was switched off", async () => {
    const inc = await incident();
    const d = await queue(inc.id);
    await repo.claimDelivery(d.id);
    await repo.finishDelivery(d.id, { status: "failed", error: "x", message: "failed: x", retryInSec: 0 });
    await db.update(schema.alertChannel).set({ enabled: false }).where(eq(schema.alertChannel.id, channelId));
    await db.update(schema.alertDelivery).set({ nextAttemptAt: ago(1) }).where(eq(schema.alertDelivery.id, d.id));
    expect((await repo.claimRetries(100)).filter((r) => r.delivery.id === d.id)).toHaveLength(0);
    expect(await row(d.id)).toMatchObject({ status: "skipped", statusMessage: "skipped: channel disabled" });
    await db.update(schema.alertChannel).set({ enabled: true }).where(eq(schema.alertChannel.id, channelId));
  });

  it("hands rows stuck in sending back, and fails them after the last attempt", async () => {
    const stuck = await queue(null);
    const last = await queue(null);
    const fresh = await queue(null);
    const orphan = await queue(null);
    for (const d of [stuck, last, fresh]) await repo.claimDelivery(d.id);
    await db.update(schema.alertDelivery).set({ claimedAt: ago(10) }).where(eq(schema.alertDelivery.id, stuck.id));
    await db.update(schema.alertDelivery).set({ claimedAt: ago(10), attempts: 2 }).where(eq(schema.alertDelivery.id, last.id));
    await db.update(schema.alertDelivery).set({ createdAt: ago(10) }).where(eq(schema.alertDelivery.id, orphan.id));
    expect(await repo.sweepStuckDeliveries({ stuckSec: 300, maxAttempts: 3 })).toBeGreaterThanOrEqual(3);
    expect(await row(stuck.id)).toMatchObject({ status: "pending", attempts: 1 });
    expect((await row(stuck.id)).nextAttemptAt).not.toBeNull();
    expect(await row(last.id)).toMatchObject({ status: "failed", attempts: 3 });
    expect((await row(last.id)).statusMessage).toMatch(/^failed:/);
    expect((await row(fresh.id)).status).toBe("sending");
    expect((await row(orphan.id)).nextAttemptAt).not.toBeNull();
    // the swept row is claimable again, exactly once
    expect((await Promise.all([repo.claimDelivery(stuck.id), repo.claimDelivery(stuck.id)])).filter(Boolean)).toHaveLength(1);
  });

  describe("reminders", () => {
    beforeAll(async () => {
      await db.update(schema.project).set({ reminderIntervalMin: 5 }).where(eq(schema.project.id, projectId));
    });
    const due = async (id: string, patch: Partial<typeof schema.incident.$inferInsert> = {}) =>
      db.update(schema.incident).set({ nextReminderAt: ago(1), ...patch }).where(eq(schema.incident.id, id));
    const claim = async (id: string, n = 5) => (await Promise.all(Array.from({ length: n }, () => repo.claimReminders(100)))).flat().filter((r) => r.incident.id === id);
    const get = async (id: string) => (await db.select().from(schema.incident).where(eq(schema.incident.id, id)))[0];

    it("leaves a skipped monitor's repeat unclaimed and uncounted", async () => {
      const inc = await incident();
      await due(inc.id);
      const skipped = await repo.claimReminders(100, async (m) => m.id === inc.monitorId);
      expect(skipped.filter((r) => r.incident.id === inc.id)).toHaveLength(0);
      expect(await get(inc.id)).toMatchObject({ reminderCount: 0 });
      expect((await repo.claimReminders(100)).filter((r) => r.incident.id === inc.id)).toHaveLength(1);
    });

    it("never claims a monitor under maintenance, however many of them are due ahead of a real one", async () => {
      const held: string[] = [];
      for (let n = 0; n < 45; n++) {
        const inc = await incident();
        await due(inc.id, { nextReminderAt: ago(2000 + n) });
        held.push(inc.monitorId!);
      }
      await db.insert(schema.maintenanceWindow).values({ organizationId: orgId, projectId, name: "w", startsAt: ago(5), endsAt: new Date(Date.now() + 3600_000), monitorIds: held });
      const free = await incident();
      await due(free.id);
      try {
        // no skip rule at all: the window alone keeps them out
        expect((await repo.claimReminders(1)).map((r) => r.incident.id)).toEqual([free.id]);
      } finally {
        await db.delete(schema.maintenanceWindow).where(eq(schema.maintenanceWindow.organizationId, orgId));
      }
      // once the window is gone they are due again, uncounted
      const back = await repo.claimReminders(100);
      expect(back.filter((r) => held.includes(r.monitor.id))).toHaveLength(45);
    });

    it("sends a reminder when the skip rule itself fails, and keeps what it already claimed when a later step fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const inc = await incident();
      await due(inc.id);
      const got = await repo.claimReminders(100, async () => { throw new Error("boom"); });
      expect(got.filter((r) => r.incident.id === inc.id)).toHaveLength(1);
      vi.restoreAllMocks();
    });

    it("does not let skipped monitors starve the others, and asks about each monitor once", async () => {
      const blocked: string[] = [];
      for (let n = 0; n < 6; n++) {
        const inc = await incident();
        await due(inc.id, { nextReminderAt: ago(1000 + n) });
        blocked.push(inc.monitorId!);
      }
      const free = await incident();
      await due(free.id);
      const asked: string[] = [];
      const got = await repo.claimReminders(1, async (m) => (asked.push(m.id), blocked.includes(m.id)));
      expect(got.map((r) => r.incident.id)).toEqual([free.id]);
      expect(new Set(asked).size).toBe(asked.length);
    });

    it("starts the clock when an incident opens, and sends each repeat once however many workers run", async () => {
      const inc = await incident();
      await repo.scheduleFollowUps(inc, projectId);
      const scheduled = (await get(inc.id)).nextReminderAt!;
      expect(scheduled.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
      await due(inc.id);
      const got = await claim(inc.id);
      expect(got).toHaveLength(1);
      expect(got[0].number).toBe(1);
      const after = await get(inc.id);
      expect(after.reminderCount).toBe(1);
      expect(after.nextReminderAt!.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
      expect(await claim(inc.id)).toHaveLength(0);
    });

    it("sends only the latest repeat after several intervals were missed", async () => {
      const inc = await incident();
      await due(inc.id, { nextReminderAt: ago(180) });
      expect(await claim(inc.id)).toHaveLength(1);
      expect(await claim(inc.id)).toHaveLength(0);
      expect((await get(inc.id)).reminderCount).toBe(1);
    });

    it("stops at ten repeats, and when the incident is acknowledged or resolved", async () => {
      const capped = await incident();
      await due(capped.id, { reminderCount: 9 });
      expect((await claim(capped.id))[0].number).toBe(10);
      expect((await get(capped.id)).nextReminderAt).toBeNull();

      const acked = await incident();
      await due(acked.id);
      await repo.acknowledgeIncident(orgId, acked.id, userId);
      expect(await claim(acked.id)).toHaveLength(0);
      expect((await get(acked.id)).nextReminderAt).toBeNull();

      const done = await incident();
      await due(done.id);
      await repo.resolveIncident(done.id, "ok");
      expect(await claim(done.id)).toHaveLength(0);
    });

    it("drops the clock when repeats were switched off after the incident opened", async () => {
      const inc = await incident();
      await due(inc.id);
      await db.update(schema.project).set({ reminderIntervalMin: null }).where(eq(schema.project.id, projectId));
      expect(await claim(inc.id)).toHaveLength(0);
      expect((await get(inc.id)).nextReminderAt).toBeNull();
      await db.update(schema.project).set({ reminderIntervalMin: 5 }).where(eq(schema.project.id, projectId));
    });
  });

  describe("escalation", () => {
    const get = async (id: string) => (await db.select().from(schema.incident).where(eq(schema.incident.id, id)))[0];
    const claim = async (id: string, n = 5) => (await Promise.all(Array.from({ length: n }, () => repo.claimEscalations(100)))).flat().filter((r) => r.incident.id === id);

    it("fires each level once, in order, and stops when the incident is acknowledged", async () => {
      await repo.saveProjectAlerting(orgId, projectId, { reminderIntervalMin: null, reminderEmail: false, escalation: [{ channelIds: [channelId], escalateAfterMin: 10 }, { channelIds: [channelId], escalateAfterMin: 30 }] });
      const inc = await incident({ startedAt: ago(20) });
      await repo.scheduleFollowUps(inc, projectId);
      // level one is due 10 minutes after the start, level two is not due yet
      let got = await claim(inc.id);
      expect(got).toHaveLength(1);
      expect(got[0].level).toBe(1);
      expect(await claim(inc.id)).toHaveLength(0);
      await db.update(schema.incident).set({ startedAt: ago(40) }).where(eq(schema.incident.id, inc.id));
      await db.update(schema.incident).set({ nextEscalationAt: ago(1) }).where(eq(schema.incident.id, inc.id));
      got = await claim(inc.id);
      expect(got).toHaveLength(1);
      expect(got[0].level).toBe(2);
      expect((await get(inc.id)).nextEscalationAt).toBeNull();

      const acked = await incident({ startedAt: ago(60) });
      await repo.scheduleFollowUps(acked, projectId);
      const d = await queue(acked.id);
      await repo.acknowledgeIncident(orgId, acked.id, userId);
      expect(await claim(acked.id)).toHaveLength(0);
      expect((await row(d.id)).acknowledgedAt).not.toBeNull();
    });

    it("does not fire for a resolved incident", async () => {
      const inc = await incident({ startedAt: ago(60) });
      await repo.scheduleFollowUps(inc, projectId);
      await repo.resolveIncident(inc.id, "ok");
      expect(await claim(inc.id)).toHaveLength(0);
    });
  });

  describe("push devices", () => {
    it("keeps critical unless re-registered with a value, and housekeeping drops devices unseen for 180 days", async () => {
      const tok = (c: string) => `${c}`.repeat(64).slice(0, 64);
      const [fresh, old] = [tok("e"), tok("f")];
      const d = await repo.upsertPushDevice(userId, { token: fresh, platform: "ios", environment: "production" });
      expect(d.critical).toBe(false);
      expect((await repo.upsertPushDevice(userId, { token: fresh, platform: "ios", environment: "production", critical: true })).critical).toBe(true);
      expect((await repo.upsertPushDevice(userId, { token: fresh, platform: "ios", environment: "production" })).critical).toBe(true);
      expect((await repo.upsertPushDevice(userId, { token: fresh, platform: "ios", environment: "production", critical: false })).critical).toBe(false);

      await repo.upsertPushDevice(userId, { token: old, platform: "ios", environment: "production" });
      await db.update(schema.pushDevice).set({ lastSeenAt: new Date(Date.now() - 181 * 864e5) }).where(eq(schema.pushDevice.token, old));
      await repo.purgeExpired();
      const left = (await repo.listPushDevices(userId)).map((x) => x.token);
      expect(left).toContain(fresh);
      expect(left).not.toContain(old);
    });
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

  it("leaves a window unclaimed while nobody could be reminded, and gives a claim back on request", async () => {
    const { p, m } = await page(24);
    await db.insert(schema.maintenanceWindow).values({ organizationId: orgId, projectId: p.projectId, name: "soon", startsAt: new Date(Date.now() + 10 * hour), endsAt: new Date(Date.now() + 11 * hour), monitorIds: [m.id] });
    const mine = (r: Awaited<ReturnType<typeof repo.claimMaintenanceReminders>>) => r.filter((x) => x.page.id === p.id);
    await sub(p.id, "pending@example.com", false);
    expect(mine(await repo.claimMaintenanceReminders(100))).toHaveLength(0);
    // a subscriber who confirms later still gets the reminder
    await sub(p.id, "late@example.com", true);
    const [claim] = mine(await repo.claimMaintenanceReminders(100));
    expect(claim.subscribers.map((x) => x.email)).toEqual(["late@example.com"]);
    expect(mine(await repo.claimMaintenanceReminders(100))).toHaveLength(0);
    // a send that failed gives the claim back, and the next tick picks it up
    await repo.releaseMaintenanceReminder(claim.window.id, p.id);
    expect(mine(await repo.claimMaintenanceReminders(100))).toHaveLength(1);
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

describe.skipIf(!url)("manual incidents stay inside their project", () => {
  const orgId = `test-org-${crypto.randomUUID()}`;
  beforeAll(async () => {
    await db.insert(schema.organization).values({ id: orgId, name: "Test", slug: orgId, createdAt: new Date() });
  });
  afterAll(async () => {
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
  });

  it("shows a monitor-less incident only on pages and to subscribers of its own project", async () => {
    const [pa] = await db.insert(schema.project).values({ organizationId: orgId, name: "A", createdAt: new Date(Date.now() - 1000) }).returning();
    const [pb] = await db.insert(schema.project).values({ organizationId: orgId, name: "B" }).returning();
    const pageA = await repo.createStatusPage(orgId, pa.id, { slug: `a${crypto.randomUUID().slice(0, 8)}`, title: "A" });
    const pageB = await repo.createStatusPage(orgId, pb.id, { slug: `b${crypto.randomUUID().slice(0, 8)}`, title: "B" });
    // a page without a project counts as the oldest project's
    const created = await repo.createStatusPage(orgId, pa.id, { slug: `n${crypto.randomUUID().slice(0, 8)}`, title: "N" });
    await db.update(schema.statusPage).set({ projectId: null }).where(eq(schema.statusPage.id, created.id));
    const pageNone = { ...created, projectId: null };
    for (const [pg, email] of [[pageA, "a@x.test"], [pageB, "b@x.test"], [pageNone, "n@x.test"]] as const) {
      await db.insert(schema.statusSubscriber).values({ statusPageId: pg.id, email, token: crypto.randomUUID(), confirmedAt: new Date() });
    }
    const inc = await repo.createIncident({ organizationId: orgId, projectId: pb.id, title: "only-b", auto: false }, { status: "investigating", body: "x", visibility: "public" });
    expect(inc.projectId).toBe(pb.id);

    const titles = async (pg: typeof pageA) => [(await repo.pageIncidents(pg, { limit: 10 })).map((i) => i.title), (await repo.statusBoard(pg)).incidents.map((i) => i.title)];
    expect(await titles(pageB)).toEqual([["only-b"], ["only-b"]]);
    expect(await titles(pageA)).toEqual([[], []]);
    expect(await titles(pageNone)).toEqual([[], []]);
    expect((await repo.subscribersFor(orgId, null, pb.id)).map((s) => s.email)).toEqual(["b@x.test"]);
    expect((await repo.subscribersFor(orgId, null, pa.id)).map((s) => s.email).sort()).toEqual(["a@x.test", "n@x.test"]);

    // an incident of the oldest project reaches the project-less page too
    const first = await repo.createIncident({ organizationId: orgId, projectId: pa.id, title: "only-a", auto: false });
    expect((await repo.pageIncidents(pageNone, { limit: 10 })).map((i) => i.title)).toEqual([first.title]);
  });

  it("lets a repeated sign-up update a pending subscriber but never a confirmed one", async () => {
    const pr = (await db.insert(schema.project).values({ organizationId: orgId, name: "C" }).returning())[0];
    const pg = await repo.createStatusPage(orgId, pr.id, { slug: `c${crypto.randomUUID().slice(0, 8)}`, title: "C" });
    const mid = crypto.randomUUID();
    const rows = () => db.select().from(schema.statusSubscriber).where(eq(schema.statusSubscriber.statusPageId, pg.id));
    await repo.addSubscriber({ pageId: pg.id, email: "p@x.test", token: "t1", locale: "zh-CN", monitorIds: [] });
    // still pending: the newest language and choice win, the token stays
    const again = await repo.addSubscriber({ pageId: pg.id, email: "p@x.test", token: "t2", locale: "en", monitorIds: [mid] });
    expect(again).toMatchObject({ locale: "en", token: "t1", confirmed: false, created: false });
    expect((await rows())[0]).toMatchObject({ locale: "en", monitorIds: [mid] });
    // confirmed: left alone
    await db.update(schema.statusSubscriber).set({ confirmedAt: new Date() }).where(eq(schema.statusSubscriber.statusPageId, pg.id));
    const third = await repo.addSubscriber({ pageId: pg.id, email: "p@x.test", token: "t3", locale: "zh-CN", monitorIds: [] });
    expect(third).toMatchObject({ locale: "en", token: "t1", confirmed: true, created: false });
    expect((await rows())[0]).toMatchObject({ locale: "en", monitorIds: [mid] });
  });
});

describe.skipIf(!url)("maintenance windows and pages without a project", () => {
  const orgId = `test-org-${crypto.randomUUID()}`;
  const hour = 3600_000;
  beforeAll(async () => {
    await db.insert(schema.organization).values({ id: orgId, name: "Test", slug: orgId, createdAt: new Date() });
  });
  afterAll(async () => {
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
  });

  it("shows a page without a project the maintenance of the oldest project", async () => {
    const [oldest] = await db.insert(schema.project).values({ organizationId: orgId, name: "Old", createdAt: new Date(Date.now() - 5000) }).returning();
    const [newer] = await db.insert(schema.project).values({ organizationId: orgId, name: "New" }).returning();
    const created = await repo.createStatusPage(orgId, oldest.id, { slug: `m${crypto.randomUUID().slice(0, 8)}`, title: "M" });
    await db.update(schema.statusPage).set({ projectId: null, maintenanceReminderHours: 24 }).where(eq(schema.statusPage.id, created.id));
    const page = { ...created, projectId: null };
    const win = (projectId: string, name: string) =>
      db.insert(schema.maintenanceWindow).values({ organizationId: orgId, projectId, name, startsAt: new Date(Date.now() + 2 * hour), endsAt: new Date(Date.now() + 3 * hour), monitorIds: [] });
    await win(oldest.id, "oldest");
    await win(newer.id, "newer");
    expect((await repo.pageMaintenance(page, { limit: 10 })).map((w) => w.name)).toEqual(["oldest"]);
    // the reminders agree
    await db.insert(schema.statusSubscriber).values({ statusPageId: created.id, email: "m@x.test", token: crypto.randomUUID(), confirmedAt: new Date() });
    const names = (await repo.claimMaintenanceReminders(100)).filter((x) => x.page.id === created.id).map((x) => x.window.name);
    expect(names).toEqual(["oldest"]);
  });

  it("does not let windows nobody follows use up the claim limit", async () => {
    const [pr] = await db.insert(schema.project).values({ organizationId: orgId, name: "Starve" }).returning();
    const mk = async (title: string) => {
      const [m] = await db.insert(schema.monitor).values({ organizationId: orgId, projectId: pr.id, name: title, type: "tcp", target: "127.0.0.1:1", intervalSec: 60 }).returning();
      const p = await repo.createStatusPage(orgId, pr.id, { slug: `x${crypto.randomUUID().slice(0, 8)}`, title });
      await repo.updateStatusPage(p.id, { maintenanceReminderHours: 24 });
      await db.insert(schema.statusPageComponent).values({ statusPageId: p.id, monitorId: m.id });
      return { p, m };
    };
    const quiet = await mk("quiet");
    const busy = await mk("busy");
    // the quiet page's only subscriber follows a component the windows do not touch
    const [elsewhere] = await db.insert(schema.monitor).values({ organizationId: orgId, projectId: pr.id, name: "else", type: "tcp", target: "127.0.0.1:1", intervalSec: 60 }).returning();
    await db.insert(schema.statusPageComponent).values({ statusPageId: quiet.p.id, monitorId: elsewhere.id });
    await db.insert(schema.statusSubscriber).values({ statusPageId: quiet.p.id, email: "q@x.test", token: crypto.randomUUID(), confirmedAt: new Date(), monitorIds: [elsewhere.id] });
    await db.insert(schema.statusSubscriber).values({ statusPageId: busy.p.id, email: "b@x.test", token: crypto.randomUUID(), confirmedAt: new Date() });
    const at = (n: number) => ({ startsAt: new Date(Date.now() + n * 60_000), endsAt: new Date(Date.now() + n * 60_000 + hour) });
    // the quiet page's window is earlier than the busy one
    await db.insert(schema.maintenanceWindow).values({ organizationId: orgId, projectId: pr.id, name: "for-quiet", monitorIds: [quiet.m.id], ...at(60) });
    await db.insert(schema.maintenanceWindow).values({ organizationId: orgId, projectId: pr.id, name: "for-busy", monitorIds: [busy.m.id], ...at(120) });
    const got = (await repo.claimMaintenanceReminders(100)).filter((x) => x.page.id === quiet.p.id || x.page.id === busy.p.id);
    expect(got.map((x) => x.window.name)).toEqual(["for-busy"]);
    expect(await db.select().from(schema.maintenanceReminder).where(eq(schema.maintenanceReminder.statusPageId, quiet.p.id))).toHaveLength(0);
  });
});
