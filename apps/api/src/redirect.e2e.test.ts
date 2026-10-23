import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };

describe.skipIf(!url)("redirect destination", () => {
  const app = createApp(openDatabase);
  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);

  async function signedIn() {
    await raw("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const su = await raw("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `redir-${crypto.randomUUID()}@example.com`, password: "correct horse battery", name: "Ada" }),
    });
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return async (method: string, path: string, body?: unknown) => {
      const r = await raw(`/api${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };
  }
  const http = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: "http", target: "https://example.com/", ...extra });

  it("stores the destination of a redirect monitor and reads it back", async () => {
    const call = await signedIn();
    const plain = await call("POST", "/monitors", http("Plain"));
    expect(plain.body).toMatchObject({ expectedLocation: null });

    const m = await call("POST", "/monitors", http("Apex", { expectedStatus: 301, expectedLocation: "https://www.example.com/" }));
    expect(m.status).toBe(201);
    expect(m.body).toMatchObject({ expectedStatus: 301, expectedLocation: "https://www.example.com/" });

    expect((await call("PATCH", `/monitors/${m.body.id}`, { expectedLocation: "/landing" })).body).toMatchObject({ expectedLocation: "/landing" });
    // blank means any destination again
    expect((await call("PATCH", `/monitors/${m.body.id}`, { expectedLocation: "  " })).body).toMatchObject({ expectedLocation: null });
    expect((await call("GET", `/monitors/${m.body.id}`)).body).toMatchObject({ expectedStatus: 301, expectedLocation: null });
  });

  it("refuses a destination that is neither a URL nor a path", async () => {
    const call = await signedIn();
    for (const bad of ["www.example.com", "javascript:alert(1)", "ftp://example.com/", "x".repeat(2049)]) {
      expect((await call("POST", "/monitors", http("Bad", { expectedStatus: 301, expectedLocation: bad }))).status, bad.slice(0, 30)).toBe(400);
    }
  });
});
