import { openDatabase } from "@openuptime/db-pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import type { Edition } from "./edition";
import { type Plan, unmetered } from "./entitlements";
import { diskTotals, INSTALL_SCRIPT, installCommand, minServerInterval, reportSchema, serverDeadline, serverOnline } from "./routes/servers";

describe("server reports", () => {
  it("allows 30 s without plans, and what the plan says otherwise", () => {
    expect(minServerInterval(null)).toBe(30);
    expect(minServerInterval({ id: "free" } as never)).toBe(60);
    expect(minServerInterval({ id: "pro", minServerIntervalSec: 30 } as never)).toBe(30);
  });
  it("counts a server offline after three missed reports", () => {
    const now = Date.now();
    expect(serverOnline({ lastSeenAt: null, intervalSec: 60 }, now)).toBe(false);
    expect(serverOnline({ lastSeenAt: new Date(now - 170_000), intervalSec: 60 }, now)).toBe(true);
    expect(serverOnline({ lastSeenAt: new Date(now - 181_000), intervalSec: 60 }, now)).toBe(false);
  });
  it("counts each device once", () => {
    const d = (device: string, mount: string) => ({ device, mount, fs: "ext4", used: 10, total: 100 });
    expect(diskTotals([d("/dev/sda1", "/"), d("/dev/sda1", "/srv"), d("/dev/sdb", "/data")])).toEqual({ used: 20, total: 200 });
    expect(diskTotals([d("none", "/a"), d("none", "/b")])).toEqual({ used: 20, total: 200 });
  });
  it("bounds what an agent may send", () => {
    const base = { machineId: "abcdef0123456789", metrics: { cpu: 5, memUsed: 1 } };
    expect(reportSchema.safeParse(base).success).toBe(true);
    expect(reportSchema.safeParse({ ...base, machineId: "short" }).success).toBe(false);
    expect(reportSchema.safeParse({ ...base, machineId: "../../etc/passwd" }).success).toBe(false);
    expect(reportSchema.safeParse({ ...base, metrics: { cpu: 101, memUsed: 1 } }).success).toBe(false);
    expect(reportSchema.safeParse({ ...base, metrics: { cpu: 5, memUsed: 2e15 } }).success).toBe(false);
  });
  it("cuts an oversized report down instead of refusing it", () => {
    const r = reportSchema.parse({
      machineId: "abcdef0123456789",
      metrics: { cpu: 5, memUsed: 1.5, swapUsed: 2.4 },
      disks: Array.from({ length: 300 }, (_, i) => ({ mount: `/${"d".repeat(2000)}${i}`, total: 10.6, used: 1 })),
      interfaces: Array.from({ length: 300 }, (_, i) => ({ name: `tap${i}i0`, ipv6: Array.from({ length: 50 }, () => "2001:db8::1") })),
    });
    expect(r.disks).toHaveLength(64);
    expect(r.disks[0].mount).toHaveLength(1024);
    expect(r.disks[0].total).toBe(11);
    expect(r.interfaces).toHaveLength(64);
    expect(r.interfaces[0].ipv6).toHaveLength(32);
    expect(r.metrics).toMatchObject({ memUsed: 2, swapUsed: 2 });
  });
  it("takes an empty list sent as null", () => {
    const r = reportSchema.parse({ machineId: "abcdef0123456789", metrics: { cpu: 5, memUsed: 1 }, disks: null, interfaces: [{ name: "lo", ipv4: null }] });
    expect(r.disks).toEqual([]);
    expect(r.interfaces[0].ipv4).toEqual([]);
  });
  it("takes the install command's name and tags without ever refusing a report for them", () => {
    const base = { machineId: "abcdef0123456789", metrics: { cpu: 5, memUsed: 1 } };
    expect(reportSchema.parse(base)).toMatchObject({ name: "", tags: [] });
    const r = reportSchema.parse({ ...base, name: `  web\u0007 1 ${"x".repeat(200)}`, tags: [" prod ", "prod", "", 7, "t".repeat(40), ...Array.from({ length: 30 }, (_, i) => `t${i}`)] });
    expect(r.name).toHaveLength(120);
    expect(r.name.startsWith("web 1 ")).toBe(true);
    expect(r.tags).toHaveLength(20);
    expect(r.tags.slice(0, 3)).toEqual(["prod", "t".repeat(32), "t0"]);
    expect(reportSchema.parse({ ...base, name: 42, tags: "prod" })).toMatchObject({ name: "", tags: [] });
  });
  it("builds an install command a shell reads as intended", () => {
    const key = "oua_" + "a".repeat(48);
    expect(installCommand({ key, endpoint: "https://openuptime.app" }))
      .toBe(`curl -fsSL ${INSTALL_SCRIPT} | sudo sh -s -- --key ${key} --endpoint https://openuptime.app`);
    expect(installCommand({ key, endpoint: "https://up.example.com", name: "web 1", tags: ["prod", "東京", "prod"] }))
      .toBe(`curl -fsSL ${INSTALL_SCRIPT} | sudo sh -s -- --key ${key} --endpoint https://up.example.com --name 'web 1' --tags 'prod,東京'`);
    expect(installCommand({ key, endpoint: "http://10.0.0.5:8787" })).toMatch(/ --allow-http$/);
    expect(installCommand({ key, endpoint: "http://localhost:8787" })).not.toMatch(/allow-http/);
  });
  it("keeps the offline deadline when the interval gets shorter", () => {
    const now = Date.UTC(2026, 10, 18);
    const later = new Date(now + 900_000);
    // 300 s -> 30 s: the agent still reports on the old interval once, so the old deadline stands
    expect(serverDeadline(later, { intervalSec: 30, graceSec: 60 }, now)).toBe(later);
    // 30 s -> 300 s: the new, later deadline applies at once
    expect(serverDeadline(new Date(now + 90_000), { intervalSec: 300, graceSec: 600 }, now).getTime()).toBe(now + 900_000);
    expect(serverDeadline(null, { intervalSec: 60, graceSec: 120 }, now).getTime()).toBe(now + 180_000);
  });
});

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };

/** Requests against an app built for one edition; the plan of `limited` below can change between steps. */
function harness(app: ReturnType<typeof createApp>) {
  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);
  const signUp = async () => {
    await raw("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const su = await raw("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `srv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: "correct horse battery", name: "Ada" }),
    });
    expect(su.status).toBe(200);
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return async (method: string, path: string, body?: unknown) => {
      const r = await raw(`/api${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };
  };
  const report = (key: string, body: unknown) =>
    raw("/api/agent/report", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const sample = (machineId: string) => ({
    version: "0.1.0", machineId, hostname: "web-1",
    host: { os: "linux", platform: "ubuntu", platformVersion: "24.04", kernel: "6.8.0", arch: "amd64", cpuModel: "Test CPU", cores: 4, memTotal: 8e9, swapTotal: 0, uptimeSec: 3600 },
    metrics: { cpu: 12.5, memUsed: 2e9, load1: 0.4, netRxBps: 1000, netTxBps: 500 },
    disks: [{ device: "/dev/sda1", mount: "/", fs: "ext4", total: 100e9, used: 40e9 }, { device: "/dev/sda1", mount: "/srv", fs: "ext4", total: 100e9, used: 40e9 }],
    interfaces: [{ name: "eth0", mac: "00:00:5e:00:53:01", ipv4: ["203.0.113.7", "10.0.0.7"], ipv6: ["2001:db8::7"] }],
  });

  return { raw, signUp, report, sample };
}

describe.skipIf(!url)("Server monitoring", () => {
  const { raw, signUp, report, sample } = harness(createApp(openDatabase));

  it("registers a machine on its first report and shows its metrics", async () => {
    const call = await signUp();
    const { key } = (await call("GET", "/servers/agent-key")).body;
    expect(key).toMatch(/^oua_[0-9a-f]{48}$/);
    expect((await call("GET", "/servers/agent-key")).body.key).toBe(key);

    expect((await report("oua_" + "0".repeat(48), sample("machine-aaaa"))).status).toBe(401);
    expect((await report(key, { machineId: "machine-aaaa" })).status).toBe(400);

    const first = await report(key, sample("machine-aaaa"));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, interval: 60 });
    // a second report right away is acknowledged but not stored
    expect(await (await report(key, sample("machine-aaaa"))).json()).toMatchObject({ skipped: true });

    const list = (await call("GET", "/servers")).body;
    expect(list.servers).toHaveLength(1);
    expect(list.minIntervalSec).toBe(30); // no plans on a self-hosted install
    const s = list.servers[0];
    expect(s).toMatchObject({ name: "web-1", platform: "ubuntu", cores: 4, online: true, intervalSec: 60 });
    expect(s.snapshot.interfaces[0].ipv4).toEqual(["203.0.113.7", "10.0.0.7"]);
    expect(s.snapshot.disks).toHaveLength(2);

    const detail = (await call("GET", `/servers/${s.id}?range=1h`)).body;
    expect(detail.points).toHaveLength(1);
    expect(detail.points[0].diskTotal).toBe(100e9); // the device mounted twice counts once
    expect(detail.monitorStatus).toBe("up");

    // the backing heartbeat monitor carries offline alerts
    const monitor = (await call("GET", `/monitors/${s.monitorId}`)).body;
    expect(monitor).toMatchObject({ type: "heartbeat", tags: ["server"] });
  });

  it("names and tags a server from its install command, once", async () => {
    const call = await signUp();
    const install = await call("POST", "/servers/install", { name: "Tokyo edge", tags: ["prod", "jp"] });
    expect(install.status).toBe(200);
    const { key } = install.body;
    expect(key).toBe((await call("GET", "/servers/agent-key")).body.key);
    expect(install.body).toMatchObject({ endpoint: ORIGIN, script: INSTALL_SCRIPT });
    expect(install.body.command).toBe(installCommand({ key, endpoint: ORIGIN, name: "Tokyo edge", tags: ["prod", "jp"] }));
    expect(install.body.uninstallCommand).toMatch(/--uninstall$/);
    expect((await call("POST", "/servers/install", { name: "it's" })).status).toBe(400);
    expect((await call("POST", "/servers/install", { tags: ["a,b"] })).status).toBe(400);
    expect((await call("POST", "/servers/install")).status).toBe(200);

    expect((await report(key, { ...sample("machine-named"), name: "Tokyo edge", tags: ["prod", "jp"] })).status).toBe(200);
    const s = (await call("GET", "/servers")).body.servers[0];
    expect(s).toMatchObject({ name: "Tokyo edge", tags: ["prod", "jp"], hostname: "web-1" });
    expect((await call("GET", `/monitors/${s.monitorId}`)).body.name).toBe("Tokyo edge");

    // renamed in the dashboard: a reinstall with other options does not undo that
    await call("PATCH", `/servers/${s.id}`, { name: "edge-1", tags: [] });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 120_000 });
    try {
      expect((await report(key, { ...sample("machine-named"), name: "Other", tags: ["x"] })).status).toBe(200);
    } finally { vi.useRealTimers(); }
    expect((await call("GET", `/servers/${s.id}`)).body).toMatchObject({ name: "edge-1", tags: [] });
  });

  it("changes the interval, keeps the monitor in step and deletes both", async () => {
    const call = await signUp();
    const { key } = (await call("GET", "/servers/agent-key")).body;
    await report(key, sample("machine-bbbb"));
    const s = (await call("GET", "/servers")).body.servers[0];

    expect((await call("PATCH", `/servers/${s.id}`, { intervalSec: 45 })).status).toBe(400);
    const patched = await call("PATCH", `/servers/${s.id}`, { intervalSec: 30, name: "db" });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ name: "db", intervalSec: 30 });
    const monitor = (await call("GET", `/monitors/${s.monitorId}`)).body;
    expect(monitor).toMatchObject({ name: "db", intervalSec: 30, graceSec: 60 });
    // the agent still reports on the 60 s interval until it hears the new one: no early offline deadline
    expect(new Date(monitor.nextCheckAt).getTime()).toBeGreaterThan(Date.now() + 150_000);

    const rotated = (await call("POST", "/servers/agent-key/rotate")).body.key;
    expect(rotated).not.toBe(key);
    expect((await report(key, sample("machine-bbbb"))).status).toBe(401);

    expect((await call("DELETE", `/servers/${s.id}`)).status).toBe(204);
    expect((await call("GET", "/servers")).body.servers).toHaveLength(0);
    expect((await call("GET", `/monitors/${s.monitorId}`)).status).toBe(404);
  });
});

describe.skipIf(!url)("Server limits of a plan", () => {
  let plan: Plan = { id: "paid", name: "Paid", maxActiveMonitors: 1, minIntervalSec: 60, minServerIntervalSec: 30, maxServers: 2, upgradeUrl: "/upgrade" };
  const limited: Edition = { entitlements: () => ({ ...unmetered, plan: async () => plan }) };
  const { signUp, report, sample } = harness(createApp(openDatabase, { edition: limited }));
  afterEach(() => { vi.useRealTimers(); });

  it("caps servers per workspace, keeps the oldest after a downgrade and leaves the monitor quota alone", async () => {
    const call = await signUp();
    const { key } = (await call("GET", "/servers/agent-key")).body;
    // the plan allows one monitor, yet two servers register: their heartbeat monitors do not count
    expect((await report(key, sample("machine-cap-a"))).status).toBe(200);
    expect((await report(key, sample("machine-cap-b"))).status).toBe(200);
    const third = await report(key, sample("machine-cap-c"));
    expect(third.status).toBe(402);
    expect(await third.json()).toMatchObject({ code: "server_limit", limit: 2, upgradeUrl: "/upgrade" });
    expect((await call("POST", "/monitors", { name: "Site", type: "http", target: "https://example.com", intervalSec: 60 })).status).toBe(201);
    expect((await call("GET", "/usage")).body).toMatchObject({ activeMonitors: 1, servers: 2 });

    const list = (await call("GET", "/servers")).body;
    expect(list).toMatchObject({ maxServers: 2, serverCount: 2, minIntervalSec: 30 });
    expect(list.servers).toHaveLength(2);
    const a = list.servers.find((s: any) => s.machineId === "machine-cap-a");
    expect((await call("PATCH", `/servers/${a.id}`, { intervalSec: 30 })).status).toBe(200);

    // downgrade: one server, 60 s at the fastest
    plan = { ...plan, maxServers: 1, minServerIntervalSec: 60 };
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 120_000 });
    const kept = await report(key, sample("machine-cap-a"));
    expect(kept.status).toBe(200);
    expect(await kept.json()).toEqual({ ok: true, interval: 60 });
    expect((await call("GET", `/monitors/${a.monitorId}`)).body).toMatchObject({ intervalSec: 60, graceSec: 120 });
    expect((await report(key, sample("machine-cap-b"))).status).toBe(402);

    // room again after deleting the kept one: the other server reports
    expect((await call("DELETE", `/servers/${a.id}`)).status).toBe(204);
    expect((await report(key, sample("machine-cap-b"))).status).toBe(200);
  });
});
