import { describe, expect, it, vi } from "vitest";
import { configureProbes, resetProbeCapabilities, runInRegion } from "./probes";
import { parseStatusSpec, statusAccepted, statusRule, statusRuleText } from "./status-spec";

const accepts = (raw: string, status: number) => {
  const p = parseStatusSpec(raw);
  if ("error" in p) throw new Error(p.error);
  return statusAccepted(p.spec, status);
};

describe("status lists", () => {
  it("accepts codes, ranges and classes", () => {
    expect(accepts("200-299,401", 204)).toBe(true);
    expect(accepts("200-299,401", 401)).toBe(true);
    expect(accepts("200-299,401", 403)).toBe(false);
    expect(accepts("2xx,3XX", 302)).toBe(true);
    expect(accepts("418", 418)).toBe(true);
  });

  it("subtracts exclusions, and takes everything else when there are only exclusions", () => {
    expect(accepts("200-499,!404", 404)).toBe(false);
    expect(accepts("200-499,!404", 403)).toBe(true);
    expect(accepts("!5xx", 200)).toBe(true);
    expect(accepts("!5xx", 503)).toBe(false);
    expect(accepts("2xx,!204", 204)).toBe(false);
  });

  it("normalizes spacing and case", () => {
    expect(parseStatusSpec(" 200 - 299 , ! 404, 3XX ,")).toMatchObject({ normalized: "200-299,!404,3xx" });
  });

  it("refuses what it cannot read, with a reason", () => {
    for (const bad of ["", " , ", "abc", "99", "600", "200-", "299-200", "6xx", "2x", "200-700", "!2xx,2xx", Array(21).fill("200").join(","), "1".repeat(201)]) {
      expect(parseStatusSpec(bad), bad).toHaveProperty("error");
    }
    expect(parseStatusSpec("299-200")).toEqual({ error: expect.stringMatching(/backwards/) });
    expect(parseStatusSpec("!1xx,!2xx,!3xx,!4xx,!5xx")).toEqual({ error: expect.stringMatching(/no status/) });
  });

  it("falls back to the single expected status, where 200 means any 2xx", () => {
    expect(statusAccepted(statusRule({ expectedStatus: 200 }), 204)).toBe(true);
    expect(statusAccepted(statusRule({ expectedStatus: 201 }), 200)).toBe(false);
    expect(statusAccepted(statusRule({ expectedStatus: 200, acceptedStatuses: "401" }), 200)).toBe(false);
    expect(statusRuleText({ expectedStatus: 200, acceptedStatuses: "2xx,401" })).toBe("2xx,401");
    expect(statusRuleText({ expectedStatus: 301, acceptedStatuses: null })).toBe("301");
  });
});

describe("status lists on probes", () => {
  it("are only sent to probes that understand them", async () => {
    resetProbeCapabilities();
    configureProbes({ PROBE_REGIONS: '{"test":"https://probe.example.com/"}', PROBE_SECRET: "fixture" });
    const input = { type: "http" as const, target: "https://example.com/", method: "GET", expectedStatus: 200, acceptedStatuses: "2xx,401", timeoutMs: 1000 };
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ capabilities: ["json-assert-v1"] }));
    vi.stubGlobal("fetch", fetch);
    try {
      // an older probe would check expectedStatus alone and report the wrong result
      expect(await runInRegion("test", input)).toEqual({ region: "test", unreachable: "Probe upgrade required for status lists and ranges" });
      fetch.mockImplementation(async (_url, init) => {
        if (init?.method !== "POST") return Response.json({ capabilities: ["status-spec-v1"] });
        expect(JSON.parse(init.body as string).acceptedStatuses).toBe("2xx,401");
        return Response.json({ ok: true });
      });
      expect(await runInRegion("test", input)).toMatchObject({ outcome: { ok: true } });
    } finally { vi.unstubAllGlobals(); configureProbes({}); resetProbeCapabilities(); }
  });
});
