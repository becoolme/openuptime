import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };

describe.skipIf(!url)("request hardening", () => {
  const app = createApp(openDatabase);
  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);

  it("404s malformed ids and keeps a paused heartbeat monitor paused", async () => {
    await raw("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const su = await raw("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `hard-${Date.now()}@example.com`, password: "correct horse battery", name: "Ada" }),
    });
    expect(su.status).toBe(200);
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await raw(`/api${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };

    for (const path of ["/monitors/nope", "/channels/nope", "/status-pages/nope", "/incidents/nope", "/maintenance/nope"]) {
      expect([path, (await call("GET", path)).status]).toEqual([path, 404]);
    }
    expect((await call("PATCH", "/monitors/nope", { name: "x" })).status).toBe(404);
    expect((await call("DELETE", "/channels/nope")).status).toBe(404);

    const hb = (await call("POST", "/monitors", { name: "Cron", type: "heartbeat", intervalSec: 3600 })).body;
    expect(hb.heartbeatToken).toBeTruthy();
    expect((await call("PATCH", `/monitors/${hb.id}`, { paused: true })).body.status).toBe("paused");
    const ping = await raw(`/api/heartbeat/${hb.heartbeatToken}`);
    expect(ping.status).toBe(200);
    expect((await call("GET", `/monitors/${hb.id}`)).body.status).toBe("paused");
  });

  it("shows an owner the channel credentials, accepts them back unchanged, and rate limits sign-in per address", async () => {
    const email = `hard2-${Date.now()}@example.com`;
    const su = await raw("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct horse battery", name: "Ada" }),
    });
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await raw(`/api${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };
    const hook = "https://hooks.slack.com/services/T000/B000/abcdef";
    const created = (await call("POST", "/channels", { type: "slack", name: "Ops", config: { url: hook } })).body;
    expect(created.config.url).toBe(hook); // owners see it
    const renamed = await call("PATCH", `/channels/${created.id}`, { name: "Ops 2", config: { url: hook } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Ops 2");

    // the limit counts attempts per address, whether or not the password is right
    const attempt = () =>
      raw("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `Nobody-${email}`, password: "wrong password" }) });
    const statuses: number[] = [];
    for (let i = 0; i < 17; i++) statuses.push((await attempt()).status);
    expect(statuses.slice(0, 15).every((s) => s !== 429)).toBe(true);
    expect(statuses[16]).toBe(429);
  });
});
