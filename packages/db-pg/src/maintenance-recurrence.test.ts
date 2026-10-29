import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, createRepo, eq, schema } from "./index";

const url = process.env.DATABASE_URL;
const db = url ? createDb(url, { max: 4 }) : undefined!;
const repo = url ? createRepo(db) : undefined!;
const orgId = `recurrence-${crypto.randomUUID()}`;
let projectId: string;
afterAll(async () => { if (url) { await db.delete(schema.organization).where(eq(schema.organization.id, orgId)); await db.$client.end(); } });

describe.skipIf(!url)("recurring maintenance", () => {
  beforeAll(async () => {
    await db.insert(schema.organization).values({ id: orgId, name: "Recurring", slug: orgId, createdAt: new Date() });
    projectId = (await db.insert(schema.project).values({ organizationId: orgId, name: "Project" }).returning())[0].id;
  });
  async function series(start: string, until: string, timeZone: string, frequency: "daily" | "weekly" = "daily") {
    const first = await repo.createMaintenance(orgId, projectId, { name: "Recurring", startsAt: new Date(start), endsAt: new Date(+new Date(start) + 3600_000), monitorIds: [], recurrence: { frequency, timeZone, until } });
    return (await db.select().from(schema.maintenanceWindow).where(eq(schema.maintenanceWindow.seriesId, first.seriesId!))).sort((a, b) => +a.startsAt - +b.startsAt);
  }
  it("keeps the local clock time across spring DST and keeps duration fixed", async () => {
    const windows = await series("2027-03-13T14:00:00Z", "2027-03-15T13:00:00Z", "America/Toronto");
    expect(windows.map((w) => w.startsAt.toISOString())).toEqual(["2027-03-13T14:00:00.000Z", "2027-03-14T13:00:00.000Z", "2027-03-15T13:00:00.000Z"]);
    expect(windows.every((w) => +w.endsAt - +w.startsAt === 3600_000)).toBe(true);
    expect(new Set(windows.map((w) => w.id)).size).toBe(3);
  });
  it("moves a nonexistent local time forward and chooses the later repeated time", async () => {
    const spring = await series("2027-03-13T07:30:00Z", "2027-03-15T07:30:00Z", "America/Toronto");
    expect(spring.map((w) => w.startsAt.toISOString())).toEqual(["2027-03-13T07:30:00.000Z", "2027-03-14T07:30:00.000Z", "2027-03-15T06:30:00.000Z"]);
    const fall = await series("2027-11-06T05:30:00Z", "2027-11-08T06:30:00Z", "America/Toronto");
    expect(fall.map((w) => w.startsAt.toISOString())).toEqual(["2027-11-06T05:30:00.000Z", "2027-11-07T06:30:00.000Z", "2027-11-08T06:30:00.000Z"]);
  });
  it("handles weekly DST, half-hour transitions, and whole-day offset jumps", async () => {
    const weekly = await series("2027-03-07T14:00:00Z", "2027-03-21T13:00:00Z", "America/Toronto", "weekly");
    expect(weekly.map((w) => w.startsAt.toISOString())).toEqual(["2027-03-07T14:00:00.000Z", "2027-03-14T13:00:00.000Z", "2027-03-21T13:00:00.000Z"]);
    const half = await series("2027-10-01T15:45:00Z", "2027-10-03T16:00:00Z", "Australia/Lord_Howe");
    expect(half.map((w) => w.startsAt.toISOString())).toEqual(["2027-10-01T15:45:00.000Z", "2027-10-02T15:45:00.000Z", "2027-10-03T15:15:00.000Z"]);
    const jump = await series("2011-12-29T20:00:00Z", "2011-12-31T20:00:00Z", "Pacific/Apia");
    expect(jump.map((w) => w.startsAt.toISOString())).toEqual(["2011-12-29T20:00:00.000Z", "2011-12-30T20:00:00.000Z", "2011-12-31T20:00:00.000Z"]);
  });
  it("skips one occurrence and cancels active/future windows while preserving history and scope", async () => {
    const start = new Date(Date.now() - 86400_000 - 1800_000);
    const windows = await series(start.toISOString(), new Date(+start + 3 * 86400_000).toISOString(), "UTC");
    await repo.deleteMaintenance(orgId, windows[2].id, [projectId]);
    expect((await repo.listMaintenance(orgId, projectId)).some((w) => w.id === windows[2].id)).toBe(false);
    await repo.cancelMaintenanceSeries("other-workspace", windows[0].seriesId!, null);
    await repo.cancelMaintenanceSeries(orgId, windows[0].seriesId!, [crypto.randomUUID()]);
    expect((await db.select().from(schema.maintenanceWindow).where(eq(schema.maintenanceWindow.seriesId, windows[0].seriesId!)))).toHaveLength(3);
    await repo.cancelMaintenanceSeries(orgId, windows[0].seriesId!, [projectId]);
    await repo.cancelMaintenanceSeries(orgId, windows[0].seriesId!, [projectId]);
    const left = await db.select().from(schema.maintenanceWindow).where(eq(schema.maintenanceWindow.seriesId, windows[0].seriesId!));
    expect(left).toHaveLength(2);
    expect(left.every((w) => +w.endsAt <= Date.now())).toBe(true);
    expect(left.find((w) => w.id === windows[0].id)!.endsAt).toEqual(windows[0].endsAt);
  });
  it("uses the database clock when the application clock is behind", async () => {
    const now = Date.now();
    for (const action of ["end", "cancel"] as const) {
      const start = new Date(now - 1800_000);
      const windows = await series(start.toISOString(), new Date(now + 86400_000).toISOString(), "UTC");
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now - 86400_000));
      try {
        if (action === "end") await repo.endMaintenance(orgId, windows[0].id, [projectId]);
        else await repo.cancelMaintenanceSeries(orgId, windows[0].seriesId!, [projectId]);
      } finally { vi.useRealTimers(); }
      const [ended] = await db.select().from(schema.maintenanceWindow).where(eq(schema.maintenanceWindow.id, windows[0].id));
      expect(+ended.endsAt).toBeGreaterThanOrEqual(+ended.startsAt);
      expect(+ended.endsAt).toBeGreaterThanOrEqual(now);
      expect(+ended.endsAt).toBeLessThanOrEqual(Date.now());
    }
  });
  it("claims each occurrence reminder once even with concurrent consumers", async () => {
    const now = Date.now();
    const windows = await series(new Date(now + 3600_000).toISOString(), new Date(now + 25 * 3600_000).toISOString(), "UTC");
    const page = await repo.createStatusPage(orgId, projectId, { slug: `r${crypto.randomUUID()}`, title: "Status" });
    await repo.updateStatusPage(page.id, { maintenanceReminderHours: 48 });
    await db.insert(schema.statusSubscriber).values({ statusPageId: page.id, email: "fixture@example.com", token: crypto.randomUUID(), confirmedAt: new Date() });
    const claims = (await Promise.all([repo.claimMaintenanceReminders(100), repo.claimMaintenanceReminders(100)])).flat().filter((c) => windows.some((w) => w.id === c.window.id));
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((c) => c.window.id)).size).toBe(2);
    expect((await repo.claimMaintenanceReminders(100)).filter((c) => windows.some((w) => w.id === c.window.id))).toHaveLength(0);
    await repo.cancelMaintenanceSeries(orgId, windows[0].seriesId!, null);
    expect((await repo.claimMaintenanceReminders(100)).filter((c) => windows.some((w) => w.id === c.window.id))).toHaveLength(0);
  });
});
