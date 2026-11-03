import { describe, expect, it } from "vitest";
import type { Monitor } from "../lib/api";
import { sortMonitors } from "./Monitors";

const mon = (name: string, o: Partial<Monitor>) => ({ id: name, name, status: "up", paused: false, uptime24h: null, avgLatency24h: null, lastCheckedAt: null, ...o }) as Monitor;
const list = [
  mon("b", { status: "up", uptime24h: 99.5, avgLatency24h: 120, lastCheckedAt: "2026-11-03T10:00:00Z" }),
  mon("A", { status: "down", uptime24h: 80, avgLatency24h: 900, lastCheckedAt: "2026-11-03T10:05:00Z" }),
  mon("c", { status: "pending" }),
  mon("d", { status: "up", paused: true, uptime24h: 100, avgLatency24h: 40, lastCheckedAt: "2026-11-02T10:00:00Z" }),
];
const names = (l: Monitor[]) => l.map((m) => m.name);

describe("monitor list sort", () => {
  it("keeps the server order without a sort", () => {
    expect(sortMonitors(list, null)).toBe(list);
  });
  it("sorts by name, status and numbers, either way", () => {
    expect(names(sortMonitors(list, { key: "name", desc: false }))).toEqual(["A", "b", "c", "d"]);
    expect(names(sortMonitors(list, { key: "status", desc: false }))).toEqual(["A", "b", "c", "d"]);
    expect(names(sortMonitors(list, { key: "latency", desc: true }))).toEqual(["A", "b", "d", "c"]);
    expect(names(sortMonitors(list, { key: "checked", desc: true }))).toEqual(["A", "b", "d", "c"]);
  });
  it("keeps monitors without data at the end in both directions", () => {
    expect(names(sortMonitors(list, { key: "uptime", desc: false }))).toEqual(["A", "b", "d", "c"]);
    expect(names(sortMonitors(list, { key: "uptime", desc: true }))).toEqual(["d", "b", "A", "c"]);
  });
});
