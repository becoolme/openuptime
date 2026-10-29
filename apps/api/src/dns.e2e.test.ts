import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "dns-monitor-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };

describe.skipIf(!url)("DNS monitor persistence and backups", () => {
  it("creates, updates, exports and imports record assertions without resetting omitted fields", async () => {
    const db = openDatabase(url!, { max: 1 });
    await db.migrate();
    const app = createApp(openDatabase);
    let cookie = "";
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app.fetch(new Request(`${origin}/api${path}`, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never);
      const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      if (cookies) cookie = cookies;
      return { status: r.status, body: await r.json().catch(() => null) as any };
    };
    try {
      expect((await call("POST", "/auth/sign-up/email", { email: `dns-${crypto.randomUUID()}@example.com`, name: "DNS", password: "correct horse battery" })).status).toBe(200);
      const settings = { dnsRecordType: "MX", dnsExpectedValue: "10 mail.example.com.", dnsMatchMode: "exact" };
      const created = await call("POST", "/monitors", { name: "Mail", type: "dns", target: "example.com", ...settings });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject(settings);
      const path = `/monitors/${created.body.id}`;
      expect((await call("PATCH", path, { name: "Mail renamed" })).body).toMatchObject(settings);
      expect((await call("GET", path)).body).toMatchObject(settings);
      const exported = await call("GET", "/monitors/export");
      expect(exported.body.monitors[0]).toMatchObject(settings);
      expect((await call("POST", "/monitors/import", exported.body)).body).toMatchObject({ created: 1, skipped: [] });
      const list = await call("GET", "/monitors");
      expect(list.body).toHaveLength(2);
      for (const row of list.body) expect(row).toMatchObject(settings);
      expect((await call("PATCH", path, { dnsExpectedValue: "", dnsRecordType: "TXT", dnsMatchMode: "contains" })).body).toMatchObject({ dnsExpectedValue: null, dnsRecordType: "TXT", dnsMatchMode: "contains" });
      const bare = await call("POST", "/monitors", { name: "Default", type: "dns", target: "example.org" });
      expect(bare.body).toMatchObject({ dnsRecordType: "A", dnsExpectedValue: null, dnsMatchMode: "exact" });
      const defaults = { dnsRecordType: "A", dnsExpectedValue: null, dnsMatchMode: "exact" };
      const http = await call("POST", "/monitors", { name: "HTTP", type: "http", target: "https://1.1.1.1/", ...settings });
      expect(http.body).toMatchObject(defaults);
      expect((await call("PATCH", `/monitors/${http.body.id}`, settings)).body).toMatchObject(defaults);
      expect((await call("POST", "/monitors/import", [{ name: "Imported HTTP", type: "http", target: "https://1.1.1.1/", ...settings }])).status).toBe(201);
      expect((await call("GET", "/monitors")).body.find((m: any) => m.name === "Imported HTTP")).toMatchObject(defaults);
      expect((await call("PATCH", path, { dnsRecordType: "ANY" })).status).toBe(400);
      expect((await call("POST", "/monitors/import", [{ name: "Invalid", type: "dns", target: "example.com", dnsMatchMode: "regex" }])).status).toBe(400);
    } finally { await db.close(1); }
  });
});
