import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runCheck } from "./checker";
import { assertionsForStatus, jsonAssertionProblem, jsonAssertionsSchema, parsePath } from "./json-assert";
import { configureNetGuard } from "./netguard";
import { configureProbes, resetProbeCapabilities, runInRegion } from "./probes";

const doc = JSON.stringify({ status: "ok", code: 200, live: true, gone: null, data: { items: [{ id: "a" }, { id: "b" }], tags: ["eu", "prod"] }, "odd key": 1 });
const check = (path: string, op: Parameters<typeof jsonAssertionProblem>[1][number]["op"], value = "") => jsonAssertionProblem(doc, [{ path, op, value }]);

describe("JSON paths", () => {
  it("reads keys, indexes and quoted keys", () => {
    expect(parsePath("$.data.items[1].id")).toEqual(["data", "items", 1, "id"]);
    expect(parsePath("data.items[0]")).toEqual(["data", "items", 0]);
    expect(parsePath('$["odd key"]')).toEqual(["odd key"]);
    expect(parsePath("$")).toEqual([]);
  });
  it("rejects what it cannot read", () => {
    for (const p of ["$..a", "$.a[", "$.a[x]", '$["a]', "$.a]"]) expect(typeof parsePath(p)).toBe("string");
    expect(jsonAssertionsSchema.safeParse([{ path: "$..a", op: "exists" }]).success).toBe(false);
    expect(jsonAssertionsSchema.safeParse(Array.from({ length: 11 }, () => ({ path: "$.a", op: "exists" }))).success).toBe(false);
  });
});

describe("JSON assertions", () => {
  it("compares strings, numbers, booleans and null as typed", () => {
    expect(check("$.status", "equals", "ok")).toBeNull();
    expect(check("$.code", "equals", "200")).toBeNull();
    expect(check("$.live", "equals", "true")).toBeNull();
    expect(check("$.gone", "equals", "null")).toBeNull();
    expect(check("$.code", "equals", "")).toMatch(/to equal/);
    expect(check("$.status", "not_equals", "down")).toBeNull();
    expect(check("$.status", "equals", "down")).toBe('Expected JSON $.status to equal "down", got "ok"');
  });
  it("checks presence, containment and ranges", () => {
    expect(check("$.data.items[1].id", "exists")).toBeNull();
    expect(check("$.data.items[2]", "exists")).toBe("JSON $.data.items[2] is missing");
    expect(check("$.gone", "exists")).toBeNull();
    expect(check("$.missing", "not_exists")).toBeNull();
    expect(check("$.data.tags", "contains", "prod")).toBeNull();
    expect(check("$.status", "contains", "o")).toBeNull();
    expect(check("$.code", "greater_than", "199")).toBeNull();
    expect(check("$.code", "less_than", "200")).toMatch(/less than/);
    expect(check("$.status", "greater_than", "1")).toMatch(/greater than/);
    expect(check('$["odd key"]', "equals", "1")).toBeNull();
  });
  it("does not walk into prototypes", () => {
    expect(check("$.constructor", "exists")).toMatch(/missing/);
    expect(check("$.data.items.length", "exists")).toMatch(/missing/);
  });
  it("fails a body that is not JSON", () => {
    expect(jsonAssertionProblem("<html>", [{ path: "$.a", op: "exists", value: "" }])).toBe("Response is not valid JSON");
  });
});

describe("JSON assertions in HTTP checks", () => {
  const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(doc); });
  let base = "";
  beforeAll(async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => { server.close(); configureNetGuard({}); });
  const run = (jsonAssertions: Parameters<typeof jsonAssertionProblem>[1], keyword?: string) =>
    runCheck({ type: "http", target: base, method: "GET", expectedStatus: 200, timeoutMs: 3000, keyword, jsonAssertions });

  it("passes when every assertion holds, and reports the first that does not", async () => {
    expect(await run([{ path: "$.status", op: "equals", value: "ok" }, { path: "$.code", op: "less_than", value: "300" }])).toMatchObject({ ok: true, statusCode: 200 });
    expect(await run([{ path: "$.status", op: "equals", value: "ok" }, { path: "$.live", op: "equals", value: "false" }])).toMatchObject({ ok: false, error: 'Expected JSON $.live to equal "false", got true' });
  });
  it("still applies the keyword first", async () => {
    expect(await run([{ path: "$.status", op: "exists", value: "" }], "nope")).toMatchObject({ ok: false, error: expect.stringContaining("Keyword") });
  });
});

describe("JSON assertions on probes", () => {
  it("are only sent to probes that advertise them", async () => {
    resetProbeCapabilities();
    configureProbes({ PROBE_REGIONS: '{"test":"https://probe.example.com/"}', PROBE_SECRET: "fixture" });
    const input = { type: "http" as const, target: "https://example.com/", method: "GET", expectedStatus: 200, timeoutMs: 1000, jsonAssertions: [{ path: "$.a", op: "exists" as const, value: "" }] };
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ capabilities: ["http-request-body-v1"] }));
    vi.stubGlobal("fetch", fetch);
    try {
      expect(await runInRegion("test", input)).toEqual({ region: "test", unreachable: "Probe upgrade required for JSON assertions" });
      expect(fetch).toHaveBeenCalledTimes(1);
      fetch.mockImplementation(async (_url, init) => {
        if (init?.method !== "POST") return Response.json({ capabilities: ["json-assert-v1"] });
        expect(JSON.parse(init.body as string).jsonAssertions).toEqual(input.jsonAssertions);
        return Response.json({ ok: true });
      });
      expect(await runInRegion("test", input)).toMatchObject({ outcome: { ok: true } });
    } finally { vi.unstubAllGlobals(); configureProbes({}); resetProbeCapabilities(); }
  });
});

describe("typed JSON assertions", () => {
  const typed = (path: string, op: "equals" | "not_equals" | "contains", value: string, type: "any" | "string" | "number" | "boolean", body = doc) =>
    jsonAssertionProblem(body, [{ path, op, value, type }]);
  const strs = JSON.stringify({ code: "200", flag: "true", n: 200, b: true, list: [1, "1"] });
  it("keeps the loose match without a type, so 200 also matches the text \"200\"", () => {
    expect(typed("$.code", "equals", "200", "any", strs)).toBeNull();
    expect(typed("$.n", "equals", "200", "any", strs)).toBeNull();
    expect(typed("$.flag", "equals", "true", "any", strs)).toBeNull();
  });
  it("tells text, numbers and booleans apart when a type is chosen", () => {
    expect(typed("$.code", "equals", "200", "number", strs)).toBe('Expected JSON $.code to equal number "200", got "200"');
    expect(typed("$.n", "equals", "200", "string", strs)).toMatch(/to equal string/);
    expect(typed("$.code", "equals", "200", "string", strs)).toBeNull();
    expect(typed("$.n", "equals", "200", "number", strs)).toBeNull();
    expect(typed("$.flag", "equals", "true", "boolean", strs)).toMatch(/to equal boolean/);
    expect(typed("$.b", "equals", "true", "boolean", strs)).toBeNull();
    expect(typed("$.b", "equals", "true", "string", strs)).toMatch(/to equal string/);
  });
  it("applies to not_equals and to the items of a list", () => {
    expect(typed("$.code", "not_equals", "200", "number", strs)).toBeNull();
    expect(typed("$.n", "not_equals", "200", "number", strs)).toMatch(/not to equal/);
    expect(typed("$.list", "contains", "1", "number", strs)).toBeNull();
    expect(typed("$.list", "contains", "2", "number", strs)).toMatch(/to contain/);
    expect(typed("$.code", "contains", "20", "number", strs)).toMatch(/to contain/);
  });
  it("accepts the new fields in the schema and rejects a bad status list", () => {
    expect(jsonAssertionsSchema.safeParse([{ path: "$.a", op: "equals", value: "1", type: "number", status: "2xx" }]).success).toBe(true);
    expect(jsonAssertionsSchema.safeParse([{ path: "$.a", op: "equals", value: "1", type: "date" }]).success).toBe(false);
    expect(jsonAssertionsSchema.safeParse([{ path: "$.a", op: "exists", status: "ok" }]).success).toBe(false);
    expect(jsonAssertionsSchema.parse([{ path: "$.a", op: "exists", status: "  " }])[0]!.status).toBeUndefined();
  });
});

describe("JSON assertions limited to a status", () => {
  const list = [{ path: "$.a", op: "exists" as const, value: "" }, { path: "$.b", op: "exists" as const, value: "", status: "2xx" }, { path: "$.c", op: "exists" as const, value: "", status: "429,!200" }];
  it("keeps the assertions that apply to the response status", () => {
    expect(assertionsForStatus(list, 200).map((a) => a.path)).toEqual(["$.a", "$.b"]);
    expect(assertionsForStatus(list, 429).map((a) => a.path)).toEqual(["$.a", "$.c"]);
    expect(assertionsForStatus(list, 503).map((a) => a.path)).toEqual(["$.a"]);
  });
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/limited") { res.statusCode = 429; res.end(JSON.stringify({ error: "slow down" })); } else res.end(doc);
  });
  let base = "";
  beforeAll(async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => { server.close(); configureNetGuard({}); });
  const run = (path: string, jsonAssertions: Parameters<typeof jsonAssertionProblem>[1]) =>
    runCheck({ type: "http", target: base + path, method: "GET", expectedStatus: 200, acceptedStatuses: "200,429", timeoutMs: 3000, jsonAssertions });
  it("passes a 429 that lacks the field when the assertion is for 2xx, and still checks the 200", async () => {
    const onlyOk = [{ path: "$.status", op: "equals" as const, value: "ok", status: "2xx" }];
    expect(await run("limited", onlyOk)).toMatchObject({ ok: true, statusCode: 429 });
    expect(await run("", onlyOk)).toMatchObject({ ok: true, statusCode: 200 });
    expect(await run("", [{ path: "$.status", op: "equals" as const, value: "down", status: "2xx" }])).toMatchObject({ ok: false });
  });
  it("without a status, the assertion still applies to the 429", async () => {
    expect(await run("limited", [{ path: "$.status", op: "equals" as const, value: "ok" }])).toMatchObject({ ok: false, error: expect.stringContaining("$.status") });
  });
  it("can assert on the 429 body itself", async () => {
    expect(await run("limited", [{ path: "$.error", op: "exists" as const, value: "", status: "429" }])).toMatchObject({ ok: true, statusCode: 429 });
  });
});

describe("new assertion fields on probes", () => {
  it("need a probe that advertises json-assert-v2", async () => {
    resetProbeCapabilities();
    configureProbes({ PROBE_REGIONS: '{"test":"https://probe.example.com/"}', PROBE_SECRET: "fixture" });
    const input = { type: "http" as const, target: "https://example.com/", method: "GET", expectedStatus: 200, timeoutMs: 1000, jsonAssertions: [{ path: "$.a", op: "exists" as const, value: "", status: "2xx" }] };
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ capabilities: ["json-assert-v1"] }));
    vi.stubGlobal("fetch", fetch);
    try {
      expect(await runInRegion("test", input)).toEqual({ region: "test", unreachable: "Probe upgrade required for typed JSON assertions and assertions limited to a status" });
      fetch.mockImplementation(async (_url, init) => init?.method !== "POST" ? Response.json({ capabilities: ["json-assert-v1", "json-assert-v2"] }) : Response.json({ ok: true }));
      expect(await runInRegion("test", input)).toMatchObject({ outcome: { ok: true } });
    } finally { vi.unstubAllGlobals(); configureProbes({}); resetProbeCapabilities(); }
  });
});
