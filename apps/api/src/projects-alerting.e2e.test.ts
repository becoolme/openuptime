import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };

describe.skipIf(!url)("project alerting: escalation channels", () => {
  const app = createApp(openDatabase);
  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);

  it("accepts workspace-wide and own channels, refuses another project's", async () => {
    await raw("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const su = await raw("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `palert-${Date.now()}@example.com`, password: "correct horse battery", name: "Ada" }),
    });
    expect(su.status).toBe(200);
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const call = async (method: string, path: string, body?: unknown, project?: string) => {
      const r = await raw(`/api${path}`, { method, headers: { cookie, "content-type": "application/json", ...(project ? { "x-project-id": project } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };
    const first = (await call("GET", "/projects")).body[0].id as string;
    const second = (await call("POST", "/projects", { name: "Second" })).body.id as string;
    const wide = (await call("POST", "/channels", { type: "email", name: "Wide", config: { to: "a@example.com" } })).body;
    const mine = (await call("POST", "/channels", { type: "email", name: "Mine", config: { to: "b@example.com" }, scope: "project" }, first)).body;
    const theirs = (await call("POST", "/channels", { type: "email", name: "Theirs", config: { to: "c@example.com" }, scope: "project" }, second)).body;
    const put = (project: string, channelId: string) =>
      call("PUT", `/projects/${project}/alerting`, { reminderIntervalMin: null, reminderEmail: false, escalation: [{ channelIds: [channelId], escalateAfterMin: 10 }] });

    expect((await put(first, wide.id)).status).toBe(200);
    expect((await put(first, mine.id)).status).toBe(200);
    const bad = await put(first, theirs.id);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/another project/);
  });
});
