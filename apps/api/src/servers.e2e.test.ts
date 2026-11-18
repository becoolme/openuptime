import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { diskTotals, minServerInterval, reportSchema, serverDeadline, serverOnline } from "./routes/servers";

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

describe.skipIf(!url)("Server monitoring", () => {
  const app = createApp(openDatabase);
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
