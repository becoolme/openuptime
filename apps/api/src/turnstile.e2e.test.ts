import { openDatabase } from "@openuptime/db-pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { turnstile } from "./auth";

const ORIGIN = "http://localhost:8787";

describe("turnstile()", () => {
  it("is on only when both keys are set", () => {
    expect(turnstile({})).toBeNull();
    expect(turnstile({ TURNSTILE_SITE_KEY: "site" })).toBeNull();
    expect(turnstile({ TURNSTILE_SECRET_KEY: "secret" })).toBeNull();
    expect(turnstile({ TURNSTILE_SITE_KEY: " ", TURNSTILE_SECRET_KEY: "secret" })).toBeNull();
    expect(turnstile({ TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" })).toEqual({ siteKey: "site", secretKey: "secret" });
  });
});

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const base = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };
const guarded = { ...base, TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" };

describe.skipIf(!url)("turnstile on sign-up", () => {
  const app = createApp(openDatabase);
  const raw = (env: object, path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);
  const signUp = (env: object, headers: Record<string, string> = {}) =>
    raw(env, "/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ email: `ts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: "correct horse battery", name: "Ada" }),
    });
  /** Stands in for Cloudflare's siteverify endpoint; every other request goes through. */
  const siteverify = (success: boolean) => {
    const real = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u.startsWith("https://challenges.cloudflare.com/")) return Response.json(success ? { success: true } : { success: false, "error-codes": ["invalid-input-response"] });
      return real(input, init);
    });
    return spy;
  };
  afterEach(() => vi.restoreAllMocks());

  it("is advertised only when both keys are configured", async () => {
    await raw(base, "/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const key = async (env: object) => ((await (await raw(env, "/api/auth-providers")).json()) as { turnstileSiteKey: string | null }).turnstileSiteKey;
    expect(await key(base)).toBeNull();
    expect(await key({ ...base, TURNSTILE_SITE_KEY: "site" })).toBeNull();
    expect(await key(guarded)).toBe("1x00000000000000000000AA");
  });

  it("leaves sign-up alone when not configured", async () => {
    expect((await signUp(base)).status).toBe(200);
    // a secret without a site key means no widget, so it must not block the form either
    expect((await signUp({ ...base, TURNSTILE_SECRET_KEY: "secret" })).status).toBe(200);
  });

  it("refuses sign-up without a token or with a rejected one, and accepts a verified one", async () => {
    siteverify(false);
    const missing = await signUp(guarded);
    expect(missing.status).toBe(400);
    const bad = await signUp(guarded, { "x-captcha-response": "bogus" });
    expect(bad.status).toBe(403);
    vi.restoreAllMocks();
    siteverify(true);
    expect((await signUp(guarded, { "x-captcha-response": "good" })).status).toBe(200);
  });

  it("does not ask for a token on sign-in", async () => {
    const res = await raw(guarded, "/api/auth/sign-in/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "whatever-password" }),
    });
    expect(res.status).not.toBe(400); // wrong credentials (401), not a missing captcha
  });
});
