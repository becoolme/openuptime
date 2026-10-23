import { createMcpServer, defineTool, type Tool } from "@openuptime/mcp-rest";
import { z } from "zod";
import { monitorCreateSchema, monitorPatchSchema } from "./routes/monitors";

/**
 * Model Context Protocol server (Streamable HTTP, stateless, JSON responses) at POST /api/mcp; the protocol and the
 * transport live in @openuptime/mcp-rest, this file is the OpenUptime tool list.
 * Every tool is a thin call into the REST API with the caller's own credentials, so API-key scopes,
 * project limits, validation and alerting behave exactly as they do for any other client.
 */

const id = z.string().uuid().describe("Resource UUID returned by the matching list tool; not its name, incident number or status-page slug.");

/** Every tool can say where it acts, for an agent that was given several workspaces or projects. */
const whereShape = {
  workspace: z.string().min(1).max(64).optional().describe("Workspace id (from list_workspaces). Omit to use the default one."),
  project: z.string().uuid().optional().describe("Project id (from list_workspaces). Omit to use the default project of the workspace."),
};

const updateVisibility = z.enum(["public", "internal"]).describe("public publishes the update to status pages; internal keeps its text visible only to the team. Defaults to public.");
const incidentStatus = z.enum(["investigating", "identified", "monitoring", "resolved"]).describe("New incident lifecycle status; resolved closes the incident and requires public visibility.");

export const TOOLS: Tool[] = [
  { name: "list_workspaces", description: "Discover the workspace and project ids this connection may use before calling private tools. Returns accessible workspaces with their projects; it does not list other users' workspaces. Pass workspace/project ids to private tools to select a scope, or omit them to use this connection's defaults.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/workspaces" }) },
  {
    name: "create_workspace",
    description: "Create a workspace owned by the signed-in user, including its first project. Use create_project instead to organize an existing workspace. Requires an OAuth grant for all workspaces; a workspace-scoped API key cannot create one. Returns the new workspace record and id; use list_workspaces to discover its project.",
    schema: z.object({ name: z.string().trim().min(1).max(60).describe("Display name for the new workspace or project; not an existing resource id.") }),
    build: (a) => ({ method: "POST", path: "/api/workspaces", body: a }),
  },
  {
    name: "create_project",
    description: "Create a project inside the selected workspace and return its record and id. Use this to separate monitors within an existing workspace; use create_workspace for a separate team. Requires access to all projects in that workspace. The new project is immediately usable through the project argument.",
    schema: z.object({ name: z.string().trim().min(1).max(60).describe("Display name for the new workspace or project; not an existing resource id.") }),
    build: (a) => ({ method: "POST", path: "/api/projects", body: a }),
  },
  { name: "list_monitors", description: "Read monitor summaries for the selected project, including ids, current status, uptime and latency. Use this to find a monitor before changing it or to scan for outages; use get_monitor for recent check history. Secret HTTP header values are masked unless the caller may manage the workspace.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/monitors" }) },
  { name: "get_monitor", description: "Read one monitor's configuration, recent check history and uptime statistics by its UUID from list_monitors. Use this to investigate a specific monitor; list_monitors is the summary view and run_check performs a new check. Returns the monitor plus history; secret HTTP headers are masked for callers without management access.", schema: z.object({ id }), readOnly: true, build: (a) => ({ method: "GET", path: `/api/monitors/${a.id}` }) },
  {
    name: "create_monitor",
    description: "Create and start a monitor in the selected project; returns its record and UUID (heartbeat monitors include a ping token). Use list_regions and list_channels to discover optional region/channel ids. Heartbeats wait for pings; other types schedule outgoing checks. Auto-enabled alert channels are added, and failures can open incidents and notify channels. Hosted plans may reject capacity, frequency or region choices; private network targets are refused by default.",
    schema: monitorCreateSchema,
    build: (a) => ({ method: "POST", path: "/api/monitors", body: a }),
  },
  {
    name: "update_monitor",
    description: "Patch an existing monitor and return its updated record. Read get_monitor first, then send id and at least one changed field; omitted fields stay unchanged and type cannot change. Lists and headers replace their previous values, while documented nulls clear optional settings. Prefer pause_monitor/resume_monitor for a pause-only change; use this for configuration changes or a combined edit. Resuming sets status to pending; heartbeat interval/grace changes recalculate its deadline. New settings affect later checks and alerts; hosted plan limits and target restrictions still apply.",
    schema: monitorPatchSchema.extend({ id }),
    build: ({ id, ...rest }) => ({ method: "PATCH", path: `/api/monitors/${id}`, body: rest }),
  },
  { name: "pause_monitor", description: "Stop scheduled checks and alerts for one monitor, preserving its configuration and history; returns the paused monitor. Use this for a pause-only change, or update_monitor to combine a pause with configuration edits. For planned downtime that should still run checks, schedule maintenance through the app or REST API instead. Use resume_monitor to restart checking.", schema: z.object({ id }), build: (a) => ({ method: "PATCH", path: `/api/monitors/${a.id}`, body: { paused: true } }) },
  { name: "resume_monitor", description: "Restart checking a paused monitor and return its record with pending status. Use this for a resume-only change; use update_monitor for combined configuration edits. Its next check becomes due immediately and may create incidents or send alerts. Hosted active-monitor limits are checked again; existing history is retained.", schema: z.object({ id }), build: (a) => ({ method: "PATCH", path: `/api/monitors/${a.id}`, body: { paused: false } }) },
  {
    name: "run_check",
    openWorld: true,
    description: "Check a monitor immediately. Without region, records the result through the normal incident/alert workflow and returns {ok:true}; it can notify channels. With region from list_regions, returns {ok:true,region,result} for an unrecorded spot check without changing monitor history/status. Use get_monitor to read existing checks. Heartbeats have no outgoing spot check; hosted check credits apply and probe/network errors are returned.",
    schema: z.object({ id, region: z.string().optional().describe("An id returned by list_regions; omit for a normal recorded check, provide for an unrecorded spot check.") }),
    build: ({ id, region }) => ({ method: "POST", path: `/api/monitors/${id}/check`, ...(region ? { body: { region } } : {}) }),
  },
  { name: "list_regions", description: "Discover configured check locations and the maximum regions per monitor on this deployment. Use the returned ids with create_monitor/update_monitor.regions or run_check.region; do not guess ids. auto is always available. Explicit remote regions support HTTP/TCP only; hosted plans may restrict how many are used.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/regions" }) },
  { name: "delete_monitor", idempotent: true, description: "Permanently remove a monitor and its check history; returns an empty success response. Use pause_monitor instead when you may need it again. Requires workspace owner/admin access in addition to write scope. The monitor cannot be recovered through this tool; deletion does not create an incident-resolution update.", schema: z.object({ id }), destructive: true, build: (a) => ({ method: "DELETE", path: `/api/monitors/${a.id}` }) },
  { name: "list_incidents", description: "Find automatic and manually opened incidents visible in the selected project, with open incidents first. Returns incident summaries and UUIDs; use get_incident for the timeline, failed checks and investigation details. To change status or resolve an incident, use post_incident_update rather than update_incident.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/incidents" }) },
  { name: "get_incident", description: "Investigate one incident by its UUID from list_incidents. Returns its write-up, update timeline (including internal updates), related monitor/checks, assignee and notification deliveries. Use list_incidents to discover ids; use update_incident to edit the write-up and post_incident_update to change status. This is private team information, unlike list_public_status_page_incidents.", schema: z.object({ id }), readOnly: true, build: (a) => ({ method: "GET", path: `/api/incidents/${a.id}` }) },
  {
    name: "create_incident",
    description: "Open a manual incident in the selected project and return its record and UUID. Use this for an event not already represented by an automatic incident; use post_incident_update for an existing incident. A monitorId limits it to pages containing that monitor; otherwise it applies to project status pages. The optional body becomes the first investigating update, public unless visibility is internal. Creation assigns the caller; it does not send subscriber update emails.",
    schema: z.object({ title: z.string().min(1).max(200).describe("Short incident summary shown to the team and on relevant public status pages."), body: z.string().max(4000).optional().describe("Text of the initial investigating update; omit to create the incident without an initial update."), severity: z.enum(["minor", "major"]).default("major").describe("Incident impact level; major denotes a major outage and minor a smaller disruption."), monitorId: z.string().uuid().optional().describe("Monitor UUID from list_monitors; omit for a project-wide incident."), visibility: updateVisibility.optional() }),
    build: (a) => ({ method: "POST", path: "/api/incidents", body: a }),
  },
  {
    name: "update_incident",
    description: "Edit an incident's root cause or Markdown postmortem and return the updated record. Use post_incident_update instead to change status or notify subscribers. Omitted fields stay unchanged; null or blank text clears a write-up field. Write-ups remain private unless publishPostmortem is true; a published postmortem appears on public status pages after resolution, and false hides it again.",
    schema: z.object({ id, rootCause: z.string().max(500).nullable().optional().describe("Short cause of the incident; null or blank clears it, omission preserves it."), postmortem: z.string().max(20000).nullable().optional().describe("Markdown investigation write-up; null or blank clears it, omission preserves it."), publishPostmortem: z.boolean().optional().describe("Publish the postmortem on public status pages after resolution; false hides it, omission preserves its current setting.") }),
    build: ({ id, ...rest }) => ({ method: "PATCH", path: `/api/incidents/${id}`, body: rest }),
  },
  {
    name: "post_incident_update",
    description: "Append an incident timeline update and change its status; returns the new update record. Use this to communicate progress or resolve an incident, rather than update_incident (write-up only). Public updates appear on status pages and are emailed to subscribers; internal updates remain team-only and send no subscriber email. resolved closes the incident and must be public. Repeating a call creates another update and may send another email.",
    schema: z.object({ id, status: incidentStatus, body: z.string().min(1).max(4000).describe("New timeline message; public messages are shown to visitors and emailed to subscribers."), visibility: updateVisibility.optional() }),
    build: ({ id, ...rest }) => ({ method: "POST", path: `/api/incidents/${id}/updates`, body: rest }),
  },
  { name: "acknowledge_incident", description: "Assign an existing incident to the authenticated caller and return the incident record. Use this when taking ownership of an investigation; it does not resolve the incident or post a subscriber update. Use post_incident_update to communicate status, and list_incidents to discover the incident UUID.", schema: z.object({ id }), build: (a) => ({ method: "POST", path: `/api/incidents/${a.id}/ack` }) },
  { name: "list_status_pages", description: "Read status-page records and UUIDs in the selected project for management. Use these ids with update_status_page; use get_public_status_page with a slug to read the published component/outage summary instead. This private list does not include pages outside the selected project.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/status-pages" }) },
  {
    name: "create_status_page",
    description: "Publish a status page at /status/<slug> and return its record and UUID. Use list_monitors to select components and an unused slug (a conflict returns an error); omitted monitorIds creates an empty page. The page and selected monitors' public status become readable without authentication. Use update_status_page to edit an existing page; branding options remain subject to the hosted plan.",
    schema: z.object({
      slug: z.string().regex(/^[a-z0-9-]{3,40}$/).describe("Unique public address segment in /status/<slug>, for example api-status; choose an unused slug."),
      title: z.string().min(1).max(120).describe("Heading displayed on the public status page."),
      monitorIds: z.array(z.string().uuid()).max(200).optional().describe("Ordered monitor UUIDs from list_monitors to publish as components; replaces the full list, [] clears it."),
      theme: z.enum(["light", "dark", "auto"]).optional().describe("Public page color scheme; auto follows the visitor's system preference."),
      showLatency: z.boolean().optional().describe("Whether visitors can see component response-time charts."),
      externalUrl: z.string().max(2048).optional().describe("Optional http(s) website the page header links to"),
      hideBranding: z.boolean().optional().describe("Hide OpenUptime's name and mark; the page shows the website's logo instead. Some plans do not include this."),
    }),
    build: (a) => ({ method: "POST", path: "/api/status-pages", body: a }),
  },
  {
    name: "update_status_page",
    idempotent: true,
    description: "Patch an existing status page by its UUID from list_status_pages; returns {ok:true}. Use this to edit presentation or selected components; use get_public_status_page to read the public result. Omitted fields stay unchanged; monitorIds replaces the complete component list and [] clears it. Changes affect the published page; an empty externalUrl removes its header link. Hosted branding restrictions still apply.",
    schema: z.object({
      id,
      title: z.string().min(1).max(120).describe("Heading displayed on the public status page.").optional(),
      monitorIds: z.array(z.string().uuid()).max(200).optional().describe("Ordered monitor UUIDs from list_monitors to publish as components; replaces the full list, [] clears it."),
      theme: z.enum(["light", "dark", "auto"]).optional().describe("Public page color scheme; auto follows the visitor's system preference."),
      showLatency: z.boolean().optional().describe("Whether visitors can see component response-time charts."),
      externalUrl: z.string().max(2048).optional().describe("http(s) website the page header links to; empty string removes it"),
      hideBranding: z.boolean().optional().describe("Hide OpenUptime's name and mark; the page shows the website's logo instead. Some plans do not include this."),
    }),
    build: ({ id, ...rest }) => ({ method: "PATCH", path: `/api/status-pages/${id}`, body: rest }),
  },
  { name: "list_channels", description: "Discover alert-channel UUIDs and delivery types (email, webhook, Slack and others) in the selected project. Use the ids with create_monitor/update_monitor.channelIds to route alerts. Returns channel records, not a delivery test. Channel creation and secret configuration are managed through the app or REST API.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/channels" }) },
  { name: "list_maintenance", description: "Read maintenance windows in the selected project, including schedule and monitor associations. Use this authenticated list for planning; list_public_status_page_maintenance only shows windows for a published page slug. This tool does not schedule downtime; use the app or REST API to create or remove windows.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/maintenance" }) },
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
    name: "get_public_status_page",
    aliases: ["status_page_overview"],
    description: "Read the published health summary for a status-page slug without credentials. Returns overall/component status, 90-day uptime and active public incidents; use list_public_status_page_incidents for incident history or list_public_status_page_maintenance for downtime schedules. Only published information is returned; a missing page or one with MCP access disabled returns an error.",
    schema: z.object({ slug }),
    readOnly: true,
    public: true,
    build: (a) => ({ method: "GET", path: publicPath(a.slug) + "?via=mcp" }),
  }),
  defineTool({
    name: "list_public_status_page_incidents",
    aliases: ["status_page_incidents"],
    description: "Read recent public incidents and their public updates for a published status-page slug, newest first. Use get_public_status_page for current health, or authenticated get_incident for internal investigation details. No credentials are needed; internal updates are excluded and a missing page or one with MCP access disabled returns an error.",
    schema: z.object({ slug }),
    readOnly: true,
    public: true,
    build: (a) => ({ method: "GET", path: publicPath(a.slug, "/incidents") + "?via=mcp" }),
  }),
  defineTool({
    name: "list_public_status_page_maintenance",
    aliases: ["status_page_maintenance"],
    description: "Read scheduled and ongoing public maintenance windows for a published status-page slug without credentials. Use this to explain announced downtime; authenticated list_maintenance is the project-wide management view. Returns public window records; a missing page or one with MCP access disabled returns an error.",
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
    "Manage monitor configuration, investigate incidents and publish status pages. Start with list_workspaces to discover accessible workspace/project ids, then the resource list tool for UUIDs. Private tools accept optional workspace/project selectors and use the caller's existing OAuth/API-key permissions; public-status tools use a slug and no credentials. Omitted patch fields stay unchanged; supplied lists replace prior lists. Use pause_monitor/resume_monitor for pause-only changes and post_incident_update for incident status changes or subscriber messages. Alert-channel and maintenance configuration is managed in the app or REST API; these tools expose discovery/read access to those resources.",
  tools: [...TOOLS, ...PUBLIC_TOOLS],
  context: {
    shape: whereShape,
    toHeaders: ({ workspace, project }): Record<string, string> => ({
      ...(typeof workspace === "string" ? { "x-workspace-id": workspace } : {}),
      ...(typeof project === "string" ? { "x-project-id": project } : {}),
    }),
  },
});
