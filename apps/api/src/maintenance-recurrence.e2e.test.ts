import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { maintenanceCreateSchema } from "./routes/maintenance";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "maintenance-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };

it("validates bounded recurrence and IANA zones while preserving one-off compatibility", () => {
  const base = { name: "DB", startsAt: "2027-01-01T10:00:00Z", endsAt: "2027-01-01T11:00:00Z" };
  expect(maintenanceCreateSchema.safeParse(base).success).toBe(true);
  const recurrence = { frequency: "daily", timeZone: "America/Toronto", until: "2027-01-03T10:00:00Z" };
  expect(maintenanceCreateSchema.safeParse({ ...base, recurrence }).success).toBe(true);
  for (const invalid of [{ timeZone: "Invalid/Zone" }, { timeZone: "+05:00" }, { frequency: "hourly" }, { until: "2026-01-01T00:00:00Z" }, { until: "2029-01-01T00:00:00Z" }]) {
    expect(maintenanceCreateSchema.safeParse({ ...base, recurrence: { ...recurrence, ...invalid } }).success).toBe(false);
  }
  expect(maintenanceCreateSchema.safeParse({ ...base, endsAt: "2027-01-03T11:00:00Z", recurrence }).success).toBe(false);
});

describe.skipIf(!url)("recurring maintenance API", () => {
  it("creates visible occurrences, skips once, ends current, and cancels a scoped series", async () => {
    const db = openDatabase(url!, { max: 1 });
    await db.migrate();
    const app = createApp(openDatabase);
    let cookie = "";
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app.fetch(new Request(`${origin}/api${path}`, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never);
      const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      if (cookies) cookie = cookies;
      return { status: r.status, body: await r.json().catch(() => null) as any };
    };
    try {
      await call("POST", "/auth/sign-up/email", { email: `maintenance-${crypto.randomUUID()}@example.com`, name: "Maintenance", password: "correct horse battery" });
      const mon = (await call("POST", "/monitors", { name: "DNS", type: "dns", target: "example.com" })).body;
      const slug = `m${crypto.randomUUID().slice(0, 20)}`;
      expect((await call("POST", "/status-pages", { slug, title: "Status", monitorIds: [mon.id] })).status).toBe(201);
      const start = Date.now() - 30 * 60000;
      const body = { name: "Daily DB", startsAt: new Date(start).toISOString(), endsAt: new Date(start + 3600_000).toISOString(), monitorIds: [mon.id], recurrence: { frequency: "daily", timeZone: "UTC", until: new Date(start + 60 * 86400_000).toISOString() } };
      const made = await call("POST", "/maintenance", body);
      expect(made.status).toBe(201);
      expect(made.body.seriesId).toEqual(expect.any(String));
      expect(made.body.recurrence).toEqual(body.recurrence);
      const list = (await call("GET", "/maintenance")).body;
      expect(list).toHaveLength(61);
      expect(list[0].id).toBe(made.body.id);
      const visible = await call("GET", `/public/status/${slug}/maintenance`);
      expect(visible.body.items).toHaveLength(50);
      expect(visible.body.items[0].id).toBe(made.body.id);
      expect((await call("DELETE", `/maintenance/${list[1].id}`)).status).toBe(204);
      expect((await call("GET", "/maintenance")).body).toHaveLength(60);
      expect((await call("POST", `/maintenance/${made.body.id}/end`)).status).toBe(200);
      const ended = (await call("GET", "/maintenance")).body.find((w: any) => w.id === made.body.id);
      expect(+new Date(ended.endsAt)).toBeLessThanOrEqual(Date.now());
      expect((await call("DELETE", `/maintenance/series/${made.body.seriesId}`)).status).toBe(204);
      expect((await call("DELETE", `/maintenance/series/${made.body.seriesId}`)).status).toBe(204);
      expect((await call("GET", "/maintenance")).body).toHaveLength(1);
      expect((await call("POST", "/maintenance", { ...body, monitorIds: [crypto.randomUUID()] })).status).toBe(400);
      expect((await call("POST", "/maintenance", { ...body, recurrence: null, name: "Once" })).body.seriesId).toBeNull();
    } finally { await db.close(1); }
  });
});
