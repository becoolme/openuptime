import { openDatabase } from "@openuptime/db-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { setMailTransport } from "./email";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = {
  DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron",
  EMAIL_FROM: "alerts@example.com",
};

describe.skipIf(!url)("password reset mail", () => {
  const app = createApp(openDatabase);
  const sent: { to: string; subject: string; html: string; text: string }[] = [];

  beforeAll(() => setMailTransport(async (m) => void sent.push(m)));
  afterAll(() => setMailTransport(undefined));

  const post = (path: string, body: unknown) =>
    app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env as never);

  it("tells the owner after the password was changed", async () => {
    await app.fetch(new Request(`${ORIGIN}/internal/migrate`, { method: "POST", headers: { "x-cron-secret": "cron" } }), env as never);
    const email = `reset-${Date.now()}@example.com`;
    const su = await post("/api/auth/sign-up/email", { email, password: "correct horse battery", name: "Ada" });
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const session = () => app.fetch(new Request(`${ORIGIN}/api/auth/get-session?disableCookieCache=true`, { headers: { cookie } }), env as never).then((r) => r.json());
    expect(await session()).toBeTruthy();
    sent.length = 0;

    await post("/api/auth/request-password-reset", { email, redirectTo: `${ORIGIN}/reset-password` });
    const link = sent.find((m) => m.to === email && /reset/i.test(m.subject));
    expect(link).toBeTruthy();
    expect(sent.some((m) => m.subject === "Your OpenUptime password was changed")).toBe(false);
    const token = /reset-password\/([^?"&\s]+)/.exec(link!.text)?.[1];
    expect(token).toBeTruthy();

    const res = await post("/api/auth/reset-password", { newPassword: "a brand new password", token });
    expect(res.status).toBe(200);
    const notice = sent.find((m) => m.to === email && m.subject === "Your OpenUptime password was changed");
    expect(notice).toBeTruthy();
    // a session opened before the reset is gone (the signed cookie cache can still answer for up to 5 minutes)
    expect(await session()).toBeNull();
    // the notice carries no secret: no token, no password
    expect(notice!.html + notice!.text).not.toContain(token!);
    expect(notice!.html + notice!.text).not.toContain("brand new");
  });
});
