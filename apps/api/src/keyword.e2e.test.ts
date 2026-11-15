import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };

describe.skipIf(!url)("keyword patterns", () => {
  const app = createApp(openDatabase);
  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);

  async function signedIn() {
    await raw("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const su = await raw("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `kw-${crypto.randomUUID()}@example.com`, password: "correct horse battery", name: "Ada" }),
    });
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return async (method: string, path: string, body?: unknown) => {
      const r = await raw(`/api${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };
  }
  const http = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: "http", target: "https://example.com/", ...extra });

  it("saves a pattern and refuses one RE2 cannot run", async () => {
    const call = await signedIn();
    const m = await call("POST", "/monitors", http("Pattern", { keyword: "(?i)status:\\s*ok", keywordMode: "matches" }));
    expect(m.status).toBe(201);
    expect(m.body).toMatchObject({ keyword: "(?i)status:\\s*ok", keywordMode: "matches" });
    const bad = await call("POST", "/monitors", http("Lookahead", { keyword: "(?=ok)", keywordMode: "matches" }));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/lookarounds/);
    // plain text may hold anything
    expect((await call("POST", "/monitors", http("Bracket", { keyword: "[", keywordMode: "contains" }))).status).toBe(201);
  });

  it("checks the combination when only one of keyword and mode changes", async () => {
    const call = await signedIn();
    const m = await call("POST", "/monitors", http("Plain", { keyword: "(a)\\1" }));
    expect(m.status).toBe(201);
    expect((await call("PATCH", `/monitors/${m.body.id}`, { keywordMode: "matches" })).status).toBe(400);
    expect((await call("PATCH", `/monitors/${m.body.id}`, { keyword: "a+b", keywordMode: "not_matches" })).body).toMatchObject({ keyword: "a+b", keywordMode: "not_matches" });
    expect((await call("PATCH", `/monitors/${m.body.id}`, { keyword: "(?<=a)b" })).status).toBe(400);
    expect((await call("PATCH", `/monitors/${m.body.id}`, { keyword: null })).status).toBe(200);
  });
});
