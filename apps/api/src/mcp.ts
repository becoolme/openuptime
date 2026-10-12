import { z } from "zod";
import { monitorCreateSchema, monitorPatchSchema } from "./routes/monitors";

/**
 * Model Context Protocol server (Streamable HTTP, stateless, JSON responses) at POST /api/mcp.
 * Every tool is a thin call into the REST API with the caller's own credentials, so API-key scopes,
 * project limits, validation and alerting behave exactly as they do for any other client.
 */

const id = z.string().uuid().describe("Resource id (uuid)");

type Call = { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; body?: unknown; headers?: Record<string, string> };
type Tool = {
  name: string;
  description: string;
  schema: z.ZodObject;
  /** Does not change anything. */
  readOnly?: boolean;
  /** Removes data. */
  destructive?: boolean;
  build: (args: any) => Call;
};

/** Every tool can say where it acts, for an agent that was given several workspaces or projects. */
const where = {
  workspace: z.string().min(1).max(64).optional().describe("Workspace id (from list_workspaces). Omit to use the default one."),
  project: z.string().uuid().optional().describe("Project id (from list_workspaces). Omit to use the default project of the workspace."),
};

const incidentStatus = z.enum(["investigating", "identified", "monitoring", "resolved"]);

export const TOOLS: Tool[] = [
  { name: "list_workspaces", description: "List the workspaces and projects this connection can use, with their ids. Pass an id as `workspace` / `project` to any other tool to act there.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/workspaces" }) },
  {
    name: "create_workspace",
    description: "Create a new workspace (with a first project) owned by the user. Only works when the user authorized access to all workspaces. Use the returned id as `workspace` in other tools.",
    schema: z.object({ name: z.string().trim().min(1).max(60) }),
    build: (a) => ({ method: "POST", path: "/api/workspaces", body: a }),
  },
  {
    name: "create_project",
    description: "Create a project in a workspace (pass `workspace`; omit for the default one). Only works where this connection has access to all projects of that workspace. The new project is usable straight away.",
    schema: z.object({ name: z.string().trim().min(1).max(60) }),
    build: (a) => ({ method: "POST", path: "/api/projects", body: a }),
  },
  { name: "list_monitors", description: "List the monitors of the current project with status, uptime and latency.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/monitors" }) },
  { name: "get_monitor", description: "Get one monitor with its recent checks and uptime.", schema: z.object({ id }), readOnly: true, build: (a) => ({ method: "GET", path: `/api/monitors/${a.id}` }) },
  {
    name: "create_monitor",
    description: "Create a monitor. type is http, tcp, dns, heartbeat, postgres, mysql or redis; target is the URL, host:port or hostname. Omitted fields take defaults (60 s interval, expect HTTP 200). regions defaults to [\"auto\"]; name other regions (see list_regions) to check http and tcp monitors from several places.",
    schema: monitorCreateSchema,
    build: (a) => ({ method: "POST", path: "/api/monitors", body: a }),
  },
  {
    name: "update_monitor",
    description: "Change fields of a monitor; only the named fields are modified. Set paused to pause or resume it.",
    schema: monitorPatchSchema.extend({ id }),
    build: ({ id, ...rest }) => ({ method: "PATCH", path: `/api/monitors/${id}`, body: rest }),
  },
  { name: "pause_monitor", description: "Pause a monitor: no checks run and no alerts are sent until it is resumed.", schema: z.object({ id }), build: (a) => ({ method: "PATCH", path: `/api/monitors/${a.id}`, body: { paused: true } }) },
  { name: "resume_monitor", description: "Resume a paused monitor.", schema: z.object({ id }), build: (a) => ({ method: "PATCH", path: `/api/monitors/${a.id}`, body: { paused: false } }) },
  {
    name: "run_check",
    description: "Run a check for a monitor right now and record the result. With `region` (an id from list_regions) it is one request from that region instead: the result is returned and nothing is recorded.",
    schema: z.object({ id, region: z.string().optional() }),
    build: ({ id, region }) => ({ method: "POST", path: `/api/monitors/${id}/check`, ...(region ? { body: { region } } : {}) }),
  },
  { name: "list_regions", description: "List the regions checks can run from on this deployment (`auto` is always there) and how many one monitor may use. Set a monitor's `regions` to use them.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/regions" }) },
  { name: "delete_monitor", description: "Permanently delete a monitor and its history.", schema: z.object({ id }), destructive: true, build: (a) => ({ method: "DELETE", path: `/api/monitors/${a.id}` }) },
  { name: "list_incidents", description: "List incidents (open ones first), automatic and manual.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/incidents" }) },
  { name: "get_incident", description: "Get an incident with its update timeline and the failed checks around it.", schema: z.object({ id }), readOnly: true, build: (a) => ({ method: "GET", path: `/api/incidents/${a.id}` }) },
  {
    name: "create_incident",
    description: "Open a manual incident, optionally tied to a monitor. Appears on status pages that include that monitor.",
    schema: z.object({ title: z.string().min(1).max(200), body: z.string().max(4000).optional(), severity: z.enum(["minor", "major"]).default("major"), monitorId: z.string().uuid().optional() }),
    build: (a) => ({ method: "POST", path: "/api/incidents", body: a }),
  },
  {
    name: "post_incident_update",
    description: "Post a status update on an incident. status resolved closes it. Subscribers and alert channels are notified.",
    schema: z.object({ id, status: incidentStatus, body: z.string().min(1).max(4000) }),
    build: ({ id, ...rest }) => ({ method: "POST", path: `/api/incidents/${id}/updates`, body: rest }),
  },
  { name: "acknowledge_incident", description: "Acknowledge an incident as the API key's owner.", schema: z.object({ id }), build: (a) => ({ method: "POST", path: `/api/incidents/${a.id}/ack` }) },
  { name: "list_status_pages", description: "List the status pages of the current project.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/status-pages" }) },
  {
    name: "create_status_page",
    description: "Create a public status page at /status/<slug> showing the given monitors (monitorIds). The slug is 3-40 lowercase letters, digits or hyphens and must be unused.",
    schema: z.object({
      slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
      title: z.string().min(1).max(120),
      monitorIds: z.array(z.string().uuid()).max(200).optional(),
      theme: z.enum(["light", "dark", "auto"]).optional(),
      showLatency: z.boolean().optional(),
      externalUrl: z.string().max(2048).optional().describe("Optional http(s) website the page header links to"),
      hideBranding: z.boolean().optional().describe("Hide OpenUptime's name and mark; the page shows the website's logo instead. Some plans do not include this."),
    }),
    build: (a) => ({ method: "POST", path: "/api/status-pages", body: a }),
  },
  {
    name: "update_status_page",
    description: "Change a status page's title, theme, latency display or the monitors it shows (monitorIds replaces the list).",
    schema: z.object({
      id,
      title: z.string().min(1).max(120).optional(),
      monitorIds: z.array(z.string().uuid()).max(200).optional(),
      theme: z.enum(["light", "dark", "auto"]).optional(),
      showLatency: z.boolean().optional(),
      externalUrl: z.string().max(2048).optional().describe("http(s) website the page header links to; empty string removes it"),
      hideBranding: z.boolean().optional().describe("Hide OpenUptime's name and mark; the page shows the website's logo instead. Some plans do not include this."),
    }),
    build: ({ id, ...rest }) => ({ method: "PATCH", path: `/api/status-pages/${id}`, body: rest }),
  },
  { name: "list_channels", description: "List alert channels (email, webhook, Slack…) with their ids, to attach to monitors.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/channels" }) },
  { name: "list_maintenance", description: "List scheduled maintenance windows.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/maintenance" }) },
];

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const SERVER_INFO = { name: "openuptime", version: "1.0.0" };

const manifest = TOOLS.map((t) => {
  const { $schema, ...inputSchema } = z.toJSONSchema(t.schema.extend(where), { io: "input" }) as Record<string, unknown>;
  return {
    name: t.name,
    description: t.description,
    inputSchema,
    annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, idempotentHint: !!t.readOnly, openWorldHint: false },
  };
});

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };
const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const fail = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Handles one JSON-RPC message; returns null for notifications (nothing to answer). `call` performs the REST request. */
export async function handleRpc(msg: Rpc, call: (c: Call) => Promise<{ status: number; text: string }>) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(msg?.id, -32600, "Invalid request");
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return ok(msg.id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "Manage OpenUptime monitors, incidents and status pages. Ids are uuids returned by the list_* tools. Call list_workspaces to see which workspaces and projects you may use; every tool takes optional `workspace` and `project` ids.",
      });
    }
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, { tools: manifest });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
      const parsed = tool.schema.extend(where).safeParse(msg.params?.arguments ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ");
        return ok(msg.id, { isError: true, content: [{ type: "text", text: `Invalid arguments — ${issues}` }] });
      }
      const { workspace, project, ...args } = parsed.data as Record<string, unknown> & { workspace?: string; project?: string };
      const built = tool.build(args);
      const headers: Record<string, string> = {};
      if (workspace) headers["x-workspace-id"] = workspace;
      if (project) headers["x-project-id"] = project;
      const res = await call(Object.keys(headers).length ? { ...built, headers } : built);
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
