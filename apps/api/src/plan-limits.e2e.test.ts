import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { Edition } from "./edition";
import { unmetered } from "./entitlements";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };

/** An edition with a small plan: two active monitors, checks no more often than every 5 minutes. */
const small: Edition = {
  entitlements: () => ({
    ...unmetered,
    plan: async () => ({ id: "small", name: "Small", maxActiveMonitors: 2, minIntervalSec: 300, upgradeUrl: "https://example.com/upgrade" }),
  }),
};

describe.skipIf(!url)("plan limits", () => {
  const app = createApp(openDatabase, { edition: small });
  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);

  it("refuses monitors and intervals beyond the plan, and lets paused monitors go free", async () => {
    await raw("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const su = await raw("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `plan-${Date.now()}@example.com`, password: "correct horse battery", name: "Ada" }),
    });
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await raw(`/api${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };
    const m = (name: string, intervalSec = 300) => ({ name, type: "http", target: "https://example.com", intervalSec });

    const fast = await call("POST", "/monitors", m("Fast", 60));
    expect(fast.status).toBe(402);
    expect(fast.body).toMatchObject({ code: "interval_not_allowed", minIntervalSec: 300, upgradeUrl: "https://example.com/upgrade" });

    const a = (await call("POST", "/monitors", m("A"))).body;
    expect((await call("POST", "/monitors", m("B"))).status).toBe(201);
    const full = await call("POST", "/monitors", m("C"));
    expect(full.status).toBe(402);
    expect(full.body).toMatchObject({ code: "monitor_limit", limit: 2, active: 2 });

    // the usage endpoint reports the plan and what is used
    const usage = (await call("GET", "/usage")).body;
    expect(usage).toMatchObject({ metered: true, activeMonitors: 2, plan: { id: "small", maxActiveMonitors: 2 } });

    // pausing frees a slot; resuming takes it back; a faster interval is refused
    expect((await call("PATCH", `/monitors/${a.id}`, { paused: true })).status).toBe(200);
    expect((await call("POST", "/monitors", m("C"))).status).toBe(201);
    expect((await call("PATCH", `/monitors/${a.id}`, { paused: false })).status).toBe(402);
    expect((await call("PATCH", `/monitors/${a.id}`, { intervalSec: 60 })).status).toBe(402);

    // an import is all-or-nothing against the cap, and intervals below the floor are raised to it
    expect((await call("POST", "/monitors/import", [m("I1"), m("I2")])).status).toBe(402);
  });
});
