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
    await db.$client.end();
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
});
