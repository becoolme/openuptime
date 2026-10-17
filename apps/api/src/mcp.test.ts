import type { RestCall } from "@openuptime/mcp-rest";
import { describe, expect, it } from "vitest";
import { server, TOOLS } from "./mcp";

const calls: RestCall[] = [];
const call = async (c: RestCall) => {
  calls.push(c);
  return { status: 200, text: '{"ok":true}' };
};
const ID = "0b9d1a3e-6a3b-4f6c-8f55-1d2c3e4f5a6b";
const rpc = (id: number, method: string, params?: unknown) => server.handle({ jsonrpc: "2.0", id, method, params }, call) as Promise<any>;

describe("openuptime mcp tools", () => {
  it("lists every tool, each with the workspace and project arguments", async () => {
    const r = await rpc(1, "tools/list");
    expect(r.result.tools).toHaveLength(TOOLS.length);
    const create = r.result.tools.find((t: any) => t.name === "create_monitor");
    expect(create.inputSchema.properties.target).toBeDefined();
    expect(create.inputSchema.properties.workspace).toBeDefined();
    expect(create.inputSchema.properties.project).toBeDefined();
    expect(r.result.tools.find((t: any) => t.name === "delete_monitor").annotations.destructiveHint).toBe(true);
    expect(r.result.tools.find((t: any) => t.name === "list_monitors").annotations.readOnlyHint).toBe(true);
  });

  it("maps tool calls onto REST requests", async () => {
    calls.length = 0;
    await rpc(1, "tools/call", { name: "pause_monitor", arguments: { id: ID } });
    await rpc(2, "tools/call", { name: "update_monitor", arguments: { id: ID, intervalSec: 120 } });
    await rpc(3, "tools/call", { name: "create_monitor", arguments: { name: "api", target: "https://example.com" } });
    expect(calls[0]).toEqual({ method: "PATCH", path: `/api/monitors/${ID}`, body: { paused: true } });
    expect(calls[1]).toEqual({ method: "PATCH", path: `/api/monitors/${ID}`, body: { intervalSec: 120 } });
    expect(calls[2].body).toMatchObject({ name: "api", type: "http", intervalSec: 60 });
  });

  it("sends the workspace and project the agent names as headers", async () => {
    calls.length = 0;
    await rpc(1, "tools/call", { name: "list_monitors", arguments: { workspace: "w1", project: ID } });
    expect(calls[0].headers).toEqual({ "x-workspace-id": "w1", "x-project-id": ID });
  });
});
