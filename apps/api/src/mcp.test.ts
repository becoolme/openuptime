import { describe, expect, it } from "vitest";
import { handleRpc, TOOLS } from "./mcp";

const calls: { method: string; path: string; body?: unknown }[] = [];
const call = async (c: { method: string; path: string; body?: unknown }) => {
  calls.push(c);
  return c.path.endsWith("missing") ? { status: 404, text: '{"error":"Not found"}' } : { status: 200, text: '{"ok":true}' };
};
const ID = "0b9d1a3e-6a3b-4f6c-8f55-1d2c3e4f5a6b";

describe("mcp", () => {
  it("negotiates the protocol version", async () => {
    const r: any = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, call);
    expect(r.result.protocolVersion).toBe("2025-03-26");
    expect(r.result.capabilities.tools).toBeDefined();
    const fallback: any = await handleRpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, call);
    expect(fallback.result.protocolVersion).toBe("2025-06-18");
  });

  it("lists every tool with a JSON schema and annotations", async () => {
    const r: any = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, call);
    expect(r.result.tools).toHaveLength(TOOLS.length);
    const create = r.result.tools.find((t: any) => t.name === "create_monitor");
    expect(create.inputSchema.properties.target).toBeDefined();
    expect(create.inputSchema.$schema).toBeUndefined();
    expect(r.result.tools.find((t: any) => t.name === "delete_monitor").annotations.destructiveHint).toBe(true);
    expect(r.result.tools.find((t: any) => t.name === "list_monitors").annotations.readOnlyHint).toBe(true);
  });

  it("maps tool calls onto REST requests", async () => {
    calls.length = 0;
    await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pause_monitor", arguments: { id: ID } } }, call);
    await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "update_monitor", arguments: { id: ID, intervalSec: 120 } } }, call);
    await handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_monitor", arguments: { name: "api", target: "https://example.com" } } }, call);
    expect(calls[0]).toEqual({ method: "PATCH", path: `/api/monitors/${ID}`, body: { paused: true } });
    expect(calls[1]).toEqual({ method: "PATCH", path: `/api/monitors/${ID}`, body: { intervalSec: 120 } });
    expect(calls[2].body).toMatchObject({ name: "api", type: "http", intervalSec: 60 });
  });

  it("reports bad arguments and REST errors as tool errors, not protocol errors", async () => {
    const bad: any = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_monitor", arguments: { id: "nope" } } }, call);
    expect(bad.result.isError).toBe(true);
    expect(bad.error).toBeUndefined();
    const missing: any = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_monitor", arguments: { id: ID.replace("0b", "missing".slice(0, 0) + "0b") } } }, async () => ({ status: 404, text: '{"error":"Not found"}' }));
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0].text).toContain("Not found");
  });

  it("stays silent for notifications and rejects unknown methods", async () => {
    expect(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, call)).toBeNull();
    const r: any = await handleRpc({ jsonrpc: "2.0", id: 9, method: "nope" }, call);
    expect(r.error.code).toBe(-32601);
    const t: any = await handleRpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "drop_everything" } }, call);
    expect(t.error.code).toBe(-32602);
  });
});
