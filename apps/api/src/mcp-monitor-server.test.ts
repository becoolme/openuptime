import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { configureNetGuard } from "./netguard";
import { mcpCheck, mcpSchemaChanges, mcpSchemaDrift, mcpSchemaShape, mcpToolsEqual } from "./mcp-monitor";
import type { McpConfig, McpToolSchema } from "@openuptime/repo";

type Request = { id?: number; method: string; params?: Record<string, unknown> };
const servers: Server[] = [];
const config = (patch: Partial<McpConfig> = {}): McpConfig => ({ requiredTools: [], schemaCheck: false, toolCall: null, ...patch });
const tool = (name = "lookup", schema: Record<string, unknown> = { type: "object" }): McpToolSchema => ({ name, inputSchema: schema });
const complete = (data: Record<string, unknown>) => ({ resultType: "complete", ...data });
const discover = (capabilities: Record<string, unknown> = { tools: {} }) => complete({ supportedVersions: ["2026-07-28"], capabilities });
function reply(res: ServerResponse, req: Request, result: unknown, status = 200) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: req.id, result })); }
async function server(handler: (req: IncomingMessage, res: ServerResponse, body: Request | null) => void | Promise<void>) {
  configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true", SELFCHECK_URLS: "" });
  const errors: unknown[] = [];
  const instance = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      await handler(req, res, raw ? JSON.parse(raw) as Request : null);
    } catch (error) { errors.push(error); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  servers.push(instance);
  await new Promise<void>(resolve => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  return { target: `http://127.0.0.1:${address.port}/mcp`, timeoutMs: 2000, errors };
}
afterEach(async () => {
  for (const instance of servers.splice(0)) { instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve())); }
  configureNetGuard({});
});

describe("MCP protocols over an actual HTTP fixture", () => {
  it("uses stateless 2026 discovery, per-request metadata and required header mirroring", async () => {
    const seen: string[] = [];
    const definition = tool("查询", { type: "object", properties: { address: { type: "object", properties: { city: { type: "string", "x-mcp-header": "City" } } }, marker: { type: "string", "x-mcp-header": "Marker" }, count: { type: "integer", "x-mcp-header": "Count" } } });
    const fixture = await server((req, res, message) => {
      expect(req.method).toBe("POST");
      expect(message).not.toBeNull();
      const body = message!; seen.push(body.method);
      expect(req.headers["mcp-protocol-version"]).toBe("2026-07-28");
      expect(req.headers["mcp-method"]).toBe(body.method);
      expect(req.headers["mcp-session-id"]).toBeUndefined();
      expect(body.params?._meta).toEqual({ "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "OpenUptime", version: "1.0.0" }, "io.modelcontextprotocol/clientCapabilities": {} });
      if (body.method === "server/discover") return reply(res, body, discover());
      if (body.method === "tools/list") return reply(res, body, complete({ tools: [definition] }));
      expect(body.method).toBe("tools/call");
      expect(req.headers["mcp-name"]).toBe(`=?base64?${Buffer.from("查询").toString("base64")}?=`);
      expect(req.headers["mcp-param-city"]).toBe(`=?base64?${Buffer.from("北京").toString("base64")}?=`);
      expect(req.headers["mcp-param-marker"]).toBe(`=?base64?${Buffer.from("=?base64?literal?=").toString("base64")}?=`);
      expect(req.headers["mcp-param-count"]).toBe("42");
      reply(res, body, complete({ content: [{ type: "text", text: "healthy" }] }));
    });
    const result = await mcpCheck({ ...fixture, headers: { "Mcp-Param-City": "spoof", "Mcp-Name": "spoof", "Mcp-Method": "spoof", "Mcp-Session-Id": "spoof" }, mcpConfig: config({ toolCall: { enabled: true, name: "查询", arguments: { address: { city: "北京" }, marker: "=?base64?literal?=", count: 42 }, assertions: [] } }) });
    expect(fixture.errors).toEqual([]);
    expect(result).toMatchObject({ ok: true, mcp: { protocolVersion: "2026-07-28", transport: "streamable-http", stage: "complete", toolsComplete: true } });
    expect(seen).toEqual(["server/discover", "tools/list", "tools/call"]);
  });

  it("paginates optional prompts and resources without reading or invoking either", async () => {
    const seen: string[] = [];
    const fixture = await server((_req, res, body) => {
      seen.push(body!.method);
      if (body!.method === "server/discover") return reply(res, body!, discover({ tools: {}, prompts: {}, resources: {} }));
      if (body!.method === "tools/list") return reply(res, body!, complete({ tools: [] }));
      const cursor = body!.params?.cursor;
      if (body!.method === "prompts/list") return reply(res, body!, complete({ prompts: [{ name: cursor ? "second" : "first" }], ...(cursor ? {} : { nextCursor: "p2" }) }));
      expect(body!.method).toBe("resources/list");
      reply(res, body!, complete({ resources: [{ name: cursor ? "second" : "first", uri: cursor ? "file:///second" : "file:///first" }], ...(cursor ? {} : { nextCursor: "r2" }) }));
    });
    const result = await mcpCheck({ ...fixture, mcpConfig: config({ listPrompts: true, listResources: true }) });
    expect(result).toMatchObject({ ok: true, mcp: { prompts: [{ name: "first" }, { name: "second" }], resources: [{ name: "first", uri: "file:///first" }, { name: "second", uri: "file:///second" }] } });
    expect(seen).toEqual(["server/discover", "tools/list", "prompts/list", "prompts/list", "resources/list", "resources/list"]);
    expect(fixture.errors).toEqual([]);
  });

  it("rejects repeated optional inventory cursors with a completed tool inventory preserved", async () => {
    let page = 0;
    const fixture = await server((_req, res, body) => reply(res, body!, body!.method === "server/discover" ? discover({ tools: {}, prompts: {} }) : body!.method === "tools/list" ? complete({ tools: [] }) : complete({ prompts: [{ name: `p${++page}` }], nextCursor: "same" })));
    expect(await mcpCheck({ ...fixture, mcpConfig: config({ listPrompts: true }) })).toMatchObject({ ok: false, mcp: { stage: "prompts/list", toolsComplete: true }, error: expect.stringContaining("cursor") });
    expect(page).toBe(2);
  });

  it.each([-32020, -32021, -32601])("does not downgrade a recognized modern error %s", async code => {
    const seen: string[] = [];
    const fixture = await server((_req, res, body) => { seen.push(body!.method); res.writeHead(code === -32601 ? 404 : 400, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: body!.id, error: { code, message: "private server diagnostic" } })); });
    const result = await mcpCheck(fixture);
    expect(result).toMatchObject({ ok: false, mcp: { stage: "server/discover" }, error: expect.stringContaining(String(code)) });
    expect(JSON.stringify(result)).not.toContain("private server diagnostic");
    expect(seen).toEqual(["server/discover"]);
  });

  it("negotiates an advertised legacy version without sending modern metadata to the legacy session", async () => {
    const seen: string[] = [];
    const fixture = await server((req, res, body) => {
      seen.push(body!.method);
      if (body!.method === "server/discover") { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: body!.id, error: { code: -32022, message: "Unsupported", data: { supported: ["2025-03-26"] } } })); return; }
      expect(body!.params?._meta).toBeUndefined();
      if (body!.method === "initialize") return reply(res, body!, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "legacy", version: "1" } });
      expect(req.headers["mcp-protocol-version"]).toBe("2025-03-26");
      if (body!.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
      reply(res, body!, { tools: [] });
    });
    expect(await mcpCheck(fixture)).toMatchObject({ ok: true, mcp: { protocolVersion: "2025-03-26" } });
    expect(seen).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/list"]);
    expect(fixture.errors).toEqual([]);
  });

  it("does not retry interactive modern tool results or start a forbidden GET resume", async () => {
    const seen: string[] = [];
    const fixture = await server((req, res, body) => {
      seen.push(`${req.method} ${body?.method}`);
      if (body?.method === "server/discover") return reply(res, body, discover());
      if (body?.method === "tools/list") return reply(res, body, complete({ tools: [tool()] }));
      reply(res, body!, { resultType: "input_required", inputRequests: { auth: { method: "elicitation/create", params: {} } } });
    });
    expect(await mcpCheck({ ...fixture, mcpConfig: config({ toolCall: { enabled: true, name: "lookup", arguments: {}, assertions: [] } }) })).toMatchObject({ ok: false, mcp: { stage: "tools/call" }, error: expect.stringContaining("interactive input") });
    expect(seen).toEqual(["POST server/discover", "POST tools/list", "POST tools/call"]);
  });

  it("fails a truncated modern SSE response without legacy GET or session cleanup", async () => {
    const seen: string[] = [];
    const fixture = await server((req, res, body) => {
      seen.push(`${req.method} ${body?.method}`);
      if (body?.method === "server/discover") return reply(res, body, discover());
      res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "must-not-use" }); res.end("id: event\nretry: 0\ndata:\n\n");
    });
    expect(await mcpCheck(fixture)).toMatchObject({ ok: false, error: expect.stringContaining("Modern MCP stream ended") });
    expect(seen).toEqual(["POST server/discover", "POST tools/list"]);
  });

  it("filters invalid parameter header annotations while preserving usable tools", async () => {
    const invalid = tool("bad", { type: "object", properties: { amount: { type: "number", "x-mcp-header": "Amount" } } });
    const fixture = await server((_req, res, body) => reply(res, body!, body!.method === "server/discover" ? discover() : complete({ tools: [invalid, tool()] })));
    expect(await mcpCheck(fixture)).toMatchObject({ ok: true, mcp: { tools: [tool()], drift: [{ severity: "warning", kind: "invalid-header-annotation" }] } });
    expect(await mcpCheck({ ...fixture, mcpConfig: config({ requiredTools: ["bad"] }) })).toMatchObject({ ok: false, mcp: { stage: "required-tools" } });
  });

  it.each(["auto", "sse"] as const)("uses legacy HTTP+SSE with %s transport and never sends credentials to another origin", async transport => {
    let stream: ServerResponse | undefined;
    const seen: string[] = [];
    const fixture = await server((req, res, body) => {
      seen.push(`${req.method} ${req.url} ${body?.method ?? ""}`);
      expect(req.headers.authorization).toBe("Bearer fixture-token");
      if (req.method === "POST" && req.url === "/mcp") { res.writeHead(400); res.end(); return; }
      if (req.method === "GET") { stream = res; res.writeHead(200, { "content-type": "text/event-stream" }); res.write("event: endpoint\ndata: /messages?session=fixture\n\n"); return; }
      expect(req.url).toBe("/messages?session=fixture");
      res.writeHead(202); res.end();
      if (body?.method === "notifications/initialized") return;
      const result = body?.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "sse", version: "1" } } : { tools: [tool()] };
      stream!.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body!.id, result })}\n\n`);
    });
    expect(await mcpCheck({ ...fixture, headers: { Authorization: "Bearer fixture-token" }, mcpConfig: config({ transport }) })).toMatchObject({ ok: true, mcp: { transport: "sse", protocolVersion: "2024-11-05" } });
    expect(seen.filter(value => value.startsWith("GET"))).toHaveLength(1);
    if (transport === "sse") expect(seen.some(value => value.includes("server/discover"))).toBe(false);
    expect(fixture.errors).toEqual([]);
  });

  it("refuses cross-origin legacy message endpoints before sending any authentication or call", async () => {
    let posts = 0;
    const fixture = await server((req, res) => { if (req.method === "POST") posts++; res.writeHead(200, { "content-type": "text/event-stream" }); res.end("event: endpoint\ndata: https://unexpected.example/messages\n\n"); });
    expect(await mcpCheck({ ...fixture, headers: { Authorization: "Bearer secret" }, mcpConfig: config({ transport: "sse" }) })).toMatchObject({ ok: false, error: expect.stringContaining("configured origin") });
    expect(posts).toBe(0);
  });

  it.each(["down", "degraded", "record"] as const)("applies %s drift policy without hiding actual tool failures", async driftPolicy => {
    let calls = 0, toolFails = false;
    const fixture = await server((_req, res, body) => {
      if (body!.method === "server/discover") return reply(res, body!, discover());
      if (body!.method === "tools/list") return reply(res, body!, complete({ tools: [tool()] }));
      calls++; reply(res, body!, complete({ content: [], isError: toolFails }));
    });
    const args = { ...fixture, mcpBaseline: [tool(), tool("removed")], mcpConfig: config({ schemaCheck: true, driftPolicy, toolCall: { enabled: true, name: "lookup", arguments: {}, assertions: [] } }) };
    const result = await mcpCheck(args);
    expect(result.ok).toBe(driftPolicy !== "down");
    expect(Boolean(result.degraded)).toBe(driftPolicy === "degraded");
    expect(calls).toBe(driftPolicy === "down" ? 0 : 1);
    toolFails = true;
    const failed = await mcpCheck(args);
    expect(failed.ok).toBe(false);
    if (driftPolicy !== "down") expect(failed.mcp.stage).toBe("tools/call");
  });
});

describe("classified MCP schema drift", () => {
  it("compares full cross-region schemas without mistaking literal array order for schema branch order", () => {
    const a = tool("lookup", { type: "object", required: ["a", "b"], properties: { a: { anyOf: [{ type: "string" }, { type: "number" }] }, b: { enum: [{ n: 1, m: 2 }, [1, 2]] } } });
    const b = tool("lookup", { properties: { b: { enum: [[1, 2], { m: 2, n: 1 }] }, a: { anyOf: [{ type: "number" }, { type: "string" }] } }, required: ["b", "a"], type: ["object"], additionalProperties: true });
    expect(mcpToolsEqual([a, tool("second")], [tool("second"), b])).toBe(true);
    expect(mcpToolsEqual([tool("lookup", { type: "object", customKeyword: [1, 2] })], [tool("lookup", { type: "object", customKeyword: [2, 1] })])).toBe(false);
    const customBefore = [tool("lookup", mcpSchemaShape({ type: "object", customKeyword: [1, 2] }))], customAfter = [tool("lookup", mcpSchemaShape({ type: "object", customKeyword: [2, 1] }))];
    expect(mcpToolsEqual(customBefore, customAfter)).toBe(false);
    expect(mcpSchemaDrift(customBefore, customAfter)).toContainEqual(expect.objectContaining({ severity: "warning", kind: "schema-keyword" }));
    expect(mcpToolsEqual([tool("lookup", { type: "object", const: { anyOf: [1, 2] } })], [tool("lookup", { type: "object", const: { anyOf: [2, 1] } })])).toBe(false);
    expect(mcpToolsEqual([tool("lookup", { type: "object", properties: { a: { enum: [[1, 2]] } } })], [tool("lookup", { type: "object", properties: { a: { enum: [[2, 1]] } } })])).toBe(false);
    expect(mcpToolsEqual([tool("lookup", { type: "object", properties: { a: { prefixItems: [{ type: "string" }, { type: "number" }] } } })], [tool("lookup", { type: "object", properties: { a: { prefixItems: [{ type: "number" }, { type: "string" }] } } })])).toBe(false);
  });
  it("detects enum narrowing and numeric/string/array constraints while recognizing relaxations", () => {
    const before = [tool("pay", { type: "object", properties: { method: { type: "string", enum: ["card", "cash"] }, amount: { type: "number", minimum: 0 }, memo: { type: "string", maxLength: 100 }, items: { type: "array", uniqueItems: false } } })];
    const after = [tool("pay", { type: "object", properties: { method: { type: "string", enum: ["card"] }, amount: { type: "number", minimum: 1 }, memo: { type: "string", maxLength: 50 }, items: { type: "array", uniqueItems: true } } })];
    expect(mcpSchemaDrift(before, after).filter(change => change.severity === "breaking")).toHaveLength(4);
    expect(mcpSchemaChanges(after, before)).toEqual([]);
    expect(mcpSchemaChanges([tool("pay", { type: "object", enum: [{ a: 1, b: 2 }, { c: 3 }] })], [tool("pay", { type: "object", enum: [{ c: 3 }, { b: 2, a: 1 }] })])).toEqual([]);
  });

  it("tracks output guarantees in the consumer direction and descriptions separately", () => {
    const before = [{ ...tool(), outputSchema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["ok"] } } }, description: "old description", annotations: { readOnlyHint: true } }];
    const after = [{ ...tool(), outputSchema: { type: "object", required: [], properties: { status: { type: "string", enum: ["ok", "unknown"] } } }, description: "new description", annotations: { readOnlyHint: false } }];
    const drift = mcpSchemaDrift(before, after);
    expect(drift.filter(change => change.severity === "breaking").map(change => change.kind)).toEqual(["required", "enum"]);
    expect(drift).toContainEqual(expect.objectContaining({ severity: "info", kind: "description" }));
    expect(drift).toContainEqual(expect.objectContaining({ severity: "warning", kind: "annotations" }));
    expect(JSON.stringify(drift)).not.toMatch(/old description|new description/);
    expect(mcpSchemaChanges(before, [tool()])).toContain("lookup/output: output schema contract removed");
  });

  it("does not let metadata changes consume the budget ahead of a breaking change", () => {
    const before: McpToolSchema[] = Array.from({ length: 120 }, (_, i) => ({ ...tool(`t${i}`), description: "old" }));
    const after = before.map(value => ({ ...value, description: "new" }));
    before.push(tool("removed"));
    const drift = mcpSchemaDrift(before, after);
    expect(drift).toHaveLength(100);
    expect(drift[0]).toMatchObject({ severity: "breaking", kind: "tool-removed", tool: "removed" });
  });

  it("retains newly monitored contract keywords without keeping examples or default values", () => {
    expect(mcpSchemaShape({ type: "object", minProperties: 1, properties: { n: { type: "integer", multipleOf: 2, "x-mcp-header": "N", default: 4 } } })).toEqual({ type: "object", minProperties: 1, properties: { n: { type: "integer", multipleOf: 2, "x-mcp-header": "N" } } });
    expect(mcpSchemaChanges([tool()], [tool("lookup", { ...tool().inputSchema, dependentSchemas: { card: { required: ["billing"] } } })])).toContain("lookup/card/billing: required parameter added");
  });
});
