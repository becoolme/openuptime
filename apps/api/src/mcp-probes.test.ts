import type { Monitor, McpObservation } from "@openuptime/repo";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureProbes, measure, runInRegion, usesOnlyPrivateProbes } from "./probes";
import { runCheck } from "./checker";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyProbe } from "./probe-protocol";
vi.mock("./checker", () => ({ runCheck: vi.fn() }));
const observation: McpObservation = { stage: "complete", toolsComplete: true, timings: { "tools/list": 5 }, tools: [{ name: "lookup", inputSchema: { type: "object", properties: { q: { type: "string" } } } }], changes: [] };
const m: Monitor = { id: "m", organizationId: "fixture", projectId: null, name: "Regional MCP",
  intervalSec: 60, failureThreshold: 3, status: "up", consecutiveFailures: 0, lastCheckedAt: null, nextCheckAt: new Date(), paused: false,
  heartbeatToken: null, keyword: null, keywordMode: "contains", expectedLocation: null, headers: {}, wsMessage: null, graceSec: 0, channelIds: [], tags: [],
  slowThresholdMs: 1500, slowAlertAfter: 0, consecutiveSlow: 0, dependsOnMonitorId: null, createdAt: new Date(), type: "mcp", target: "http://10.0.0.1/mcp", method: "GET", expectedStatus: 200, timeoutMs: 1000, regions: ["private-a", "private-b"], minRegionsFailing: 0, mcpConfig: { requiredTools: [], schemaCheck: true, toolCall: null }, mcpBaseline: null };
function configure() { configureProbes({ PROBE_SECRET: "fixture-secret", PROBE_REGIONS: JSON.stringify({ "private-a": { url: "https://probe.example/a", private: true }, "private-b": { url: "https://probe.example/b", private: true }, public: "https://probe.example/public" }) }); }
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); configureProbes({}); });
describe("MCP regional checks", () => {
  it("allows private targets only with exclusively configured private MCP probes", () => {
    configure();
    expect(usesOnlyPrivateProbes("mcp", m.regions)).toBe(true);
    for (const ids of [[], ["auto"], ["private-a", "public"], ["missing"]]) expect(usesOnlyPrivateProbes("mcp", ids)).toBe(false);
    expect(usesOnlyPrivateProbes("http", m.regions)).toBe(false);
  });
  it("requires a current capability advertisement before sending a possibly mutating tool call", async () => {
    configure(); const fetcher = vi.fn(async () => Response.json({ capabilities: [] })); vi.stubGlobal("fetch", fetcher);
    expect(await runInRegion("private-a", m)).toMatchObject({ unreachable: expect.stringContaining("upgrade") });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("signs MCP config, retains phase diagnostics and establishes a consistent multi-region schema", async () => {
    configure(); let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json({ capabilities: ["mcp-monitor-v2"] });
      posts++;
      const headers = new Headers(init.headers), body = String(init.body);
      expect(await verifyProbe("fixture-secret", { timestamp: headers.get(TIMESTAMP_HEADER), signature: headers.get(SIGNATURE_HEADER), body })).toBe(true);
      expect(JSON.parse(body)).toMatchObject({ type: "mcp", mcpConfig: m.mcpConfig, mcpBaseline: null });
      const tools = posts === 1 ? observation.tools : [{ inputSchema: { properties: { q: { type: "string" } }, type: "object" }, name: "lookup" }];
      return Response.json({ ok: true, latencyMs: 20, mcp: { ...observation, tools } });
    }));
    const result = await measure(m);
    expect(result.out).toMatchObject({ ok: true, mcp: { toolsComplete: true, stage: "complete" } });
    expect(result.out.mcp?.regions).toHaveLength(2); expect(posts).toBe(2);
    expect(runCheck).not.toHaveBeenCalled();
  });
  it("does not permit acceptance of a baseline that disagrees between regions", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => init?.method !== "POST" ? Response.json({ capabilities: ["mcp-monitor-v2"] }) : Response.json({ ok: true, mcp: { ...observation, tools: url.endsWith("/b") ? [] : observation.tools } })));
    expect((await measure(m)).out).toMatchObject({ ok: false, mcp: { stage: "schema", toolsComplete: false } });
  });
  it("retains degraded schema status even when every region is reachable", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method !== "POST" ? Response.json({ capabilities: ["mcp-monitor-v2"] }) : Response.json({ ok: true, degraded: true, mcp: { ...observation, changes: ["Tool description changed"] } })));
    expect((await measure({ ...m, mcpBaseline: observation.tools })).out).toMatchObject({ ok: true, degraded: true, mcp: { changes: ["[private-a] Tool description changed", "[private-b] Tool description changed"] } });
  });
  it("retains minority-region schema drift in history without accepting an inconsistent contract", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => init?.method !== "POST" ? Response.json({ capabilities: ["mcp-monitor-v2"] }) : Response.json(url.endsWith("/b") ? { ok: false, mcp: { ...observation, stage: "schema", tools: [], changes: ["Tool removed"], drift: [{ severity: "breaking", kind: "removed", tool: "lookup", message: "Tool removed" }] } } : { ok: true, mcp: observation })));
    const result = await measure({ ...m, mcpBaseline: observation.tools });
    expect(result.out).toMatchObject({ ok: true, mcp: { toolsComplete: false, changes: ["[private-b] Tool removed"], drift: [{ severity: "breaking", message: "[private-b] Tool removed" }] } });
  });

  it("never falls back to another location after probe failure or malformed diagnostics", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method !== "POST" ? Response.json({ capabilities: ["mcp-monitor-v2"] }) : Response.json({ ok: true, mcp: { ...observation, stage: "invented" } })));
    expect((await measure(m)).out.inconclusive).toBe(true); expect(runCheck).not.toHaveBeenCalled();
  });
});
