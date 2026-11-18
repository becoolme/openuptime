import { describe, expect, it } from "vitest";
import {
  diskUse, filterServers, fmtBytes, fmtRate, fmtSpan, fmtUptime, fullestDisk, hotReasons, ipRows, level, maskIp, pct, platformLabel,
  primaryIp, serverState, since, specLabel,
} from "./servers";

const iface = (ipv4: string[], ipv6: string[] = []) => ({ name: "eth0", mac: "", ipv4, ipv6, rxBps: 0, txBps: 0 });
const snap = (interfaces: ReturnType<typeof iface>[]) => ({ at: "", metrics: {} as never, disks: [], interfaces });

describe("server formatting", () => {
  it("formats bytes and rates", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(200 * 1024 ** 3)).toBe("200 GB");
    expect(fmtRate(2 * 1024 ** 2)).toBe("2.0 MB/s");
  });
  it("clamps percentages", () => {
    expect(pct(5, 0)).toBe(0);
    expect(pct(50, 200)).toBe(25);
    expect(pct(300, 200)).toBe(100);
    expect(level(74)).toBe("ok");
    expect(level(75)).toBe("warn");
    expect(level(95)).toBe("bad");
  });
  it("formats uptime", () => {
    expect(fmtUptime(undefined)).toBe("—");
    expect(fmtUptime(300)).toBe("5m");
    expect(fmtUptime(3700)).toBe("1h 1m");
    expect(fmtUptime(93784)).toBe("1d 2h");
  });
  it("counts a device mounted twice once", () => {
    const d = (device: string, mount: string, used: number, total: number) => ({ device, mount, fs: "ext4", used, total });
    expect(diskUse([d("/dev/sda1", "/", 10, 100), d("/dev/sda1", "/var/lib/x", 10, 100), d("/dev/sdb1", "/data", 5, 50)])).toEqual({ used: 15, total: 150 });
    expect(diskUse([d("none", "/a", 1, 2), d("none", "/b", 1, 2)])).toEqual({ used: 2, total: 4 });
  });
  it("prefers a public IPv4", () => {
    expect(primaryIp({ snapshot: snap([iface(["10.0.0.4"]), iface(["203.0.113.9"])]) })).toBe("203.0.113.9");
    expect(primaryIp({ snapshot: snap([iface(["192.168.1.2"])]) })).toBe("192.168.1.2");
    expect(primaryIp({ snapshot: snap([iface([], ["2001:db8::1"])]) })).toBe("2001:db8::1");
    expect(primaryIp({ snapshot: null })).toBe("");
  });
  it("labels the platform", () => {
    expect(platformLabel({ platform: "Ubuntu", os: "linux", snapshot: { ...snap([]), platformVersion: "24.04" } })).toBe("Ubuntu 24.04");
    expect(platformLabel({ platform: "", os: "linux", snapshot: null })).toBe("linux");
  });
});

const GB = 1024 ** 3;
const metrics = (cpu: number, memUsed = 0) => ({ cpu, memUsed, memCached: 0, swapUsed: 0, load1: 0, load5: 0, load15: 0, diskReadBps: 0, diskWriteBps: 0, netRxBps: 0, netTxBps: 0 });
const disk = (mount: string, used: number, total: number) => ({ device: `/dev/${mount.length}`, mount, fs: "ext4", used, total });
const server = (o: { name?: string; tags?: string[]; online?: boolean; seen?: boolean; cpu?: number; mem?: number; disks?: ReturnType<typeof disk>[]; ips?: string[] } = {}) => ({
  name: o.name ?? "web-01", hostname: `${o.name ?? "web-01"}.internal`, tags: o.tags ?? [], online: o.online ?? true,
  lastSeenAt: o.seen === false ? null : "2026-11-18T10:00:00Z", memTotal: 16 * GB,
  snapshot: o.seen === false ? null : { at: "", metrics: metrics(o.cpu ?? 10, (o.mem ?? 0) * 16 * GB), disks: o.disks ?? [], interfaces: [iface(o.ips ?? ["203.0.113.7"])] },
});

describe("server views", () => {
  it("shows a span as its largest unit", () => {
    expect(fmtSpan(null)).toBe("—");
    expect(fmtSpan(-1)).toBe("—");
    expect(fmtSpan(30)).toBe("30s");
    expect(fmtSpan(14 * 60 + 59)).toBe("14m");
    expect(fmtSpan(5 * 3600)).toBe("5h");
    expect(fmtSpan(41 * 86400 + 3600)).toBe("41d");
    expect(since(null)).toBe("—");
    expect(since("2026-11-18T10:00:00Z", Date.parse("2026-11-18T10:14:00Z"))).toBe("14m ago");
  });
  it("names what the machine has", () => {
    expect(specLabel({ cores: 4, memTotal: 16 * GB })).toBe("4 cores · 16 GB");
    expect(specLabel({ cores: 0, memTotal: 0 })).toBe("");
  });
  it("finds the fullest disk", () => {
    expect(fullestDisk([])).toBeNull();
    expect(fullestDisk([disk("/", 50, 100), disk("/data", 95, 100)])).toMatchObject({ mount: "/data", pct: 95 });
  });
  it("calls a server hot at 90% and only while online", () => {
    expect(hotReasons(server({ cpu: 89.9 }))).toEqual([]);
    expect(hotReasons(server({ cpu: 92, mem: 0.91, disks: [disk("/", 95, 100)] }))).toEqual(["CPU 92%", "Memory 91%", "Disk / 95%"]);
    expect(hotReasons(server({ cpu: 99, online: false }))).toEqual([]);
    expect(serverState(server({ seen: false }))).toBe("waiting");
    expect(serverState(server({ online: false }))).toBe("offline");
    expect(serverState(server({ cpu: 95 }))).toBe("hot");
    expect(serverState(server())).toBe("online");
  });
  it("lists every address once, IPv4 first", () => {
    const s = snap([iface(["10.0.0.4"], ["fe80::1"]), { ...iface(["203.0.113.7", "10.0.0.4"], []), name: "eth1" }]);
    expect(ipRows(s)).toEqual([
      { family: "IPv4", ip: "10.0.0.4", iface: "eth0" },
      { family: "IPv4", ip: "203.0.113.7", iface: "eth1" },
      { family: "IPv6", ip: "fe80::1", iface: "eth0" },
    ]);
    expect(ipRows(null)).toEqual([]);
  });
  it("hides every digit of an address", () => {
    expect(maskIp("")).toBe("");
    expect(maskIp("203.0.113.7")).not.toMatch(/\d/);
    expect(maskIp("2001:db8::1")).not.toMatch(/[0-9a-f]{2}/);
  });
  it("filters by pill and search", () => {
    const list = [
      server({ name: "web-01", tags: ["prod"] }),
      server({ name: "db-01", tags: ["prod", "db"], cpu: 95, ips: ["198.51.100.4"] }),
      server({ name: "staging-01", tags: ["staging"], online: false }),
    ];
    const names = (xs: typeof list) => xs.map((s) => s.name);
    expect(names(filterServers(list, "", "all"))).toEqual(["web-01", "db-01", "staging-01"]);
    expect(names(filterServers(list, "", "hot"))).toEqual(["db-01"]);
    expect(names(filterServers(list, "", "offline"))).toEqual(["staging-01"]);
    expect(names(filterServers(list, "", "tag:prod"))).toEqual(["web-01", "db-01"]);
    expect(names(filterServers(list, "198.51", "all"))).toEqual(["db-01"]);
    expect(names(filterServers(list, "STAGING", "all"))).toEqual(["staging-01"]);
    expect(names(filterServers(list, "web", "tag:db"))).toEqual([]);
  });
});
