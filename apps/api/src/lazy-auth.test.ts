import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "@openuptime/db-pg";

const built = vi.hoisted(() => ({ count: 0 }));
vi.mock("./auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("./auth")>();
  return { ...original, createAuth: (...args: Parameters<typeof original.createAuth>) => (built.count++, original.createAuth(...args)) };
});
const { createApp } = await import("./app");

// The database is never reached: the client connects on its first query, and these routes make none.
const env = { DATABASE_URL: "postgres://u:p@127.0.0.1:1/none", BETTER_AUTH_SECRET: "x".repeat(64), BETTER_AUTH_URL: "https://uptime.example", WEB_ORIGIN: "https://uptime.example" };
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

describe("per-request auth", () => {
  it("is not built for requests that do not use it", async () => {
    built.count = 0;
    const app = createApp(openDatabase);
    expect((await app.fetch(new Request("https://uptime.example/api/health"), env, ctx)).status).toBe(200);
    expect((await app.fetch(new Request("https://uptime.example/api/auth-providers"), env, ctx)).status).toBe(200);
    expect(built.count).toBe(0);
  });

  it("is built once for a request that does", async () => {
    built.count = 0;
    const app = createApp(openDatabase);
    const res = await app.fetch(new Request("https://uptime.example/api/auth/ok"), env, ctx);
    expect(res.status).toBe(200);
    expect(built.count).toBe(1);
  });
});
