import { createMcpServer, defineTool, type Tool } from "@openuptime/mcp-rest";
import { z } from "zod";
import { monitorCreateSchema, monitorPatchSchema } from "./routes/monitors";

/**
 * Model Context Protocol server (Streamable HTTP, stateless, JSON responses) at POST /api/mcp; the protocol and the
 * transport live in @openuptime/mcp-rest, this file is the OpenUptime tool list.
 * Every tool is a thin call into the REST API with the caller's own credentials, so API-key scopes,
 * project limits, validation and alerting behave exactly as they do for any other client.
 */

const id = z.string().uuid().describe("Resource id (uuid)");

/** Every tool can say where it acts, for an agent that was given several workspaces or projects. */
const whereShape = {
  workspace: z.string().min(1).max(64).optional().describe("Workspace id (from list_workspaces). Omit to use the default one."),
  project: z.string().uuid().optional().describe("Project id (from list_workspaces). Omit to use the default project of the workspace."),
};

const updateVisibility = z.enum(["public", "internal"]);
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
  { name: "get_incident", description: "Get an incident (number, root cause, postmortem) with its update timeline, internal updates included, and the failed checks around it.", schema: z.object({ id }), readOnly: true, build: (a) => ({ method: "GET", path: `/api/incidents/${a.id}` }) },
  {
    name: "create_incident",
    description: "Open a manual incident, optionally tied to a monitor. Appears on status pages that include that monitor; without a monitor it appears on the status pages of the project.",
    schema: z.object({ title: z.string().min(1).max(200), body: z.string().max(4000).optional(), severity: z.enum(["minor", "major"]).default("major"), monitorId: z.string().uuid().optional(), visibility: updateVisibility.optional() }),
    build: (a) => ({ method: "POST", path: "/api/incidents", body: a }),
  },
  {
    name: "update_incident",
    description: "Set or clear an incident's root cause (short, up to 500 characters) and postmortem (up to 20000, markdown). They stay private until you set publishPostmortem to true; then they appear on the public status page once the incident is resolved (false takes them back). An empty string clears a field.",
    schema: z.object({ id, rootCause: z.string().max(500).nullable().optional(), postmortem: z.string().max(20000).nullable().optional(), publishPostmortem: z.boolean().optional() }),
    build: ({ id, ...rest }) => ({ method: "PATCH", path: `/api/incidents/${id}`, body: rest }),
  },
  {
    name: "post_incident_update",
    description: "Post a status update on an incident. status resolved closes it and must be public. A public update (the default) shows on status pages and is emailed to subscribers; an internal one is visible to the team only.",
    schema: z.object({ id, status: incidentStatus, body: z.string().min(1).max(4000), visibility: updateVisibility.optional() }),
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

/**
 * Read-only tools for public status pages, served without credentials at /api/mcp/public (and also listed here, on the
 * authenticated endpoint, so a signed-in agent can read any published page too). They take the page's slug instead of a
 * workspace or project, and `via=mcp` lets the owner of a page switch this access off.
 */
const slug = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/i).describe("The status page's slug: the last part of its address, /status/<slug>");
const publicPath = (s: string, rest = "") => `/api/public/status/${encodeURIComponent(s)}${rest}`;

export const PUBLIC_TOOLS: Tool[] = [
  defineTool({
    name: "status_page_overview",
    description: "Current state of a public status page: overall status, each component with its status and 90-day uptime, and active incidents. No credentials needed.",
    schema: z.object({ slug }),
    readOnly: true,
    public: true,
    build: (a) => ({ method: "GET", path: publicPath(a.slug) + "?via=mcp" }),
  }),
  defineTool({
    name: "status_page_incidents",
    description: "Recent incidents of a public status page with their updates, newest first. No credentials needed.",
    schema: z.object({ slug }),
    readOnly: true,
    public: true,
    build: (a) => ({ method: "GET", path: publicPath(a.slug, "/incidents") + "?via=mcp" }),
  }),
  defineTool({
    name: "status_page_maintenance",
    description: "Scheduled and ongoing maintenance windows of a public status page. No credentials needed.",
    schema: z.object({ slug }),
    readOnly: true,
    public: true,
    build: (a) => ({ method: "GET", path: publicPath(a.slug, "/maintenance") + "?via=mcp" }),
  }),
];

export const SERVER_INFO = { name: "openuptime", version: "1.0.0" };

export const server = createMcpServer({
  info: SERVER_INFO,
  instructions:
    "Manage OpenUptime monitors, incidents and status pages. Ids are uuids returned by the list_* tools. Call list_workspaces to see which workspaces and projects you may use; every tool takes optional `workspace` and `project` ids.",
  tools: [...TOOLS, ...PUBLIC_TOOLS],
  context: {
    shape: whereShape,
    toHeaders: ({ workspace, project }): Record<string, string> => ({
      ...(typeof workspace === "string" ? { "x-workspace-id": workspace } : {}),
      ...(typeof project === "string" ? { "x-project-id": project } : {}),
    }),
  },
});
