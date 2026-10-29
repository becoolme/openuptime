import { describe, expect, it } from "vitest";
import type { Monitor } from "./api";
import { monitorState } from "./domain-expiry";
const now = Date.now();
const monitor = { type: "domain", status: "up", domainExpiry: { state: "valid", expiresAt: new Date(now + 90 * 864e5).toISOString(), cacheUntil: new Date(now + 3600_000).toISOString() } } as Monitor;
describe("domain expiry presentation", () => {
  it("does not present missing, unknown or stale data as healthy", () => {
    expect(monitorState(monitor, now).label).toBe("Expiry verified");
    expect(monitorState({ ...monitor, domainExpiry: null }, now).label).toBe("Unknown expiry");
    expect(monitorState(monitor, now + 3600_001).tone).toBe("degraded");
    expect(monitorState({ ...monitor, domainExpiry: { ...monitor.domainExpiry!, state: "unknown" } }, now).label).toBe("Unknown expiry");
  });
  it("distinguishes renewal, passed date and paused checks", () => {
    expect(monitorState({ ...monitor, domainExpiry: { ...monitor.domainExpiry!, state: "expiring" } }, now).label).toBe("Renewal needed");
    expect(monitorState({ ...monitor, domainExpiry: { ...monitor.domainExpiry!, expiresAt: new Date(now - 1).toISOString() } }, now).label).toBe("Registration date passed");
    expect(monitorState({ ...monitor, paused: true, status: "paused" }, now).label).toBe("paused");
  });
});
