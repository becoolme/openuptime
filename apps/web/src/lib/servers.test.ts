import { describe, expect, it } from "vitest";
import { diskUse, fmtBytes, fmtRate, fmtUptime, level, pct, platformLabel, primaryIp } from "./servers";

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
