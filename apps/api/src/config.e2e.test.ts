import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { community } from "./edition";

const ORIGIN = "http://localhost:8787";
const url = process.env.TEST_DATABASE_URL;
const base = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };

describe.skipIf(!url)("GET /api/config", () => {
  const get = (env: object, edition = community) => createApp(openDatabase, { edition }).fetch(new Request(`${ORIGIN}/api/config`), env as never);

  it("is public and reports what sign-in offers", async () => {
    const res = await get(base);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { apiVersion: number; edition: string; auth: Record<string, unknown> };
    expect(body.apiVersion).toBe(1);
    expect(body.edition).toBe("community");
    expect(body.auth).toMatchObject({ emailPassword: true, github: false, signup: true, turnstileSiteKey: null });
  });

  it("shows the Turnstile site key only when both keys are set", async () => {
    const on = { ...base, TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" };
    expect(((await (await get(on)).json()) as { auth: { turnstileSiteKey: string } }).auth.turnstileSiteKey).toBe("site");
  });

  it("reports the edition's name", async () => {
    expect(((await (await get(base, { ...community, id: "cloud" })).json()) as { edition: string }).edition).toBe("cloud");
  });
});
