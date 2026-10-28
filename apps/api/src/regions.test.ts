import { describe, expect, it } from "vitest";
import { configureProbes, isRegionConfigured, parseProbeRegions, availableRegions, combine, measure, runInRegion } from "./probes";
import { signProbe, verifyProbe } from "./probe-protocol";
import { effectiveRegions } from "./regions";

describe("effectiveRegions", () => {
  it("defaults to auto and only applies to http, tcp and websocket", () => {
    expect(effectiveRegions({ type: "http", regions: [] })).toEqual(["auto"]);
    expect(effectiveRegions({ type: "websocket", regions: ["eu-central"] })).toEqual(["eu-central"]);
    expect(effectiveRegions({ type: "http", regions: ["eu-central", "eu-central", "us-east"] })).toEqual(["eu-central", "us-east"]);
    expect(effectiveRegions({ type: "postgres", regions: ["eu-central"] })).toEqual(["auto"]);
    expect(effectiveRegions({ type: "heartbeat", regions: ["eu-central"] })).toEqual(["auto"]);
  });
});

describe("PROBE_REGIONS", () => {
  it("reads urls and labelled entries, and reports what it cannot use", () => {
    const { regions, problems } = parseProbeRegions(JSON.stringify({
      "us-east": "https://p.example.app/api/probe/us-east",
      "eu-central": { url: "https://p.example.app/api/probe/eu-central", name: "Frankfurt" },
      auto: "https://p.example.app/auto",
      "Bad Id": "https://p.example.app/x",
      plain: "http://p.example.app/insecure",
      "no-url": {},
    }));
    expect(regions.map((r) => [r.id, r.name])).toEqual([["us-east", "US East (Virginia)"], ["eu-central", "Frankfurt"]]);
    expect(problems).toHaveLength(4);
  });
  it("tolerates nothing, bad JSON and arrays", () => {
    expect(parseProbeRegions(undefined).regions).toEqual([]);
    expect(parseProbeRegions("{").problems).toHaveLength(1);
    expect(parseProbeRegions("[]").problems).toHaveLength(1);
  });
  it("keeps regions off without a secret", () => {
    configureProbes({ PROBE_REGIONS: '{"us-east":"https://p.example.app/a"}' });
    expect(availableRegions().map((r) => r.id)).toEqual(["auto"]);
    expect(isRegionConfigured("us-east")).toBe(false);
    configureProbes({ PROBE_REGIONS: '{"us-east":"https://p.example.app/a"}', PROBE_SECRET: "s" });
    expect(availableRegions().map((r) => r.id)).toEqual(["auto", "us-east"]);
    expect(isRegionConfigured("us-east")).toBe(true);
    expect(isRegionConfigured("nowhere")).toBe(false);
  });
});

describe("request signing", () => {
  it("accepts a fresh matching signature and nothing else", async () => {
    const now = 1_800_000_000;
    const body = '{"a":1}';
    const signature = await signProbe("k", now, body);
    expect(await verifyProbe("k", { timestamp: String(now), signature, body, nowSec: now + 30 })).toBe(true);
    expect(await verifyProbe("k", { timestamp: String(now), signature, body, nowSec: now + 61 })).toBe(false);
    expect(await verifyProbe("k", { timestamp: String(now), signature, body: '{"a":2}', nowSec: now })).toBe(false);
    expect(await verifyProbe("other", { timestamp: String(now), signature, body, nowSec: now })).toBe(false);
    expect(await verifyProbe("k", { timestamp: null, signature, body, nowSec: now })).toBe(false);
    expect(await verifyProbe("", { timestamp: String(now), signature, body, nowSec: now })).toBe(false);
  });
});

const run = (region: string, ok: boolean, latencyMs = 100, error?: string) => ({ region, outcome: { ok, statusCode: ok ? 200 : 503, latencyMs, error } });

describe("combine", () => {
  it("is null when no region answered", () => {
    expect(combine([{ region: "a", unreachable: "x" }])).toBeNull();
  });
  it("fails the run only when a strict majority of answering regions failed", () => {
    expect(combine([run("a", true), run("b", true), run("c", false, 50, "boom")])!.out.ok).toBe(true);
    const down = combine([run("a", false, 50, "boom"), run("b", false), run("c", true)])!;
    expect(down.out.ok).toBe(false);
    expect(down.out.error).toContain("2 of 3");
    expect(down.results).toHaveLength(3);
    // a tie is not a majority
    expect(combine([run("a", true), run("b", false)])!.out.ok).toBe(true);
  });
  it("honours the number of failing regions a monitor asks for, capped by those that answered", () => {
    const mixed = [run("a", true), run("b", false), run("c", false)];
    expect(combine(mixed, 3)!.out.ok).toBe(true);
    expect(combine(mixed, 3)!.note).toBe("2 of 3 regions failed, 3 needed");
    expect(combine(mixed, 2)!.out.ok).toBe(false);
    expect(combine([run("a", true), run("b", false), run("c", true)], 1)!.note).toBe("1 of 3 regions failed");
    // one region unreachable: 3 are asked for, only 2 answered, and both failed
    expect(combine([{ region: "a", unreachable: "x" }, run("b", false), run("c", false)], 3)!.out.ok).toBe(false);
    // 0 keeps the majority rule
    expect(combine(mixed, 0)!.out.ok).toBe(false);
  });
  it("leaves unreachable probes out of the vote and the record", () => {
    const r = combine([run("a", false, 10, "boom"), { region: "b", unreachable: "probe down" }, { region: "c", unreachable: "probe down" }])!;
    expect(r.out.ok).toBe(false);
    expect(r.results.map((x) => x.region)).toEqual(["a"]);
  });
  it("averages the latency of the passing regions", () => {
    expect(combine([run("a", true, 100), run("b", true, 300), run("c", false, 5)])!.out.latencyMs).toBe(200);
  });
});

describe("measure and runInRegion", () => {
  it("never touches a probe for auto, and treats a missing region as unreachable", async () => {
    configureProbes({});
    const r = await runInRegion("eu-central", { type: "http", target: "https://example.com", method: "GET", expectedStatus: 200, timeoutMs: 1000 });
    expect(r).toEqual({ region: "eu-central", unreachable: expect.stringContaining("not configured") });
  });
  it("falls back to this location when no probe answers", async () => {
    configureProbes({ PROBE_REGIONS: '{"eu-central":"http://127.0.0.1:1/api/probe/eu-central"}', PROBE_SECRET: "s" });
    const m = { id: "m", type: "tcp", target: "127.0.0.1:1", method: "GET", expectedStatus: 200, timeoutMs: 1000, regions: ["eu-central"] } as never;
    const out = await measure(m);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].region).toBe("auto");
  });
});
