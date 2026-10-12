import { openDatabase } from "@openuptime/db-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { Edition } from "./edition";
import { unmetered } from "./entitlements";
import { setMailTransport } from "./email";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = {
  DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron",
  EMAIL_FROM: "alerts@example.com",
};

/** A plan without the option to hide OpenUptime's branding. */
const restricted: Edition = {
  entitlements: () => ({
    ...unmetered,
    plan: async () => ({ id: "basic", name: "Basic", maxActiveMonitors: 50, minIntervalSec: 60, hideBranding: false, upgradeUrl: "https://example.com/upgrade" }),
  }),
};

describe.skipIf(!url)("status page branding", () => {
  const community = createApp(openDatabase);
  const limited = createApp(openDatabase, { edition: restricted });
  const sent: { fromName: string; to: string; html: string; text: string }[] = [];

  beforeAll(() => setMailTransport(async (m) => void sent.push(m)));
  afterAll(() => setMailTransport(undefined));

  type App = ReturnType<typeof createApp>;
  const raw = (app: App, path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);

  async function signedIn() {
    await raw(community, "/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const su = await raw(community, "/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `branding-${Date.now()}@example.com`, password: "correct horse battery", name: "Ada" }),
    });
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    // the same session against either edition: one deployment, two sets of plan rules
    return (app: App) => async (method: string, path: string, body?: unknown) => {
      const r = await raw(app, `/api${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };
  }
  const slug = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const publicPage = async (app: App, s: string) => (await (await raw(app, `/api/public/status/${s}`)).json()) as any;

  it("lets the community edition hide the branding without a plan", async () => {
    const on = await signedIn();
    const call = on(community);
    const s = slug();
    const made = await call("POST", "/status-pages", { slug: s, title: "Acme", externalUrl: "https://acme.example", hideBranding: true });
    expect(made.status).toBe(201);
    const got = await call("GET", `/status-pages/${made.body.id}`);
    expect(got.body).toMatchObject({ hideBranding: true, branding: { allowed: true } });
    expect((await publicPage(community, s)).page).toMatchObject({ hideBranding: true, externalUrl: "https://acme.example" });
  });

  it("refuses to turn the branding off on a plan that does not include it", async () => {
    const on = await signedIn();
    const call = on(limited);
    const s = slug();
    const denied = await call("POST", "/status-pages", { slug: s, title: "Acme", hideBranding: true });
    expect(denied.status).toBe(402);
    expect(denied.body).toMatchObject({ code: "branding_not_allowed", plan: "basic", upgradeUrl: "https://example.com/upgrade" });
    const made = await call("POST", "/status-pages", { slug: s, title: "Acme" });
    expect(made.status).toBe(201);
    const patched = await call("PATCH", `/status-pages/${made.body.id}`, { hideBranding: true });
    expect(patched.status).toBe(402);
    const got = await call("GET", `/status-pages/${made.body.id}`);
    expect(got.body).toMatchObject({ hideBranding: false, branding: { allowed: false, upgradeUrl: "https://example.com/upgrade" } });
    expect((await call("PATCH", `/status-pages/${made.body.id}`, { hideBranding: false })).status).toBe(200);
  });

  it("shows the branding again after a downgrade and keeps the setting", async () => {
    const on = await signedIn();
    const s = slug();
    const made = await on(community)("POST", "/status-pages", { slug: s, title: "Acme", hideBranding: true });
    expect((await publicPage(community, s)).page.hideBranding).toBe(true);
    // the same page under a plan that lacks the option
    expect((await publicPage(limited, s)).page.hideBranding).toBe(false);
    const limitedCall = on(limited);
    expect((await limitedCall("GET", `/status-pages/${made.body.id}`)).body).toMatchObject({ hideBranding: true, branding: { allowed: false } });
    // saving the page again with the stored value is not refused, and it stays stored
    const kept = await limitedCall("PATCH", `/status-pages/${made.body.id}`, { title: "Acme 2", hideBranding: true });
    expect(kept.status).toBe(200);
    expect((await on(community)("GET", `/status-pages/${made.body.id}`)).body.hideBranding).toBe(true);
  });

  it("sends the confirmation email under the page's own name only while the branding is hidden", async () => {
    const on = await signedIn();
    const s = slug();
    await on(community)("POST", "/status-pages", { slug: s, title: "Acme Status", hideBranding: true });
    const subscribe = (app: App, email: string) => raw(app, `/api/public/status/${s}/subscribe`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }),
    });
    sent.length = 0;
    expect((await subscribe(community, "white@example.com")).status).toBe(200);
    const white = sent.find((m) => m.to === "white@example.com")!;
    expect(white.fromName).toBe("Acme Status");
    expect(white.html).not.toContain("OpenUptime");
    expect(white.text).not.toContain("Powered by OpenUptime");
    expect((await subscribe(limited, "plain@example.com")).status).toBe(200);
    const plain = sent.find((m) => m.to === "plain@example.com")!;
    expect(plain.fromName).toBe("OpenUptime");
    expect(plain.html).toContain("OpenUptime");
    expect(plain.text).toContain("Powered by OpenUptime");
  });
});
