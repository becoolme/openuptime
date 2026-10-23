import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpServer, defineTool, type RestCall } from "./rpc";

const calls: RestCall[] = [];
const call = async (c: RestCall) => {
  calls.push(c);
  return c.path.endsWith("missing") ? { status: 404, text: '{"error":"Not found"}' } : { status: 200, text: '{"ok":true}' };
};

const server = createMcpServer({
  info: { name: "demo", version: "1.0.0" },
  instructions: "Demo server.",
  tools: [
    defineTool({ name: "list_things", description: "List things.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/things" }) }),
    defineTool({ name: "get_thing", description: "Get one thing.", schema: z.object({ id: z.string().uuid() }), readOnly: true, build: (a) => ({ method: "GET", path: `/things/${a.id}` }) }),
    defineTool({ name: "rename_thing", description: "Rename.", schema: z.object({ id: z.string().uuid(), name: z.string() }), build: ({ id, ...rest }) => ({ method: "PATCH", path: `/things/${id}`, body: rest }) }),
    defineTool({ name: "drop_thing", description: "Delete.", schema: z.object({ id: z.string().uuid() }), destructive: true, build: (a) => ({ method: "DELETE", path: `/things/${a.id}` }) }),
  ],
  context: {
    shape: { team: z.string().optional().describe("Team id") },
    toHeaders: ({ team }): Record<string, string> => (typeof team === "string" ? { "x-team-id": team } : {}),
  },
});
const ID = "0b9d1a3e-6a3b-4f6c-8f55-1d2c3e4f5a6b";
const rpc = (id: number, method: string, params?: unknown) => server.handle({ jsonrpc: "2.0", id, method, params }, call) as Promise<any>;

describe("mcp-rest", () => {
  it("negotiates the protocol version and reports instructions", async () => {
    const r = await rpc(1, "initialize", { protocolVersion: "2025-03-26" });
    expect(r.result.protocolVersion).toBe("2025-03-26");
    expect(r.result.serverInfo).toEqual({ name: "demo", version: "1.0.0" });
    expect(r.result.instructions).toBe("Demo server.");
    expect((await rpc(2, "initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe("2025-06-18");
  });

  it("lists every tool with a JSON schema, the context arguments and annotations", async () => {
    const r = await rpc(1, "tools/list");
    expect(r.result.tools).toHaveLength(4);
    const get = r.result.tools.find((t: any) => t.name === "get_thing");
    expect(get.inputSchema.properties.id).toBeDefined();
    expect(get.inputSchema.properties.team).toBeDefined();
    expect(get.inputSchema.$schema).toBeUndefined();
    expect(r.result.tools.find((t: any) => t.name === "drop_thing").annotations.destructiveHint).toBe(true);
    expect(get.annotations.readOnlyHint).toBe(true);
  });

  it("maps tool calls onto REST requests and carries the context as headers", async () => {
    calls.length = 0;
    await rpc(1, "tools/call", { name: "rename_thing", arguments: { id: ID, name: "x" } });
    await rpc(2, "tools/call", { name: "get_thing", arguments: { id: ID, team: "t1" } });
    expect(calls[0]).toEqual({ method: "PATCH", path: `/things/${ID}`, body: { name: "x" } });
    expect(calls[1]).toEqual({ method: "GET", path: `/things/${ID}`, headers: { "x-team-id": "t1" } });
  });

  it("reports bad arguments and REST errors as tool errors, not protocol errors", async () => {
    const bad = await rpc(1, "tools/call", { name: "get_thing", arguments: { id: "nope" } });
    expect(bad.result.isError).toBe(true);
    expect(bad.error).toBeUndefined();
    const res: any = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_things" } }, async () => ({ status: 404, text: '{"error":"Not found"}' }));
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("Not found");
  });

  it("stays silent for notifications and rejects unknown methods and tools", async () => {
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }, call)).toBeNull();
    expect((await rpc(9, "nope")).error.code).toBe(-32601);
    expect((await rpc(10, "tools/call", { name: "drop_everything" })).error.code).toBe(-32602);
    expect(((await server.handle({ id: 1 } as never, call)) as any).error.code).toBe(-32600);
  });

  it("with publicOnly, lists and runs only tools marked public, without context arguments", async () => {
    const open = createMcpServer({
      info: { name: "demo", version: "1" },
      tools: [
        defineTool({ name: "open", aliases: ["legacy_open"], description: "Open.", schema: z.object({ slug: z.string() }), readOnly: true, public: true, build: (a) => ({ method: "GET", path: `/open/${a.slug}` }) }),
        defineTool({ name: "private", aliases: ["legacy_private"], description: "Private.", schema: z.object({}), build: () => ({ method: "GET", path: "/private" }) }),
      ],
      context: { shape: { team: z.string().optional() }, toHeaders: () => ({}) },
    });
    const run = (method: string, params?: unknown, publicOnly = true) => open.handle({ jsonrpc: "2.0", id: 1, method, params }, call, { publicOnly }) as Promise<any>;
    const listed = (await run("tools/list")).result.tools;
    expect(listed.map((t: any) => t.name)).toEqual(["open"]);
    expect(Object.keys(listed[0].inputSchema.properties)).toEqual(["slug"]);
    expect((await run("tools/list", undefined, false)).result.tools.length).toBe(2);
    expect((await run("tools/call", { name: "private", arguments: {} })).error.code).toBe(-32602);
    expect((await run("tools/call", { name: "open", arguments: { slug: "a" } })).result.isError).toBeFalsy();
    expect((await run("tools/call", { name: "legacy_private", arguments: {} })).error.code).toBe(-32602);
    expect((await run("tools/call", { name: "legacy_open", arguments: { slug: "a" } })).result.isError).toBeFalsy();
    expect((await run("tools/call", { name: "legacy_open", arguments: { slug: 1 } })).result.isError).toBe(true);
  });

  it("rejects collisions between canonical names and aliases before serving tools", () => {
    const tool = defineTool({ name: "get", aliases: ["old_get"], description: "Get.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/" }) });
    expect(() => createMcpServer({ info: { name: "demo", version: "1" }, tools: [tool, { ...tool, name: "old_get", aliases: [] }] })).toThrow("Duplicate MCP tool name or alias: old_get");
  });

});
