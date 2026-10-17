import { z } from "zod";

/** A REST request a tool turns into. The host decides how to perform it (usually an in-process `app.fetch`). */
export type RestCall = { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown; headers?: Record<string, string> };
export type RestResult = { status: number; text: string };
export type CallRest = (call: RestCall) => Promise<RestResult>;

export type Tool<S extends z.ZodObject = z.ZodObject> = {
  name: string;
  description: string;
  schema: S;
  /** Does not change anything. */
  readOnly?: boolean;
  /** Removes data. */
  destructive?: boolean;
  /** Turns validated arguments into the REST request. */
  build: (args: z.infer<S>) => RestCall;
};

/** Typed helper so `build` sees the arguments of its own schema; the result fits in a `Tool[]`. */
export const defineTool = <S extends z.ZodObject>(tool: Tool<S>): Tool => tool as unknown as Tool;

/**
 * Arguments every tool accepts in addition to its own, for example which workspace or project to act in.
 * `toHeaders` turns the validated values into headers of the REST request.
 */
export type ContextArgs = {
  shape: z.ZodRawShape;
  toHeaders: (values: Record<string, unknown>) => Record<string, string>;
};

export type McpServerOptions = {
  info: { name: string; version: string };
  /** Free text shown to the model when it connects. */
  instructions?: string;
  tools: Tool[];
  context?: ContextArgs;
  /** Protocol versions to accept, newest first. */
  protocolVersions?: string[];
};

export type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

export const DEFAULT_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const fail = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Builds a stateless MCP server: `handle` answers one JSON-RPC message, and returns null for notifications. */
export function createMcpServer(options: McpServerOptions) {
  const { info, instructions, tools, context } = options;
  const versions = options.protocolVersions ?? DEFAULT_PROTOCOL_VERSIONS;
  const withContext = (t: Tool) => (context ? t.schema.extend(context.shape) : t.schema);

  const manifest = tools.map((t) => {
    const { $schema, ...inputSchema } = z.toJSONSchema(withContext(t), { io: "input" }) as Record<string, unknown>;
    return {
      name: t.name,
      description: t.description,
      inputSchema,
      annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, idempotentHint: !!t.readOnly, openWorldHint: false },
    };
  });

  async function handle(msg: Rpc, call: CallRest) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(msg?.id, -32600, "Invalid request");
    const isNotification = msg.id === undefined;
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        return ok(msg.id, {
          protocolVersion: versions.includes(asked) ? asked : versions[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: info,
          ...(instructions ? { instructions } : {}),
        });
      }
      case "ping":
        return ok(msg.id, {});
      case "tools/list":
        return ok(msg.id, { tools: manifest });
      case "tools/call": {
        const tool = tools.find((t) => t.name === msg.params?.name);
        if (!tool) return fail(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
        const parsed = withContext(tool).safeParse(msg.params?.arguments ?? {});
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ");
          return ok(msg.id, { isError: true, content: [{ type: "text", text: `Invalid arguments — ${issues}` }] });
        }
        const values = parsed.data as Record<string, unknown>;
        const ctx: Record<string, unknown> = {};
        for (const key of Object.keys(context?.shape ?? {})) {
          ctx[key] = values[key];
          delete values[key];
        }
        const built = tool.build(values);
        const headers = context?.toHeaders(ctx) ?? {};
        const res = await call(Object.keys(headers).length ? { ...built, headers: { ...built.headers, ...headers } } : built);
        const failed = res.status >= 400;
        let text = res.text || (failed ? `HTTP ${res.status}` : "OK");
        try {
          text = JSON.stringify(JSON.parse(res.text), null, 2);
        } catch {}
        return ok(msg.id, { isError: failed, content: [{ type: "text", text }] });
      }
      default:
        return isNotification ? null : fail(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  return { info, tools, manifest, handle };
}

export type McpServer = ReturnType<typeof createMcpServer>;
