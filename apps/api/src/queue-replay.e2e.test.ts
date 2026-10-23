import { createServer } from "node:http";
import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { unmetered } from "./entitlements";
import { processCheckMessage } from "./scheduler";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("queue replay", () => {
  it("checks and bills A, B, A only twice, including a shorter second interval", async () => {
    let requests = 0;
    const server = createServer((_req, res) => { requests++; res.end("ok"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const db = openDatabase(url!, { max: 1 });
    const origin = "http://localhost:8787";
    const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "queue-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin, ALLOW_PRIVATE_TARGETS: "true" };
    await db.migrate();
    const app = createApp(openDatabase);
    try {
      const signed = await app.fetch(new Request(`${origin}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `queue-${crypto.randomUUID()}@example.com`, name: "Queue", password: "correct horse battery" }) }), env as never);
      expect(signed.status).toBe(200);
      const cookie = signed.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      const created = await app.fetch(new Request(`${origin}/api/monitors`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Queue", type: "http", target: `http://127.0.0.1:${(server.address() as { port: number }).port}`, intervalSec: 3600 }) }), env as never);
      expect(created.status).toBe(201);
      const m = await created.json() as { id: string };
      let credits = 0;
      const entitlements = { ...unmetered, spendCredits: async (_org: string, n: number) => { credits += n; return n; } };
      const a = { ids: [m.id], at: [new Date(Date.now() + 3600_000).toISOString()], generations: [1] };
      const b = { ids: [m.id], at: [new Date(Date.now() + 60_000).toISOString()], generations: [2] };
      await db.query(`update monitor set run_generation = 1 where id = $1`, [m.id]);
      await processCheckMessage(db.repo, a, entitlements);
      await processCheckMessage(db.repo, a, entitlements);
      await db.query(`update monitor set run_generation = 2, interval_sec = 60 where id = $1`, [m.id]);
      await processCheckMessage(db.repo, b, entitlements);
      await processCheckMessage(db.repo, a, entitlements);
      expect(requests).toBe(2);
      expect(credits).toBe(2);
      expect(await db.query(`select count(*)::int as n from check_result where monitor_id = $1`, [m.id])).toEqual([{ n: 2 }]);
    } finally {
      await db.close(1);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
