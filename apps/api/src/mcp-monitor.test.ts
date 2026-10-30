import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpConfig, McpToolSchema } from "@openuptime/repo";
import { guardedFetch } from "./netguard";
import { mcpAssertionPasses, mcpCheck, mcpSchemaChanges, mcpSchemaDrift, mcpSchemaShape, MCP_MAX_PAGES, MCP_MAX_RESPONSE_BYTES, MCP_MAX_RESUMES } from "./mcp-monitor";

vi.mock("./netguard", () => ({ guardedFetch: vi.fn(), checkUserAgent: () => "OpenUptime test", targetIsPrivate: vi.fn(async () => false) }));
vi.mock("./selfcheck", async original => ({ ...await original<typeof import("./selfcheck")>(), proberOnline: vi.fn(async () => true) }));
const input = { target: "https://mcp.example/mcp", timeoutMs: 1000 };
const tool = (name = "lookup", schema: Record<string, unknown> = { type: "object", properties: { name: { type: "string" } } }): McpToolSchema => ({ name, inputSchema: schema });
const init = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
const config = (patch: Partial<McpConfig> = {}): McpConfig => ({ requiredTools: [], schemaCheck: false, toolCall: null, ...patch });
type Request = { jsonrpc: string; id?: number; method: string; params?: Record<string, unknown> };
function rpc(req: Request, result: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { headers: { "content-type": "application/json", ...headers } });
}
function serve(handler: (request: Request, options: RequestInit) => Response | Promise<Response> = req => rpc(req, { tools: [tool()] }), session = false) {
  vi.mocked(guardedFetch).mockImplementation(async (url, options = {}) => {
    if (options.method === "DELETE") return { res: new Response(null, { status: 204 }), url };
    const request = JSON.parse(String(options.body)) as Request;
    if (request.method === "server/discover") return { res: new Response(null, { status: 400 }), url };
    const res = request.method === "initialize" ? rpc(request, init, session ? { "mcp-session-id": "session-secret" } : {}) : request.method === "notifications/initialized" ? new Response(null, { status: 202 }) : await handler(request, options);
    return { res, url };
  });
}
function requests(includeDiscovery = false) { return vi.mocked(guardedFetch).mock.calls.filter(([, o]) => o?.body).map(([, o]) => JSON.parse(String(o!.body)) as Request).filter(request => includeDiscovery || request.method !== "server/discover"); }
beforeEach(() => serve());
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

describe("MCP Streamable HTTP monitor", () => {
  it("initializes, acknowledges, discovers all pages and never calls tools by default", async () => {
    serve(req => rpc(req, req.params?.cursor ? { tools: [tool("second")] } : { tools: [tool()], nextCursor: "page-2" }), true);
    const result = await mcpCheck({ ...input, headers: { Authorization: "Bearer key", "Content-Length": "1", "Mcp-Session-Id": "untrusted-session" }, mcpConfig: config({ requiredTools: ["second"] }) });
    expect(result).toMatchObject({ ok: true, mcp: { stage: "complete", tools: [tool(), tool("second")], changes: [] } });
    expect(Object.keys(result.mcp.timings)).toEqual(["server/discover", "initialize", "initialized", "tools/list", "required-tools"]);
    expect(requests().map(r => r.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list"]);
    expect(requests()[0].params?.protocolVersion).toBe("2025-11-25");
    expect(requests()[1]).not.toHaveProperty("id");
    const calls = vi.mocked(guardedFetch).mock.calls;
    expect(calls.every(([, , options]) => options?.follow === false)).toBe(true);
    const first = new Headers(calls[1][1]!.headers), next = new Headers(calls[2][1]!.headers);
    expect(first.get("authorization")).toBe("Bearer key");
    expect(first.has("content-length")).toBe(false);
    expect(first.has("mcp-session-id")).toBe(false);
    expect(first.has("mcp-protocol-version")).toBe(false);
    expect(next.get("mcp-session-id")).toBe("session-secret");
    expect(next.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(calls.at(-1)?.[1]?.method).toBe("DELETE");
    expect(JSON.stringify(result)).not.toContain("session-secret");
  });

  it("accepts streamed messages split across chunks and stops after its response without waiting for EOF", async () => {
    const cancelled = vi.fn();
    serve(req => new Response(new ReadableStream({ start(c) {
      const source = `: ping\r\n\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\r\n\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools: [tool("查询")] } })}\r\n\r\n`;
      const bytes = new TextEncoder().encode(source);
      for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
    }, cancel: cancelled }), { headers: { "content-type": "text/event-stream; charset=utf-8" } }));
    const result = await mcpCheck(input);
    expect(result.ok).toBe(true);
    expect(result.mcp.tools[0].name).toBe("查询");
    expect(cancelled).toHaveBeenCalled();
  });

  it.each([
    { jsonrpc: "2.0", id: 999, result: { tools: [] } },
    { jsonrpc: "1.0", id: 3, result: { tools: [] } },
    { jsonrpc: "2.0", id: 3, result: { tools: [] }, error: { code: -1, message: "secret" } },
    { jsonrpc: "2.0", id: 3, result: null },
    [{ jsonrpc: "2.0", id: 3, result: { tools: [] } }],
  ])("rejects invalid JSON-RPC envelopes (%j)", async envelope => {
    serve(() => new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json" } }));
    expect(await mcpCheck(input)).toMatchObject({ ok: false, mcp: { stage: "tools/list" }, error: expect.stringContaining("JSON-RPC") });
  });

  it("reports JSON-RPC error code and stage without persisting server messages or data", async () => {
    serve(req => new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "token=secret", data: "private-result" } }), { headers: { "content-type": "application/json" } }));
    const result = await mcpCheck(input);
    expect(result).toMatchObject({ ok: false, error: "MCP tools/list: JSON-RPC error (-32601)" });
    expect(JSON.stringify(result)).not.toMatch(/secret|private-result/);
  });

  it("rejects unsupported protocol and missing tool capability before discovery", async () => {
    vi.mocked(guardedFetch).mockImplementation(async (url, options) => ({ url, res: JSON.parse(String(options?.body)).method === "server/discover" ? new Response(null, { status: 400 }) : rpc(JSON.parse(String(options?.body)), { ...init, protocolVersion: "2099-01-01" }) }));
    expect(await mcpCheck(input)).toMatchObject({ ok: false, mcp: { stage: "initialize" }, error: expect.stringContaining("Unsupported") });
    expect(requests()).toHaveLength(1);
    vi.mocked(guardedFetch).mockImplementation(async (url, options) => ({ url, res: JSON.parse(String(options?.body)).method === "server/discover" ? new Response(null, { status: 400 }) : JSON.parse(String(options?.body)).method === "notifications/initialized" ? new Response(null, { status: 202 }) : rpc(JSON.parse(String(options?.body)), { ...init, capabilities: {} }) }));
    expect(await mcpCheck(input)).toMatchObject({ ok: false, error: expect.stringContaining("tools capability") });
  });

  it.each([301, 302, 307, 401, 429, 500])("fails HTTP %s without following redirects or disclosing bodies", async status => {
    serve(() => new Response("credential=secret", { status, headers: { location: "https://other.example" } }));
    const result = await mcpCheck(input);
    expect(result).toMatchObject({ ok: false, statusCode: status, error: expect.stringContaining(`HTTP ${status}`) });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(requests()).toHaveLength(3);
  });

  it("does not mark initialized until the server accepts the notification", async () => {
    const normal = vi.mocked(guardedFetch).getMockImplementation()!;
    vi.mocked(guardedFetch).mockImplementation((url, options, guard) => {
      const request = JSON.parse(String(options?.body));
      return request.method === "notifications/initialized" ? Promise.resolve({ url, res: new Response(null, { status: 200 }) }) : normal(url, options, guard);
    });
    expect(await mcpCheck(input)).toMatchObject({ ok: false, mcp: { stage: "initialized" } });
    expect(requests()).toHaveLength(2);
  });

  it("rejects repeated pagination cursors without saving a partial tool baseline", async () => {
    let page = 0;
    serve(req => rpc(req, { tools: [tool(`tool${page++}`)], nextCursor: "same" }));
    expect(await mcpCheck(input)).toMatchObject({ ok: false, mcp: { stage: "tools/list", tools: [] }, error: expect.stringContaining("cursor") });
    expect(page).toBe(2);
  });

  it("bounds pagination even for empty pages with fresh cursors", async () => {
    let page = 0;
    serve(req => rpc(req, { tools: [], nextCursor: String(++page) }));
    expect(await mcpCheck(input)).toMatchObject({ ok: false, error: expect.stringContaining("page limit") });
    expect(page).toBe(MCP_MAX_PAGES);
  });

  it("rejects duplicate tool names across pages", async () => {
    serve(req => rpc(req, { tools: [tool()], ...(req.params?.cursor ? {} : { nextCursor: "next" }) }));
    expect(await mcpCheck(input)).toMatchObject({ ok: false, error: expect.stringContaining("Duplicate") });
  });

  it("reports required tools after complete discovery", async () => {
    const result = await mcpCheck({ ...input, mcpConfig: config({ requiredTools: ["missing"] }) });
    expect(result).toMatchObject({ ok: false, mcp: { stage: "required-tools", tools: [tool()] }, error: expect.stringContaining("missing") });
  });

  it("retains a required tool deletion in drift history even though required-tools fails first", async () => {
    expect(await mcpCheck({ ...input, mcpBaseline: [tool(), tool("missing")], mcpConfig: config({ requiredTools: ["missing"], schemaCheck: true, driftPolicy: "record" }) })).toMatchObject({ ok: false, mcp: { stage: "required-tools", toolsComplete: true, changes: ["missing: tool removed"], drift: [{ severity: "breaking", kind: "tool-removed" }] } });
  });

  it.each(["application/json", "text/event-stream"])("bounds %s response bytes", async mime => {
    serve(() => new Response("x".repeat(MCP_MAX_RESPONSE_BYTES + 1), { headers: { "content-type": mime } }));
    expect(await mcpCheck(input)).toMatchObject({ ok: false, error: expect.stringContaining("size limit") });
  });

  it("enforces a single deadline even when the SSE server never closes its response", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    serve(() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": waiting\n\n")); }, cancel: cancelled }), { headers: { "content-type": "text/event-stream" } }));
    const pending = mcpCheck({ ...input, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(51);
    expect(await pending).toMatchObject({ ok: false, mcp: { stage: "tools/list" }, error: expect.stringContaining("timed out") });
    expect(cancelled).toHaveBeenCalled();
  });

  it("resumes a primed tools/call stream with GET and honors retry without ever reposting the tool", async () => {
    vi.useFakeTimers();
    let callId: number | undefined;
    serve(req => {
      if (req.method !== "tools/call") return rpc(req, { tools: [tool()] });
      callId = req.id;
      return new Response("id: opaque-event-1\nretry: 50\ndata:\n\n", { headers: { "content-type": "text/event-stream" } });
    }, true);
    const normal = vi.mocked(guardedFetch).getMockImplementation()!;
    vi.mocked(guardedFetch).mockImplementation((url, options, guard) => options?.method === "GET"
      ? Promise.resolve({ url, res: new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: callId, result: { content: [], isError: false } })}\n\n`, { headers: { "content-type": "text/event-stream" } }) })
      : normal(url, options, guard));
    const pending = mcpCheck({ ...input, mcpConfig: config({ toolCall: { enabled: true, name: "lookup", arguments: {}, assertions: [] } }) });
    await vi.advanceTimersByTimeAsync(49);
    expect(vi.mocked(guardedFetch).mock.calls.some(([, o]) => o?.method === "GET")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ ok: true });
    const get = vi.mocked(guardedFetch).mock.calls.find(([, o]) => o?.method === "GET")!;
    const h = new Headers(get[1]!.headers);
    expect(h.get("last-event-id")).toBe("opaque-event-1");
    expect(h.get("accept")).toBe("text/event-stream");
    expect(h.get("mcp-session-id")).toBe("session-secret");
    expect(h.get("mcp-protocol-version")).toBe(init.protocolVersion);
    expect(get[1]?.body).toBeUndefined();
    expect(get[2]?.follow).toBe(false);
    expect(requests().filter(r => r.method === "tools/call")).toHaveLength(1);
  });

  it("caps GET resumes and keeps the original tools/list request single", async () => {
    const sse = () => new Response("id: next\nretry: 0\ndata:\n\n", { headers: { "content-type": "text/event-stream" } });
    serve(() => sse());
    const normal = vi.mocked(guardedFetch).getMockImplementation()!;
    vi.mocked(guardedFetch).mockImplementation((url, options, guard) => options?.method === "GET" ? Promise.resolve({ url, res: sse() }) : normal(url, options, guard));
    expect(await mcpCheck(input)).toMatchObject({ ok: false, error: expect.stringContaining("resume limit") });
    expect(vi.mocked(guardedFetch).mock.calls.filter(([, o]) => o?.method === "GET")).toHaveLength(MCP_MAX_RESUMES);
    expect(requests().filter(r => r.method === "tools/list")).toHaveLength(1);
  });

  it("answers server pings without invoking any server-requested tool", async () => {
    serve(req => new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: "server-ping", method: "ping" })}\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools: [tool()] } })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    const normal = vi.mocked(guardedFetch).getMockImplementation()!;
    vi.mocked(guardedFetch).mockImplementation((url, options, guard) => {
      const message = JSON.parse(String(options?.body));
      return message.id === "server-ping" && message.result ? Promise.resolve({ url, res: new Response(null, { status: 202 }) }) : normal(url, options, guard);
    });
    expect(await mcpCheck(input)).toMatchObject({ ok: true });
    expect(requests()).toContainEqual({ jsonrpc: "2.0", id: "server-ping", result: {} });
  });

  it("resumes an interrupted stream only after receiving its resumable event ID", async () => {
    serve(() => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("id: event-1\nretry: 0\ndata:\n\n")); },
      pull(c) { c.error(Object.assign(new Error("socket disconnected"), { code: "ECONNRESET" })); },
    }), { headers: { "content-type": "text/event-stream" } }));
    const normal = vi.mocked(guardedFetch).getMockImplementation()!;
    vi.mocked(guardedFetch).mockImplementation((url, options, guard) => options?.method === "GET" ? Promise.resolve({ url, res: new Response('data: {"jsonrpc":"2.0","id":3,"result":{"tools":[]}}\n\n', { headers: { "content-type": "text/event-stream" } }) }) : normal(url, options, guard));
    expect(await mcpCheck(input)).toMatchObject({ ok: true });
    expect(requests().filter(r => r.method === "tools/list")).toHaveLength(1);
  });

  it("bounds server retry delays by the total deadline and rejects oversized event IDs", async () => {
    vi.useFakeTimers();
    serve(() => new Response("id: next\nretry: 999999999999999999999\ndata:\n\n", { headers: { "content-type": "text/event-stream" } }));
    const pending = mcpCheck({ ...input, timeoutMs: 30 });
    await vi.advanceTimersByTimeAsync(31);
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
    expect(vi.getTimerCount()).toBe(0);
    serve(() => new Response(`id: ${"x".repeat(4097)}\ndata:\n\n`, { headers: { "content-type": "text/event-stream" } }));
    expect(await mcpCheck(input)).toMatchObject({ ok: false, error: expect.stringContaining("event ID") });
  });

  it("does not call a tool merely because its name and arguments are configured", async () => {
    const result = await mcpCheck({ ...input, mcpConfig: config({ toolCall: { enabled: false, name: "lookup", arguments: { secret: "token" }, assertions: [] } }) });
    expect(result.ok).toBe(true);
    expect(requests().some(r => r.method === "tools/call")).toBe(false);
  });

  it("calls the explicitly enabled tool once and checks structured/text assertions without storing result content", async () => {
    serve(req => rpc(req, req.method === "tools/call" ? { content: [{ type: "text", text: "sensitive healthy" }], structuredContent: { count: 2 }, isError: false } : { tools: [tool()] }));
    const result = await mcpCheck({ ...input, mcpConfig: config({ toolCall: { enabled: true, name: "lookup", arguments: { token: "secret" }, assertions: [{ path: "/content/0/text", operator: "contains", value: "healthy" }, { path: "/structuredContent/count", operator: "equals", value: 2 }] } }) });
    expect(result).toMatchObject({ ok: true, mcp: { stage: "complete" } });
    expect(requests().filter(r => r.method === "tools/call")).toEqual([expect.objectContaining({ params: { name: "lookup", arguments: { token: "secret" } } })]);
    expect(JSON.stringify(result)).not.toMatch(/sensitive|secret/);
  });

  it.each([true, "false"])("fails tool isError=%j without retrying the potentially mutating call", async isError => {
    serve(req => rpc(req, req.method === "tools/call" ? { content: [{ type: "text", text: "private failure" }], isError } : { tools: [tool()] }));
    const result = await mcpCheck({ ...input, mcpConfig: config({ toolCall: { enabled: true, name: "lookup", arguments: {}, assertions: [] } }) });
    expect(result).toMatchObject({ ok: false, mcp: { stage: "tools/call" } });
    expect(requests().filter(r => r.method === "tools/call")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private failure");
  });

  it.each([
    { type: "text" }, { type: "text", text: 42 }, { type: "does-not-exist" },
    { type: "image", data: 123, mimeType: false }, { type: "audio", data: "" },
    { type: "resource_link", uri: "https://example.com" }, { type: "resource_link", name: "report", uri: 42 },
    { type: "resource", resource: { uri: "file:///report" } }, { type: "resource", resource: { uri: "file:///report", blob: 12 } },
  ])("rejects malformed tool content %j even without result assertions", async content => {
    serve(req => rpc(req, req.method === "tools/call" ? { content: [content], isError: false } : { tools: [tool()] }));
    expect(await mcpCheck({ ...input, mcpConfig: config({ toolCall: { enabled: true, name: "lookup", arguments: {}, assertions: [] } }) })).toMatchObject({ ok: false, mcp: { stage: "tools/call" }, error: "MCP tools/call: Invalid tools/call result" });
    expect(requests().filter(r => r.method === "tools/call")).toHaveLength(1);
  });

  it("accepts every supported valid content kind, including both embedded resource representations", async () => {
    const content = [
      { type: "text", text: "" }, { type: "image", data: "AA==", mimeType: "image/png" },
      { type: "audio", data: "AA==", mimeType: "audio/wav" },
      { type: "resource_link", name: "report", uri: "https://example.com/report" },
      { type: "resource", resource: { uri: "file:///report", text: "text report" } },
      { type: "resource", resource: { uri: "file:///binary", blob: "AA==", mimeType: "application/octet-stream" } },
    ];
    serve(req => rpc(req, req.method === "tools/call" ? { content } : { tools: [tool()] }));
    expect(await mcpCheck({ ...input, mcpConfig: config({ toolCall: { enabled: true, name: "lookup", arguments: {}, assertions: [] } }) })).toMatchObject({ ok: true });
  });

  it("reports assertion failure without disclosing its expected or actual value", async () => {
    serve(req => rpc(req, req.method === "tools/call" ? { content: [], structuredContent: { ok: "actual-secret" } } : { tools: [tool()] }));
    const result = await mcpCheck({ ...input, mcpConfig: config({ toolCall: { enabled: true, name: "lookup", arguments: {}, assertions: [{ path: "/structuredContent/ok", operator: "equals", value: "expected-secret" }] } }) });
    expect(result).toMatchObject({ ok: false, mcp: { stage: "assertions" }, error: "MCP assertions: Tool result assertion 1 failed" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("fails a breaking baseline before invoking an incompatible tool and remains failed against the same baseline", async () => {
    const baseline = [tool("removed")];
    const args = { ...input, mcpBaseline: baseline, mcpConfig: config({ schemaCheck: true, toolCall: { enabled: true, name: "lookup", arguments: {}, assertions: [] } }) };
    for (let i = 0; i < 2; i++) expect(await mcpCheck(args)).toMatchObject({ ok: false, mcp: { stage: "schema", changes: ["removed: tool removed"] } });
    expect(requests().some(r => r.method === "tools/call")).toBe(false);
    expect(await mcpCheck({ ...args, mcpConfig: config({ schemaCheck: false }) })).toMatchObject({ ok: true });
  });
});

describe("MCP result assertions and schema baselines", () => {
  it("uses JSON Pointer, escaped keys, deep equality and own properties only", () => {
    const result = { "a/b": { "~key": [1, { a: true, b: false }] }, nil: null };
    expect(mcpAssertionPasses(result, { path: "/a~1b/~0key/1", operator: "equals", value: { b: false, a: true } })).toBe(true);
    expect(mcpAssertionPasses(result, { path: "/a~1b/~0key", operator: "contains", value: 1 })).toBe(true);
    expect(mcpAssertionPasses(result, { path: "/nil", operator: "exists" })).toBe(true);
    for (const path of ["/toString", "/a~2b", "$.nil", "/absent", "/a~1b/~0key/length", "/a~1b/~0key/01"]) expect(mcpAssertionPasses(result, { path, operator: "exists" })).toBe(false);
  });

  it("detects deletion, nested required additions and input type changes but tolerates additions and ordering", () => {
    const before = [tool("removed"), tool("lookup", { type: "object", properties: { nested: { type: "object", required: ["a"], properties: { a: { type: ["string", "null"] }, b: { type: "string" } } } } })];
    const after = [tool("new"), tool("lookup", { type: "object", properties: { nested: { type: "object", required: ["b", "a"], properties: { a: { type: ["null", "string"] }, b: { type: "number" } } } } })];
    expect(mcpSchemaChanges(before, after)).toEqual(["removed: tool removed", "lookup/nested/b: required parameter added", "lookup/nested/b: type changed"]);
    expect(mcpSchemaChanges([tool()], [tool(), tool("added")])).toEqual([]);
    expect(mcpSchemaChanges([tool("lookup", { type: "object", properties: { a: { type: "string" } } })], [tool("lookup", { type: "object", properties: { a: { type: ["string"] } } })])).toEqual([]);
  });

  it("retains schema descriptions for drift checks while omitting default arguments and examples", () => {
    expect(mcpSchemaShape({ type: "object", description: "tool contract", properties: { key: { type: "string", default: "secret", examples: ["secret"] } } })).toEqual({ type: "object", description: "tool contract", properties: { key: { type: "string" } } });
  });

  it.each(["anyOf", "oneOf", "allOf"])("ignores %s branch reordering without hiding actual branch type changes", keyword => {
    const before = [tool("lookup", { type: "object", properties: { arg: { [keyword]: [{ type: "string" }, { type: "number" }] } } })];
    const after = [tool("lookup", { type: "object", properties: { arg: { [keyword]: [{ type: "number" }, { type: "string" }] } } })];
    expect(mcpSchemaChanges(before, after)).toEqual([]);
    expect(mcpSchemaChanges(before, [tool("lookup", { type: "object", properties: { arg: { [keyword]: [{ type: "number" }, { type: "boolean" }] } } })])).not.toEqual([]);
  });

  it("preserves positional prefixItems order", () => {
    const before = [tool("lookup", { type: "object", properties: { arg: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] } } })];
    const after = [tool("lookup", { type: "object", properties: { arg: { type: "array", prefixItems: [{ type: "number" }, { type: "string" }] } } })];
    expect(mcpSchemaChanges(before, after)).toHaveLength(2);
  });

  it("treats omitted/true/empty additionalProperties as equivalent and only flags new restrictions", () => {
    for (const additionalProperties of [true, {}]) {
      expect(mcpSchemaChanges([tool()], [tool("lookup", { ...tool().inputSchema, additionalProperties })])).toEqual([]);
      expect(mcpSchemaChanges([tool("lookup", { ...tool().inputSchema, additionalProperties })], [tool()])).toEqual([]);
    }
    expect(mcpSchemaChanges([tool("lookup", { type: "object", additionalProperties: false })], [tool("lookup", { type: "object", additionalProperties: true })])).toEqual([]);
    expect(mcpSchemaChanges([tool()], [tool("lookup", { ...tool().inputSchema, additionalProperties: false })])).toEqual(["lookup/additionalProperties: schema type changed"]);
  });

  it("retains conditional requirements and detects additions while ignoring reorder/removal", () => {
    const before = { type: "object", properties: { card: { type: "string" }, billing: { type: "string" }, zip: { type: "string" } } };
    const after = { ...before, dependentRequired: { card: ["billing", "zip"] } };
    const saved = [tool("pay", mcpSchemaShape(after))];
    expect(saved[0].inputSchema.dependentRequired).toEqual({ card: ["billing", "zip"] });
    expect(mcpSchemaChanges([tool("pay", mcpSchemaShape(before))], saved)).toEqual([
      "pay/billing: required parameter added when card is present",
      "pay/zip: required parameter added when card is present",
    ]);
    expect(mcpSchemaChanges(saved, [tool("pay", mcpSchemaShape({ ...before, dependentRequired: { card: ["zip", "billing"] } }))])).toEqual([]);
    expect(mcpSchemaChanges(saved, [tool("pay", before)])).toEqual([]);
    expect(() => mcpSchemaShape({ ...before, dependentRequired: { card: [1] } })).toThrow(/Invalid/);
  });

  it("bounds all schema JSON, rejects malformed types/references and notices removed definitions", () => {
    let nested: unknown = {};
    for (let i = 0; i < 40; i++) nested = { child: nested };
    for (const value of [{ type: "object", enum: [nested] }, { type: "object", $ref: nested }]) expect(() => mcpSchemaShape(value)).toThrow(/complexity/);
    for (const value of [{ type: "bogus" }, { $ref: {} }, { required: [1] }, { enum: {} }]) expect(() => mcpSchemaShape(value)).toThrow(/Invalid/);
    expect(mcpSchemaChanges([tool("lookup", { type: "object", $defs: { arg: { type: "string" } } })], [tool()])).toContain("lookup/arg: schema definition removed");
  });
});
