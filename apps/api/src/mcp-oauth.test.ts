import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpConfig, Monitor, Repo } from "@openuptime/repo";
import { guardedFetch } from "./netguard";
import { acquireMcpToken, prepareMcpOAuth, mcpRefreshPreviewChanged } from "./mcp-oauth";
vi.mock("./netguard", () => ({ guardedFetch: vi.fn() }));
const target = "https://mcp.example/mcp", issuer = "https://auth.example";
const auth: NonNullable<McpConfig["oauth"]> = { mode: "client_credentials", issuer, clientId: "test-client", clientSecret: "test-secret", scopes: ["tools:read"] };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const calls: { url: string; options: RequestInit }[] = [];
let metadata: Record<string, unknown>, resource: Record<string, unknown>, token: Record<string, unknown>;
function savedMonitor(): Monitor {
  return { id: crypto.randomUUID(), organizationId: "fixture", projectId: null, name: "OAuth",
    intervalSec: 60, failureThreshold: 3, regions: ["auto"], status: "up", consecutiveFailures: 0, lastCheckedAt: null, nextCheckAt: new Date(), paused: false,
    heartbeatToken: null, keyword: null, keywordMode: "contains", expectedLocation: null, headers: {}, wsMessage: null, graceSec: 0, channelIds: [], tags: [],
    slowThresholdMs: 1500, slowAlertAfter: 0, consecutiveSlow: 0, dependsOnMonitorId: null, minRegionsFailing: 0, createdAt: new Date(), type: "mcp", target, method: "GET", expectedStatus: 200, timeoutMs: 1000,
    mcpConfig: { requiredTools: [], schemaCheck: false, toolCall: null, oauth: { ...auth, mode: "refresh_token", refreshToken: "old-token" } } };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
beforeEach(() => {
  calls.length = 0;
  metadata = { issuer, token_endpoint: `${issuer}/token`, grant_types_supported: ["client_credentials", "refresh_token"], token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"] };
  resource = { resource: target, authorization_servers: [issuer] };
  token = { access_token: "test-access", token_type: "Bearer", expires_in: 3600 };
  vi.mocked(guardedFetch).mockImplementation(async (url, options = {}) => {
    calls.push({ url, options });
    if (url === target) return { url, res: new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"' } }) };
    if (url.includes("oauth-protected-resource")) return { url, res: json(resource) };
    if (url.includes(".well-known")) return { url, res: json(metadata) };
    return { url, res: json(token) };
  });
});
describe("MCP unattended OAuth", () => {
  it("validates discovery and exchanges client credentials only at the trusted issuer", async () => {
    expect(await acquireMcpToken(target, auth, 1000)).toMatchObject({ accessToken: "test-access" });
    const grant = calls.at(-1)!;
    expect(grant.url).toBe(`${issuer}/token`);
    expect(new Headers(grant.options.headers).get("authorization")).toBe(`Basic ${btoa("test-client:test-secret")}`);
    expect(new URLSearchParams(String(grant.options.body)).get("resource")).toBe(target);
    expect(new URLSearchParams(String(grant.options.body)).get("scope")).toBe("tools:read");
    expect(calls.slice(0,-1).every(c => !new Headers(c.options.headers).has("authorization"))).toBe(true);
  });
  it.each(["issuer", "token-endpoint", "resource", "advertised-issuer"])("refuses %s confusion before sending secrets", async kind => {
    if (kind === "issuer") metadata.issuer = "https://evil.example";
    if (kind === "token-endpoint") metadata.token_endpoint = "https://evil.example/token";
    if (kind === "resource") resource.resource = "https://other.example/mcp";
    if (kind === "advertised-issuer") resource.authorization_servers = ["https://evil.example"];
    await expect(acquireMcpToken(target, auth, 1000)).rejects.toThrow(/OAuth/);
    expect(calls.some(c => c.options.method === "POST")).toBe(false);
  });
  it("sends refresh grant and returns rotated token without exposing provider response in errors", async () => {
    token.refresh_token = "rotated-fixture";
    const refreshed = await acquireMcpToken(target, { ...auth, mode: "refresh_token", refreshToken: "previous-fixture", tokenAuthMethod: "client_secret_post" }, 1000);
    expect(refreshed.refreshToken).toBe("rotated-fixture");
    const body = new URLSearchParams(String(calls.at(-1)!.options.body));
    expect(body.get("refresh_token")).toBe("previous-fixture");
    expect(body.get("client_secret")).toBe("test-secret");
    token = { error: "invalid_grant", error_description: "credential leak" };
    await expect(acquireMcpToken(target, auth, 1000)).rejects.toThrow("invalid bearer token");
  });
  it("bounds token and metadata responses and enforces one timeout", async () => {
    metadata.padding = "x".repeat(65_537);
    await expect(acquireMcpToken(target, auth, 1000)).rejects.toThrow(/metadata mismatch/);
    vi.mocked(guardedFetch).mockImplementation(() => new Promise(() => {}));
    await expect(acquireMcpToken(target, auth, 20)).rejects.toThrow("timed out");
  });
  it("strips OAuth credentials before a probe receives the access token", async () => {
    const prepared = await prepareMcpOAuth({ type: "mcp", target, method: "GET", expectedStatus: 200, timeoutMs: 1000, headers: { authorization: "old-header" }, mcpConfig: { requiredTools: [], schemaCheck: false, toolCall: null, oauth: auth } });
    expect(prepared).toMatchObject({ input: { headers: { authorization: "Bearer test-access" }, mcpConfig: { oauth: null } } });
    expect(JSON.stringify(prepared)).not.toContain("test-secret");
  });
  it("serializes refresh and uses the newest stored token, not a stale scheduler snapshot", async () => {
    token.refresh_token = "next-token";
    const input: Monitor = { id: crypto.randomUUID(), organizationId: "fixture", projectId: null, name: "OAuth",
      intervalSec: 60, failureThreshold: 3, regions: ["auto"], status: "up", consecutiveFailures: 0, lastCheckedAt: null, nextCheckAt: new Date(), paused: false,
      heartbeatToken: null, keyword: null, keywordMode: "contains", expectedLocation: null, headers: {}, wsMessage: null, graceSec: 0, channelIds: [], tags: [],
      slowThresholdMs: 1500, slowAlertAfter: 0, consecutiveSlow: 0, dependsOnMonitorId: null, minRegionsFailing: 0, createdAt: new Date(), type: "mcp", target, method: "GET", expectedStatus: 200, timeoutMs: 1000, mcpConfig: { requiredTools: [], schemaCheck: false, toolCall: null, oauth: { ...auth, mode: "refresh_token", refreshToken: "old-token" } } };
    const current = { ...input, mcpConfig: { ...input.mcpConfig!, oauth: { ...input.mcpConfig!.oauth!, refreshToken: "current-token" } } };
    const rotate = vi.fn(async () => true);
    const tx = { rotateMcpRefreshToken: rotate } as unknown as Repo;
    const repo = { withMcpOAuth: async (_snapshot: Monitor, run: (r: Repo, m: Monitor) => Promise<unknown>) => run(tx, current) } as unknown as Repo;
    await prepareMcpOAuth(input, repo, input);
    expect(new URLSearchParams(String(calls.at(-1)!.options.body)).get("refresh_token")).toBe("current-token");
    expect(rotate).toHaveBeenCalledWith(current, "current-token", "next-token");
  });

  it.each(["target", "issuer", "resource", "clientId", "clientSecret", "refreshToken", "mode", "removed"])("refuses changed %s in a saved refresh preview before discovery or secret exchange", async field => {
    const stored = savedMonitor();
    const changed: Monitor = { ...stored, mcpConfig: { ...stored.mcpConfig!, oauth: { ...stored.mcpConfig!.oauth! } } };
    if (field === "target") changed.target = "https://new-target.example/mcp";
    else if (field === "removed") changed.mcpConfig!.oauth = null;
    else Object.assign(changed.mcpConfig!.oauth!, { [field]: field === "mode" ? "client_credentials" : "changed-fixture-value" });
    const withMcpOAuth = vi.fn();
    expect(mcpRefreshPreviewChanged(changed, stored)).toBe(true);
    expect(await prepareMcpOAuth(changed, { withMcpOAuth } as unknown as Repo, stored)).toMatchObject({ outcome: { ok: false, mcp: { stage: "oauth" }, error: expect.stringContaining("Save endpoint and OAuth changes") } });
    expect(withMcpOAuth).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("refuses an identity or audience change in the locked row while allowing token rotation", async () => {
    const input = savedMonitor();
    const current = { ...input, target: "https://other-resource.example/mcp" };
    const repo = { withMcpOAuth: async (_snapshot: Monitor, run: (r: Repo, m: Monitor) => Promise<unknown>) => run({} as Repo, current) } as unknown as Repo;
    expect(await prepareMcpOAuth(input, repo, input)).toMatchObject({ outcome: { ok: false, error: expect.stringContaining("configuration changed") } });
    expect(calls).toEqual([]);
  });

  it("subtracts database preparation time from the caller's OAuth acquisition budget", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const timer = vi.spyOn(globalThis, "setTimeout");
    const stored = savedMonitor(), input = { ...stored, timeoutMs: 500 };
    const repo = { withMcpOAuth: async (_snapshot: Monitor, run: (r: Repo, m: Monitor) => Promise<unknown>) => { now = 400; return run({} as Repo, stored); } } as unknown as Repo;
    expect(await prepareMcpOAuth(input, repo, stored)).toMatchObject({ input: { timeoutMs: 100 }, elapsedMs: 400 });
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 100);
  });

  it("makes no token request when database preparation has already consumed the deadline", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const input = savedMonitor();
    const repo = { withMcpOAuth: async (_snapshot: Monitor, run: (r: Repo, m: Monitor) => Promise<unknown>) => { now = 1001; return run({} as Repo, input); } } as unknown as Repo;
    expect(await prepareMcpOAuth(input, repo, input)).toMatchObject({ outcome: { ok: false, latencyMs: 1001, error: expect.stringContaining("timeout exhausted") } });
    expect(calls).toEqual([]);
  });

  it("counts transaction commit time and keeps a successfully persisted rotation when the check deadline expires", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    token.refresh_token = "next-token";
    const input = savedMonitor(), rotate = vi.fn(async () => true);
    const repo = { withMcpOAuth: async (_snapshot: Monitor, run: (r: Repo, m: Monitor) => Promise<unknown>) => {
      const prepared = await run({ rotateMcpRefreshToken: rotate } as unknown as Repo, input);
      now = 1001;
      return prepared;
    } } as unknown as Repo;
    expect(await prepareMcpOAuth(input, repo, input)).toMatchObject({ outcome: { ok: false, latencyMs: 1001, error: expect.stringContaining("timeout exhausted") }, refreshToken: "next-token" });
    expect(rotate).toHaveBeenCalledWith(input, "old-token", "next-token");
  });
});
