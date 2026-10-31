import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "blockchain-monitor-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };

describe.skipIf(!url)("blockchain monitors", () => {
  it("creates, persists and validates both RPC types", async () => {
    const db = openDatabase(url!, { max: 1 });
    await db.migrate();
    const app = createApp(openDatabase);
    let cookie = "";
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app.fetch(new Request(`${origin}/api${path}`, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never);
      const cookies = r.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
      if (cookies) cookie = cookies;
      return { status: r.status, body: await r.json() as any };
    };
    try {
      expect((await call("POST", "/auth/sign-up/email", { email: `rpc-${crypto.randomUUID()}@example.com`, name: "RPC", password: "correct horse battery" })).status).toBe(200);
      for (const type of ["evm", "solana"]) {
        expect((await call("POST", "/monitors", { name: type, type, target: "https://user:pass@1.1.1.1/" })).status).toBe(400);
        const created = await call("POST", "/monitors", { name: type, type, target: "https://1.1.1.1/rpc", headers: { Authorization: "Bearer example" } });
        expect(created.status).toBe(201);
        const path = `/monitors/${created.body.id}`;
        expect((await call("GET", path)).body).toMatchObject({ type, target: "https://1.1.1.1/rpc" });
        expect((await call("PATCH", path, { target: "ftp://1.1.1.1" })).status).toBe(400);
      }
    } finally { await db.close(1); }
  });
});
