import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const base = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };

describe.skipIf(!url)("closed registration", () => {
  const app = createApp(openDatabase);
  const raw = (env: object, path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);
  const signUp = (env: object, email: string) =>
    raw(env, "/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct horse battery", name: "Ada" }),
    });
  const closed = { ...base, DISABLE_SIGNUP: "true" };

  it("refuses new accounts, lets an invited address in, and tells the web app", async () => {
    await raw(base, "/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    expect(((await (await raw(base, "/api/auth-providers")).json()) as { signup: boolean }).signup).toBe(true);
    expect(((await (await raw(closed, "/api/auth-providers")).json()) as { signup: boolean }).signup).toBe(false);

    const owner = `owner-${Date.now()}@example.com`;
    const first = await signUp(base, owner);
    expect(first.status).toBe(200);
    expect((await signUp(closed, `nobody-${Date.now()}@example.com`)).status).toBe(403);

    // an invitation opens the door for that address only
    const cookie = first.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const invited = `Invited-${Date.now()}@example.com`;
    const org = (await (await raw(base, "/api/me", { headers: { cookie } })).json()) as { organization: { id: string } };
    const inv = await raw(base, "/api/auth/organization/invite-member", {
      method: "POST", headers: { cookie, "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email: invited.toLowerCase(), role: "member", organizationId: org.organization.id }),
    });
    expect(inv.status).toBe(200);
    expect((await signUp(closed, invited)).status).toBe(200);
  });
});
