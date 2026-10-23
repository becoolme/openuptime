import type { RestCall } from "@openuptime/mcp-rest";
import { describe, expect, it } from "vitest";
import { PUBLIC_TOOLS, server, TOOLS } from "./mcp";

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
    expect(r.result.tools).toHaveLength(TOOLS.length + PUBLIC_TOOLS.length);
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

  it("offers the status page tools without credentials, keyed by slug, and nothing else", async () => {
    const r: any = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, call, { publicOnly: true });
    expect(r.result.tools.map((t: any) => t.name)).toEqual(["get_public_status_page", "list_public_status_page_incidents", "list_public_status_page_maintenance"]);
    expect(r.result.tools.every((t: any) => t.annotations.readOnlyHint && Object.keys(t.inputSchema.properties).join() === "slug")).toBe(true);
    calls.length = 0;
    await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status_page_incidents", arguments: { slug: "acme" } } }, call, { publicOnly: true });
    expect(calls[0]).toEqual({ method: "GET", path: "/api/public/status/acme/incidents?via=mcp" });
    const bad: any = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "status_page_overview", arguments: { slug: "../api/me" } } }, call, { publicOnly: true });
    expect(bad.result.isError).toBe(true);
  });

  it("describes every discoverable parameter after Zod defaults and partial schemas", async () => {
    const { result } = await rpc(1, "tools/list");
    for (const tool of result.tools) {
      for (const [name, schema] of Object.entries(tool.inputSchema.properties) as [string, any][]) {
        expect(schema.description, `${tool.name}.${name}`).toBeTruthy();
      }
    }
    const update = result.tools.find((t: any) => t.name === "update_monitor");
    expect(update.inputSchema.required).toEqual(["id"]);
    expect(update.inputSchema.properties.type).toBeUndefined();
  });

  it("preserves omitted patch fields and sends explicit clearing values unchanged", async () => {
    calls.length = 0;
    await rpc(1, "tools/call", { name: "update_monitor", arguments: { id: ID, tags: [], channelIds: [], headers: {}, keyword: null, dependsOnMonitorId: null, expectedLocation: "" } });
    expect(calls[0].body).toEqual({ tags: [], channelIds: [], headers: {}, keyword: null, dependsOnMonitorId: null, expectedLocation: null });
    const invalid = await rpc(2, "tools/call", { name: "update_monitor", arguments: { id: ID, intervalSec: 1 } });
    expect(invalid.result.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("calls public tools by either name without duplicating discovery", async () => {
    for (const tool of PUBLIC_TOOLS) {
      calls.length = 0;
      for (const name of [tool.name, ...tool.aliases!]) {
        await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { slug: "acme" } } }, call, { publicOnly: true });
      }
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(calls[1]);
    }
  });

  it("distinguishes external checks, destructive deletion and repeatable presentation edits", async () => {
    const { result } = await rpc(1, "tools/list");
    const annotations = (name: string) => result.tools.find((t: any) => t.name === name).annotations;
    expect(annotations("run_check")).toMatchObject({ openWorldHint: true, readOnlyHint: false, idempotentHint: false });
    expect(annotations("delete_monitor")).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(annotations("update_status_page").idempotentHint).toBe(true);
    expect(annotations("post_incident_update").idempotentHint).toBe(false);
    expect(annotations("update_incident").idempotentHint).toBe(false); // publishing sets a new timestamp
  });

});
