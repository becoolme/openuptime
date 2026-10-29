import { describe, expect, it } from "vitest";
import { publicMonitorStatus } from "./public-monitor-status";
import type { Monitor } from "@openuptime/repo";
const now = Date.parse("2026-10-29T00:00:00Z");
const m = { type: "domain", status: "down", paused: false, domainExpiryWarnDays: 30 } as Monitor;
const expiry = { state: "valid", expiresAt: new Date(now + 60 * 864e5).toISOString(), cacheUntil: new Date(now + 3600_000).toISOString() } as NonNullable<Monitor["domainExpiry"]>;
describe("public registration status", () => {
  it("does not turn missing or stale dates into operational or outage", () => {
    for (const domainExpiry of [null, { ...expiry, state: "unknown" as const }, { ...expiry, cacheUntil: new Date(now).toISOString() }, { ...expiry, expiresAt: "invalid" }]) {
      expect(publicMonitorStatus({ ...m, domainExpiry }, now)).toBe("unknown");
    }
  });
  it("shows date warnings as degradation and preserves service and pause states", () => {
    expect(publicMonitorStatus({ ...m, domainExpiry: expiry }, now)).toBe("up");
    expect(publicMonitorStatus({ ...m, domainExpiry: { ...expiry, expiresAt: new Date(now - 1).toISOString() } }, now)).toBe("degraded");
    expect(publicMonitorStatus({ ...m, paused: true, status: "paused" }, now)).toBe("paused");
    expect(publicMonitorStatus({ ...m, type: "http" }, now)).toBe("down");
  });
});
