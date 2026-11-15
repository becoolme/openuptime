import { describe, expect, it, vi } from "vitest";
import { keywordFound, keywordOutcome, keywordProblem } from "./keyword";
import { configureProbes, resetProbeCapabilities, runInRegion } from "./probes";

describe("keyword patterns", () => {
  it("refuses patterns RE2 cannot run, and only in the pattern modes", () => {
    expect(keywordProblem("status:\\s*ok", "matches")).toBeNull();
    expect(keywordProblem("(?i)ready", "not_matches")).toBeNull();
    for (const bad of ["(a)\\1", "(?=a)b", "(?<!x)y", "[", "a{1001}"]) expect(keywordProblem(bad, "matches"), bad).toMatch(/Not a usable regular expression/);
    // plain text is never parsed
    expect(keywordProblem("[", "contains")).toBeNull();
    expect(keywordProblem("x".repeat(501), "contains")).toMatch(/at most 500/);
  });

  it("matches anywhere in the text, with (?i) for case", () => {
    expect(keywordFound('"version": "2.4"', "matches", '{"version": "2.4"}')).toBe(true);
    expect(keywordFound('"version":\\s*"2\\.', "matches", '{"version":  "2.4"}')).toBe(true);
    expect(keywordFound("^ok$", "matches", "ok\nmore")).toBe(false);
    expect(keywordFound("READY", "matches", "ready")).toBe(false);
    expect(keywordFound("(?i)READY", "matches", "ready")).toBe(true);
    // plain modes stay literal
    expect(keywordFound("a.c", "contains", "abc")).toBe(false);
  });

  it("explains a failure in the mode's own words", () => {
    expect(keywordOutcome("ok\\d", "matches", "ok!", "response")).toEqual({ ok: false, error: "No match for /ok\\d/ in response" });
    expect(keywordOutcome("err(or)?", "not_matches", "an error", "the reply")).toEqual({ ok: false, error: "Unexpected match for /err(or)?/ in the reply" });
    expect(keywordOutcome("err", "not_matches", "fine", "the reply")).toEqual({ ok: true });
    expect(keywordOutcome("(?=x)", "matches", "x", "response")).toMatchObject({ ok: false, error: expect.stringContaining("not a usable") });
  });

  it("runs in time proportional to the text, even for patterns that backtrack elsewhere", () => {
    const text = `${"a".repeat(200_000)}!`;
    const started = Date.now();
    for (const p of ["(a+)+b", "(a|aa)*b", ".*.*.*b", "(\\w+\\s?)*b"]) expect(keywordFound(p, "matches", text), p).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("keyword patterns on probes", () => {
  it("are only sent to probes that advertise them", async () => {
    resetProbeCapabilities();
    configureProbes({ PROBE_REGIONS: '{"test":"https://probe.example.com/"}', PROBE_SECRET: "fixture" });
    const input = { type: "http" as const, target: "https://example.com/", method: "GET", expectedStatus: 200, timeoutMs: 1000, keyword: "ok\\d", keywordMode: "matches" };
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ capabilities: ["http-request-body-v1", "json-assert-v1"] }));
    vi.stubGlobal("fetch", fetch);
    try {
      expect(await runInRegion("test", input)).toEqual({ region: "test", unreachable: "Probe upgrade required for keyword patterns" });
      // a plain keyword does not need the upgrade
      fetch.mockImplementation(async (_url, init) => (init?.method !== "POST" ? Response.json({ capabilities: [] }) : Response.json({ ok: true })));
      expect(await runInRegion("test", { ...input, keywordMode: "contains" })).toMatchObject({ outcome: { ok: true } });
      resetProbeCapabilities();
      fetch.mockImplementation(async (_url, init) => {
        if (init?.method !== "POST") return Response.json({ capabilities: ["keyword-regex-v1"] });
        expect(JSON.parse(init.body as string)).toMatchObject({ keyword: "ok\\d", keywordMode: "matches" });
        return Response.json({ ok: true });
      });
      expect(await runInRegion("test", input)).toMatchObject({ outcome: { ok: true } });
    } finally { vi.unstubAllGlobals(); configureProbes({}); resetProbeCapabilities(); }
  });
});
