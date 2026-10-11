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
    await db.$client.end();
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
});
