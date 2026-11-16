import { openDatabase } from "@openuptime/db-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { unmetered } from "./entitlements";
import { MASK } from "./secrets";
import { setPingRunner } from "./ping";
import robotFile from "./import-fixtures/uptimerobot-getmonitors.json";
import kumaFile from "./import-fixtures/uptime-kuma-backup.json";

// the samples name example.com hosts; point them at an address that needs no DNS lookup
const offline = <T>(file: T): T => JSON.parse(JSON.stringify(file).replace(/(https?:\/\/)[a-z.]*example\.com/g, "$11.1.1.1").replace(/"(mail|db)\.example\.com"/g, '"1.1.1.1"').replace(/"203\.0\.113\.\d+"/g, '"1.1.1.1"'));
/** Stands in for the system ping: `false` is a machine that may not send ICMP, `true` one whose pings are answered. */
const pings = (can: boolean) => setPingRunner(async () => can
  ? { code: 0, stdout: "PING 1.1.1.1 (1.1.1.1): 56 data bytes\n64 bytes from 1.1.1.1: seq=0 ttl=57 time=4.2 ms\n\n1 packets transmitted, 1 packets received, 0% packet loss\n", stderr: "", killed: false, missing: false }
  : { code: 2, stdout: "", stderr: "ping: socket: Operation not permitted\n", killed: false, missing: false });

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "import-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };

describe.skipIf(!url)("monitor import preview and identity", () => {
  const db = url ? openDatabase(url, { max: 3 }) : null;
  const app = createApp(openDatabase);
  const limited = createApp(openDatabase, { edition: { entitlements: () => ({ ...unmetered, plan: async () => ({ id: "one", name: "One", maxActiveMonitors: 1, minIntervalSec: 300, maxRegions: 1, upgradeUrl: "/upgrade" }) }) } });
  beforeAll(async () => { await db!.migrate(); });
  afterAll(async () => { setPingRunner(null); await db?.close(1); });
  async function account(use = app) {
    const signup = await use.fetch(new Request(origin + "/api/auth/sign-up/email", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: `import-${crypto.randomUUID()}@example.com`, password: "correct horse battery", name: "Import" }) }), env as never);
    expect(signup.status).toBe(200);
    const cookie = signup.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await use.fetch(new Request(origin + "/api" + path, { method, headers: { origin, "content-type": "application/json", ...headers, cookie: headers.cookie ? `${cookie}; ${headers.cookie}` : cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never);
      return { status: res.status, body: await res.json().catch(() => null) as any };
    };
  }
  const row = (sourceId: string, extra: Record<string, unknown> = {}) => ({ sourceId, name: "Imported API", type: "http", target: "https://1.1.1.1/health", ...extra });

  it("previews without writes, keeps credentials private, and deduplicates concurrent retries", async () => {
    const call = await account();
    const input = { source: "backup:prod", monitors: [row("42", { headers: { Authorization: "Bearer fixture-secret" }, custom: "ignored", channelIds: [crypto.randomUUID()] }), row("42")] };
    const preview = await call("POST", "/monitors/import/preview", input);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ preview: true, ready: 1, duplicates: 1, created: 0, canImport: true });
    expect(preview.body.report[0].warnings).toContain("Unsupported fields: custom");
    expect(JSON.stringify(preview.body)).not.toContain("fixture-secret");
    expect((await call("GET", "/monitors")).body).toEqual([]);
    const results = await Promise.all(Array.from({ length: 5 }, () => call("POST", "/monitors/import", { ...input, destination: preview.body.destination })));
    expect(results.reduce((n, r) => n + r.body.created, 0)).toBe(1);
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    const monitors = (await call("GET", "/monitors")).body;
    expect(monitors).toHaveLength(1);
    expect(monitors[0]).toMatchObject({ importSource: "backup:prod", importSourceId: "42", headers: { Authorization: "Bearer fixture-secret" } });
    const changed = await call("POST", "/monitors/import", { source: "backup:prod", monitors: [row("42", { name: "Changed" })] });
    expect(changed.body).toMatchObject({ created: 0, duplicates: 1 });
    expect((await call("GET", "/monitors")).body[0].name).toBe("Imported API");
    expect((await call("POST", "/monitors/import", { ...input, destination: { ...preview.body.destination, projectId: crypto.randomUUID() } })).status).toBe(409);
  });

  it("refuses credential-looking fields, keeps request bodies safe, and explains duplicates and capacity", async () => {
    const call = await account();
    const bad = await call("POST", "/monitors/import/preview", { monitors: [row("a", { basic_auth_user: "u" }), row("b", { oauth_client_secret: "s" }), row("c", { requestBody: MASK, method: "POST" }), row("d", { requestBody: "x", method: "GET" }), row("e", { basic_auth_user: "" })] });
    expect(bad.body.report.map((r: any) => r.status)).toEqual(["skipped", "skipped", "skipped", "skipped", "ready"]);
    expect(bad.body.report[2].error).toMatch(/masked request body/i);
    expect(bad.body.destination.projectName).toEqual(expect.any(String));
    expect((await call("POST", "/monitors/import", { source: "s", monitors: [row("1", { name: "First", target: "https://1.1.1.1/a" })] })).status).toBe(201);
    const dup = await call("POST", "/monitors/import/preview", { source: "s", monitors: [row("1", { name: "Other", target: "https://1.1.1.1/b" })] });
    expect(dup.body.report[0]).toMatchObject({ status: "duplicate", existing: { name: "First", target: "https://1.1.1.1/a" } });
    expect(dup.body.report[0].warnings.join(" ")).toMatch(/already belongs to "First"/);
    expect((await call("POST", "/monitors/import/preview", { source: "s", monitors: [row("1", { name: "First", target: "https://1.1.1.1/a" })] })).body.report[0].warnings).toEqual([]);
    expect((await call("POST", "/monitors/import", { monitors: [row("z")] }, { "x-project-id": crypto.randomUUID() })).status).toBe(403);
    expect((await call("POST", "/monitors/import", { monitors: [row("z")] }, { cookie: "ou_project=" + crypto.randomUUID() })).status).toBe(403);
  });

  it("reads Uptime Kuma status lists", async () => {
    const call = await account();
    const res = await call("POST", "/monitors/import", { source: "kuma", monitors: [row("k1", { accepted_statuscodes: ["200-299", "401"] }), row("k2", { accepted_statuscodes: ["200-299"] })] });
    expect(res.body).toMatchObject({ created: 2 });
    expect(res.body.report.flatMap((r: { warnings: string[] }) => r.warnings)).toEqual([]);
    const byId = Object.fromEntries((await call("GET", "/monitors")).body.map((m: { importSourceId: string; acceptedStatuses: string | null }) => [m.importSourceId, m.acceptedStatuses]));
    // the usual 2xx is the default and needs no list
    expect(byId).toEqual({ k1: "200-299,401", k2: null });
  });

  it("normalizes source identity whitespace and recognizes legacy padded IDs", async () => {
    const call = await account();
    const input = { source: "test", monitors: [row("  item-1  "), row("item-1")] };
    expect((await call("POST", "/monitors/import/preview", input)).body).toMatchObject({ ready: 1, duplicates: 1 });
    expect((await call("POST", "/monitors/import", input)).body).toMatchObject({ created: 1, duplicates: 1 });
    const [saved] = (await call("GET", "/monitors")).body;
    expect(saved.importSourceId).toBe("item-1");
    await db!.query("update monitor set import_source_id=$1 where id=$2", ["  item-1  ", saved.id]);
    expect((await call("POST", "/monitors/import", { source: "test", monitors: [row("item-1")] })).body).toMatchObject({ created: 0, duplicates: 1 });
    expect((await call("GET", "/monitors")).body).toHaveLength(1);
  });

  it("scopes identities to source, project and workspace without allowing foreign projects", async () => {
    const a = await account(); const b = await account();
    const input = { source: "account:a", monitors: [row("same")] };
    const first = await a("POST", "/monitors/import", input);
    expect(first.body.created).toBe(1);
    expect((await b("POST", "/monitors/import", input)).body.created).toBe(1);
    expect((await a("POST", "/monitors/import", { ...input, source: "account:b" })).body.created).toBe(1);
    const project = (await a("POST", "/projects", { name: "Second" })).body.id;
    expect((await a("POST", "/monitors/import", input, { "x-project-id": project })).body.created).toBe(1);
    expect((await b("POST", "/monitors/import/preview", input, { "x-project-id": project })).status).toBeGreaterThanOrEqual(400);
    expect((await b("POST", "/monitors/import", input, { "x-project-id": project })).status).toBeGreaterThanOrEqual(400);
  });

  it("uses stable fallback IDs, preserves exported identities, and permits reimport after deletion", async () => {
    const call = await account();
    const item = { name: "No ID", type: "http", target: "https://1.1.1.1/" };
    const p = (await call("POST", "/monitors/import/preview", [item])).body;
    expect(p.report[0].sourceId).toMatch(/^sha256:/);
    expect((await call("POST", "/monitors/import", [item])).body.created).toBe(1);
    expect((await call("POST", "/monitors/import", [item])).body.duplicates).toBe(1);
    const native = await call("POST", "/monitors", { ...item, name: "Native" });
    expect(native.status).toBe(201);
    const exported = (await call("GET", "/monitors/export")).body;
    expect(exported.monitors.find((r: any) => r.name === "Native")).toMatchObject({ source: "openuptime", sourceId: native.body.id });
    expect((await call("POST", "/monitors/import", exported)).body).toMatchObject({ created: 0, duplicates: 2 });
    const imported = (await call("GET", "/monitors")).body.find((r: any) => r.name === "No ID");
    expect((await call("DELETE", `/monitors/${imported.id}`)).status).toBe(204);
    expect((await call("POST", "/monitors/import", [item])).body.created).toBe(1);
  });

  it("reports invalid rows and refuses silently lost authentication", async () => {
    const call = await account();
    const input = { source: "test", monitors: [row("valid"), row("masked", { headers: { Authorization: MASK } }), row("auth", { basicAuthPass: "secret" }), row("bad-source", { source: "bad namespace" }), row("private", { target: "http://127.0.0.1/" }), null] };
    const p = await call("POST", "/monitors/import/preview", input);
    expect(p.body).toMatchObject({ ready: 1, created: 0 });
    expect(p.body.skipped).toHaveLength(5);
    expect(JSON.stringify(p.body)).not.toContain('"secret"');
    const execute = await call("POST", "/monitors/import", input);
    expect(execute.body).toMatchObject({ created: 1 });
    expect(execute.body.skipped).toHaveLength(5);
  });

  it("rejects SSL monitor types unsupported by the Community schema", async () => {
    const call = await account();
    const input = { source: "test", monitors: [row("ssl", { type: "ssl" })] };
    const preview = await call("POST", "/monitors/import/preview", input);
    expect(preview.body).toMatchObject({ ready: 0, created: 0, canImport: false });
    expect(preview.body.skipped).toHaveLength(1);
    expect((await call("POST", "/monitors/import", input)).status).toBe(400);
    expect((await call("GET", "/monitors")).body).toHaveLength(0);
  });

  it("previews plan adjustments and checks capacity only for genuinely new identities", async () => {
    const call = await account(limited);
    const input = { source: "test", monitors: [row("1", { regions: ["unknown"] }), row("2")] };
    const preview = await call("POST", "/monitors/import/preview", input);
    expect(preview.body).toMatchObject({ canImport: false, ready: 2, capacity: { active: 0, max: 1, requested: 2 } });
    expect(preview.body.report[0]).toMatchObject({ intervalSec: 300, regions: ["auto"] });
    const refused = await call("POST", "/monitors/import", input);
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({ code: "monitor_limit", limit: 1, active: 0, plan: "one", error: "The One plan allows 1 active monitors", capacity: { active: 0, max: 1, requested: 2 } });
    expect((await call("GET", "/monitors")).body).toHaveLength(0);
    const one = { source: "test", monitors: [row("1")] };
    expect((await call("POST", "/monitors/import", one)).body.created).toBe(1);
    expect((await call("POST", "/monitors/import", one)).body).toMatchObject({ duplicates: 1, created: 0, capacity: null });
  });

  it("imports an Uptime Kuma backup as it is, keeps ids, explains skipped rows and dedupes a second run", async () => {
    const call = await account();
    pings(false);
    const file = offline(kumaFile);
    const preview = await call("POST", "/monitors/import/preview", file);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ format: "uptime-kuma", ready: 6, created: 0 });
    expect(preview.body.report.map((r: any) => [r.name, r.status])).toEqual([["Homepage", "ready"], ["Login page", "ready"], ["Status JSON", "ready"], ["Postgres port", "ready"], ["MX records", "ready"], ["Cron job", "ready"], ["Gateway", "skipped"], ["Containers", "skipped"], ["Production", "skipped"], ["Maintenance flag", "skipped"]]);
    expect(preview.body.report[6]).toMatchObject({ source: "uptime-kuma", sourceId: "7" });
    expect(preview.body.report[0]).toMatchObject({ source: "uptime-kuma", sourceId: "1" });
    expect(preview.body.report[6].error).toMatch(/cannot send ping/);
    // nothing about the source tool's fields is called unsupported, and no secret is echoed
    expect(preview.body.report.flatMap((r: any) => r.warnings).join(" ")).not.toMatch(/Unsupported fields/);
    expect(JSON.stringify(preview.body)).not.toContain("redacted-test-password");
    const done = await call("POST", "/monitors/import", { ...file, destination: preview.body.destination });
    expect(done.body).toMatchObject({ created: 6, duplicates: 0 });
    const monitors = (await call("GET", "/monitors")).body;
    expect(monitors.find((m: any) => m.name === "Login page")).toMatchObject({ type: "http", keyword: "Sign in", keywordMode: "contains", failureThreshold: 1, importSource: "uptime-kuma", importSourceId: "2" });
    expect(monitors.find((m: any) => m.name === "Cron job")).toMatchObject({ type: "heartbeat", intervalSec: 3600 });
    // the dashboard sends the list alone; the second run is recognised
    expect((await call("POST", "/monitors/import", { monitors: file.monitorList })).body).toMatchObject({ format: "uptime-kuma", created: 0, duplicates: 6 });
  });

  it("imports a ping monitor where this server can send ping", async () => {
    const call = await account();
    pings(true);
    const file = offline(robotFile);
    const done = await call("POST", "/monitors/import", { ...file, monitors: [file.monitors[6]] });
    expect(done.body).toMatchObject({ created: 1 });
    expect((await call("GET", "/monitors")).body[0]).toMatchObject({ name: "Router", type: "ping", target: "1.1.1.1", importSourceId: "777000007" });
  });

  it("imports an UptimeRobot getMonitors answer with the plan's interval and keyword semantics", async () => {
    const call = await account(limited);
    pings(false);
    const file = offline(robotFile);
    const one = { ...file, monitors: [file.monitors[2], file.monitors[6]] };
    const preview = await call("POST", "/monitors/import/preview", one);
    expect(preview.body).toMatchObject({ format: "uptimerobot", ready: 1 });
    expect(preview.body.report[0]).toMatchObject({ source: "uptimerobot", sourceId: "777000003", intervalSec: 300 });
    expect(preview.body.report[1]).toMatchObject({ status: "skipped", error: expect.stringMatching(/cannot send ping/) });
    expect((await call("POST", "/monitors/import", one)).body.created).toBe(1);
    expect((await call("GET", "/monitors")).body[0]).toMatchObject({ keyword: "Service unavailable", keywordMode: "absent" });
    expect((await call("POST", "/monitors/import/preview", { ...one, format: "nope" })).status).toBe(400);
  });
});
