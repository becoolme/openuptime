---
name: openuptime
description: Manages uptime monitoring through the OpenUptime MCP server. Creates and tunes monitors (http, tcp, dns, heartbeat, postgres, mysql, redis), runs checks, handles incidents and posts status updates, and builds public status pages. Use when the user asks to monitor a site, API or service, check what is down, open or resolve an incident, pause monitors for maintenance, or set up a status page with OpenUptime.
---

# OpenUptime

Drive an OpenUptime workspace through its MCP tools (server `openuptime`, tools named `openuptime:<tool>`).

## Before acting

1. If the `openuptime` tools are not available, tell the user to connect the server and stop:
   `claude mcp add --transport http openuptime https://openuptime.app/api/mcp` (self-hosted: use your own `/api/mcp` URL). Other clients: https://openuptime.app/docs/mcp
2. If the user may have several workspaces or projects, call `openuptime:list_workspaces` once and pass `workspace` / `project` ids to every later call. Omitting them uses the default.
3. Call `openuptime:list_monitors` before creating anything, to avoid duplicates.

## Add a monitor

Call `openuptime:create_monitor` with `name`, `type` and `target` (URL, `host:port` or hostname). Omitted fields take defaults: 60 s interval, expect HTTP 200, region `auto`.

- Website or API: `type: "http"`, `target: "https://api.example.com/health"`. Add `keyword` (with `keywordMode: "contains"` or `"absent"`) when a 200 alone is not proof of health.
- WebSocket endpoint: `type: "websocket"`, `target: "wss://example.com/socket"`. The handshake alone is the check; add `wsMessage` to send a text message that must get a reply, and `keyword` to check that reply. Credentials go in `headers`, never in `wsMessage`.
- Cron job or backup: `type: "heartbeat"`; `graceSec` is how late a ping may be. Give the user the ping URL from `openuptime:get_monitor`.
- Database or cache: `postgres`, `mysql` or `redis` with a connection target the user provided. Never invent credentials.
- Alerts: attach `channelIds` from `openuptime:list_channels`. A monitor without channels does not notify anyone, so say so.
- Several regions: names come from `openuptime:list_regions`; only http, tcp and websocket monitors use them.

Verify with `openuptime:run_check` and report the real result, not an assumption.

## When something is down

1. `openuptime:list_incidents` (open ones come first), then `openuptime:get_incident` for the timeline and failed checks.
2. `openuptime:run_check` on the affected monitor. With `region` it makes a one-off request from there and records nothing, which tells a regional problem from a global one.
3. `openuptime:acknowledge_incident` when the user is taking it.
4. `openuptime:post_incident_update` with `status` `investigating`, `identified`, `monitoring` or `resolved`. Public updates (the default) notify subscribers and show on status pages, so write what is known and nothing speculative; pass `visibility` `internal` for notes only your team should see.
5. Open a manual incident with `openuptime:create_incident` (`severity` `minor` or `major`, optional `monitorId`) for problems no monitor caught. After resolving, record `rootCause` and `postmortem` with `openuptime:update_incident`; both become public once the incident is resolved.

## Planned maintenance

Pause the affected monitors with `openuptime:pause_monitor` and resume them with `openuptime:resume_monitor` afterwards. Paused monitors run no checks and send no alerts. `openuptime:list_maintenance` shows the windows already scheduled.

## Status pages

`openuptime:create_status_page` needs `slug` (3 to 40 lowercase letters, digits or hyphens, unused), `title` and `monitorIds`. The page is public at `/status/<slug>`. Show only monitors the user wants customers to see. Change it later with `openuptime:update_status_page`; `monitorIds` replaces the whole list, so send the full list.

## Rules

- Confirm before `openuptime:delete_monitor`: it removes the history for good. Offer `openuptime:pause_monitor` instead when the user only wants silence.
- Confirm before posting an incident update or resolving an incident that customers can see.
- Use `openuptime:update_monitor` with only the fields that change; other fields stay as they are, and `type` cannot be changed.
- `create_workspace` and `create_project` work only when the connection was authorized for it. If a call is refused, report that and do not retry with different scopes.
- Report what actually happened, including the error text of a failed call.
