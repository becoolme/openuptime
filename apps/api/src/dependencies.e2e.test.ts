import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };

describe.skipIf(!url)("monitor dependencies", () => {
  const app = createApp(openDatabase);
  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);

  async function signedIn() {
    await raw("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const su = await raw("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `deps-${crypto.randomUUID()}@example.com`, password: "correct horse battery", name: "Ada" }),
    });
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return async (method: string, path: string, body?: unknown) => {
      const r = await raw(`/api${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };
  }
  const tcp = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: "tcp", target: "example.com:443", ...extra });

  it("defaults to no dependency and a majority of regions", async () => {
    const call = await signedIn();
    const m = await call("POST", "/monitors", tcp("Plain"));
    expect(m.status).toBe(201);
    expect(m.body).toMatchObject({ dependsOnMonitorId: null, minRegionsFailing: 0 });
  });

  it("accepts a parent of the same project and refuses itself, cycles and strangers", async () => {
    const call = await signedIn();
    const a = (await call("POST", "/monitors", tcp("A"))).body;
    const b = await call("POST", "/monitors", tcp("B", { dependsOnMonitorId: a.id, minRegionsFailing: 2 }));
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ dependsOnMonitorId: a.id, minRegionsFailing: 2 });
    const c = (await call("POST", "/monitors", tcp("C", { dependsOnMonitorId: b.body.id }))).body;

    expect((await call("PATCH", `/monitors/${a.id}`, { dependsOnMonitorId: a.id })).body).toMatchObject({ code: "dependency_self" });
    expect((await call("PATCH", `/monitors/${a.id}`, { dependsOnMonitorId: b.body.id })).body).toMatchObject({ code: "dependency_cycle" });
    expect((await call("PATCH", `/monitors/${a.id}`, { dependsOnMonitorId: c.id })).status).toBe(400);
    expect((await call("POST", "/monitors", tcp("D", { dependsOnMonitorId: crypto.randomUUID() }))).body).toMatchObject({ code: "dependency_not_found" });

    // another workspace's monitor is not a parent either
    const other = await signedIn();
    const foreign = (await other("POST", "/monitors", tcp("Foreign"))).body;
    expect((await call("PATCH", `/monitors/${a.id}`, { dependsOnMonitorId: foreign.id })).body).toMatchObject({ code: "dependency_not_found" });

    // clearing works
    const cleared = await call("PATCH", `/monitors/${b.body.id}`, { dependsOnMonitorId: null });
    expect(cleared.body.dependsOnMonitorId).toBeNull();
  });
});
