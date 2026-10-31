import { openDatabase } from "@openuptime/db-pg";
import type { McpObservation } from "@openuptime/repo";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { checkOne } from "./scheduler";
import { deliverMcpAlertTask } from "./alerts";
import { mcpCheck } from "./mcp-monitor";
import { monitorCreateSchema } from "./routes/monitors";
vi.mock("./mcp-monitor", () => ({ mcpCheck: vi.fn() }));
vi.mock("./alerts", async (original) => ({ ...await original<typeof import("./alerts")>(), deliverMcpAlertTask: vi.fn() }));
const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "mcp-monitor-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };
const config = { requiredTools: ["lookup"], schemaCheck: true, toolCall: null };
const discovery: McpObservation = { stage: "complete", timings: { initialize: 2, "tools/list": 3 }, toolsComplete: true, tools: [{ name: "lookup", inputSchema: { type: "object", properties: { query: { type: "string" } } } }], changes: [] };

it("defaults both advanced MCP features off and requires explicit valid calls", () => {
  expect(monitorCreateSchema.parse({ name: "MCP", type: "mcp", mcpConfig: {} }).mcpConfig).toEqual({ requiredTools: [], schemaCheck: false, toolCall: null });
  expect(monitorCreateSchema.safeParse({ name: "MCP", type: "mcp", mcpConfig: { toolCall: { enabled: true } } }).success).toBe(false);
  expect(monitorCreateSchema.safeParse({ name: "MCP", type: "mcp", mcpConfig: { toolCall: { enabled: true, name: "lookup", arguments: { q: "你".repeat(6000) } } } }).success).toBe(false);
  expect(monitorCreateSchema.safeParse({ name: "MCP", type: "mcp", mcpConfig: { toolCall: { enabled: true, name: "lookup", assertions: [{ path: "/ok", operator: "equals" }] } } }).success).toBe(false);
});

describe.skipIf(!url)("MCP monitor API and existing status/incident flow", () => {
  it("validates endpoints, protects secrets and tool-call authority, exports config and scopes baseline reset", async () => {
    const db = openDatabase(url!, { max: 2 }); await db.migrate();
    const app = createApp(openDatabase);
    const call = async (cookie: string, method: string, path: string, body?: unknown) => {
      const r = await app.fetch(new Request(`${origin}/api${path}`, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never);
      return { status: r.status, body: await r.json().catch(() => null) as any, cookie: r.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") };
    };
    const signup = async () => {
      const r = await call("", "POST", "/auth/sign-up/email", { email: `mcp-${crypto.randomUUID()}@example.com`, name: "MCP", password: "correct horse battery" });
      expect(r.status).toBe(200); return { id: r.body.user.id, cookie: r.cookie };
    };
    try {
      const owner = await signup(), member = await signup(), outsider = await signup();
      const orgId = (await call(owner.cookie, "GET", "/me")).body.organization.id;
      await db.query("insert into member (id,organization_id,user_id,role,created_at) values ($1,$2,$3,'member',now())", [crypto.randomUUID(), orgId, member.id]);
      const active = await call(member.cookie, "POST", "/auth/organization/set-active", { organizationId: orgId }); member.cookie = active.cookie || member.cookie;
      const payload = { name: "MCP", type: "mcp", target: "https://1.1.1.1/mcp", headers: { Authorization: "Bearer fixture-secret" }, mcpConfig: config, failureThreshold: 1 };
      for (const target of ["not a url", "file:///etc/passwd", "https://user:secret@example.com/mcp", "https://example.com/mcp#fragment", "http://127.0.0.1/mcp"]) {
        expect((await call(owner.cookie, "POST", "/monitors", { ...payload, target })).status).toBe(400);
      }
      expect((await call(member.cookie, "POST", "/monitors", payload)).status).toBe(403);
      const created = await call(owner.cookie, "POST", "/monitors", payload); expect(created.status).toBe(201);
      const path = `/monitors/${created.body.id}`;
      expect((await call(member.cookie, "GET", path)).body).toMatchObject({ mcpConfig: null, mcpBaseline: null, mcpObservation: null, mcpConfigRedacted: true });
      for (const patch of [{ mcpConfig: config }, { target: "https://8.8.8.8/mcp" }, { headers: {} }]) expect((await call(member.cookie, "PATCH", path, patch)).status).toBe(403);
      expect((await call(member.cookie, "PATCH", path, { name: "MCP renamed" })).status).toBe(200);
      expect((await call(owner.cookie, "PATCH", path, { regions: ["us-east"] })).status).toBe(400);
      expect((await call(member.cookie, "POST", `${path}/mcp-baseline/accept`, { observationId: crypto.randomUUID(), schemaHash: "a".repeat(64) })).status).toBe(403);
      expect((await call(outsider.cookie, "POST", `${path}/mcp-baseline/accept`, { observationId: crypto.randomUUID(), schemaHash: "a".repeat(64) })).status).toBe(404);
      const exported = (await call(owner.cookie, "GET", "/monitors/export")).body.monitors.find((m: any) => m.type === "mcp");
      expect(exported.mcpConfig).toEqual(config);
      const enabled = { ...config, toolCall: { enabled: true, name: "lookup", arguments: { secret: "fixture-argument" }, assertions: [] } };
      expect((await call(owner.cookie, "POST", "/monitors/import", [{ ...exported, sourceId: "enabled-copy", mcpConfig: enabled }])).body).toMatchObject({ created: 0, skipped: [{ error: expect.stringContaining("disabled") }] });
      expect((await call(owner.cookie, "PATCH", path, { mcpConfig: enabled })).status).toBe(200);
      vi.mocked(mcpCheck).mockResolvedValue({ ok: true, mcp: discovery });
      const preview = await call(owner.cookie, "POST", "/monitors/mcp/preview", { monitorId: created.body.id, target: payload.target, headers: payload.headers, mcpConfig: enabled });
      expect(preview.status).toBe(200);
      expect(vi.mocked(mcpCheck).mock.calls.at(-1)?.[0].mcpConfig).toMatchObject({ schemaCheck: false, toolCall: null });
      expect((await db.repo.monitorDetail(created.body.id)).results).toHaveLength(0);

      expect((await call(member.cookie, "POST", `${path}/check`)).status).toBe(403);
      for (const patch of [{ intervalSec: 120 }, { timeoutMs: 20000 }, { regions: ["us-east"] }]) expect((await call(member.cookie, "PATCH", path, patch)).status).toBe(403);
      expect((await call(member.cookie, "PATCH", path, { paused: true })).status).toBe(200);
      expect((await call(member.cookie, "PATCH", path, { paused: false })).status).toBe(403);
      expect((await call(owner.cookie, "PATCH", path, { paused: false })).status).toBe(200);

      const snapshot = (await db.repo.getMonitor(orgId, created.body.id, null))!;
      await db.repo.acceptMcpObservation(snapshot, discovery, { ok: true });
      const observed = (await db.repo.getMonitor(orgId, created.body.id, null))!.mcpObservation!;
      expect((await call(owner.cookie, "POST", `${path}/mcp-baseline/accept`, { observationId: observed.id, schemaHash: observed.schemaHash })).status).toBe(200);
      expect((await call(owner.cookie, "POST", `${path}/mcp-baseline/accept`, { observationId: crypto.randomUUID(), schemaHash: observed.schemaHash })).status).toBe(409);
      expect((await call(owner.cookie, "GET", `${path}/mcp-history?days=30`)).status).toBe(200);
      expect((await call(member.cookie, "GET", `${path}/mcp-history`)).status).toBe(403);
      expect((await call(owner.cookie, "POST", `${path}/mcp-baseline/reset`)).status).toBe(409);
      expect((await call(member.cookie, "GET", path)).body.mcpConfig).toBeNull();
    } finally { await db.close(1); }
  });

  it("never hands out, copies or overwrites a rotating OAuth refresh token", async () => {
    const db = openDatabase(url!, { max: 2 }); await db.migrate();
    const app = createApp(openDatabase);
    const call = async (cookie: string, method: string, path: string, body?: unknown) => {
      const r = await app.fetch(new Request(`${origin}/api${path}`, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never);
      return { status: r.status, body: await r.json().catch(() => null) as any, cookie: r.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") };
    };
    try {
      const signed = await call("", "POST", "/auth/sign-up/email", { email: `mcp-oauth-${crypto.randomUUID()}@example.com`, name: "MCP", password: "correct horse battery" });
      const owner = signed.cookie;
      const orgId = (await call(owner, "GET", "/me")).body.organization.id;
      const oauth = { mode: "refresh_token", issuer: "https://issuer.example", clientId: "fixture-client", clientSecret: "fixture-secret", refreshToken: "fixture-r1", scopes: ["read"] };
      const created = await call(owner, "POST", "/monitors", { name: "OAuth MCP", type: "mcp", target: "https://1.1.1.1/mcp", mcpConfig: { ...config, oauth } });
      expect(created.status).toBe(201);
      const path = `/monitors/${created.body.id}`;
      expect(created.body.mcpConfig.oauth).not.toHaveProperty("refreshToken");
      expect((await call(owner, "GET", path)).body.mcpConfig.oauth).toMatchObject({ clientId: "fixture-client", clientSecret: "fixture-secret" });
      expect((await call(owner, "GET", path)).body.mcpConfig.oauth).not.toHaveProperty("refreshToken");

      // Export leaves every OAuth secret behind; importing an OAuth monitor is refused per row.
      const exported = (await call(owner, "GET", "/monitors/export")).body.monitors.find((m: any) => m.name === "OAuth MCP");
      expect(exported.mcpConfig.oauth).toEqual({ mode: "refresh_token", issuer: oauth.issuer, clientId: oauth.clientId, scopes: ["read"] });
      const imported = await call(owner, "POST", "/monitors/import", [{ ...exported, sourceId: "oauth-copy" }, { ...exported, sourceId: "oauth-copy-2", mcpConfig: { ...config, oauth } }]);
      expect(imported.body).toMatchObject({ created: 0, skipped: [{ error: expect.stringContaining("OAuth credentials are not imported") }, { error: expect.stringContaining("OAuth credentials are not imported") }] });

      // A scheduled check rotates r1 to r2; an edit form that never held the token changes only the scopes.
      const stored = (await db.repo.getMonitor(orgId, created.body.id, null))!;
      expect(await db.repo.rotateMcpRefreshToken(stored, "fixture-r1", "fixture-r2")).toBe(true);
      const { refreshToken: _r1, ...formOAuth } = oauth;
      expect((await call(owner, "PATCH", path, { mcpConfig: { ...config, oauth: { ...formOAuth, scopes: ["read", "write"] } } })).status).toBe(200);
      expect((await db.repo.getMonitor(orgId, created.body.id, null))!.mcpConfig?.oauth).toMatchObject({ refreshToken: "fixture-r2", scopes: ["read", "write"] });
      // Switching to refresh-token mode needs a token: there is none stored to keep.
      const cc = await call(owner, "POST", "/monitors", { name: "CC MCP", type: "mcp", target: "https://1.1.1.1/mcp", mcpConfig: { ...config, oauth: { ...formOAuth, mode: "client_credentials" } } });
      expect((await call(owner, "PATCH", `/monitors/${cc.body.id}`, { mcpConfig: { ...config, oauth: formOAuth } })).status).toBe(400);

      // Preview cannot persist a rotation without a saved monitor, so it refuses before contacting anyone.
      vi.mocked(mcpCheck).mockClear();
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const unsaved = await call(owner, "POST", "/monitors/mcp/preview", { target: "https://1.1.1.1/mcp", mcpConfig: { ...config, oauth } });
      expect(unsaved.status).toBe(400);
      expect(unsaved.body).toMatchObject({ code: "mcp_refresh_requires_saved_monitor" });
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
      expect(mcpCheck).not.toHaveBeenCalled();
    } finally { await db.close(1); }
  });

  it("records diagnostics, retains schema baseline, opens and resolves an incident and publishes status without config", async () => {
    const db = openDatabase(url!, { max: 2 }); await db.migrate();
    const orgId = "mcp-status-" + crypto.randomUUID();
    try {
      await db.query("insert into organization (id,name,slug,created_at) values ($1,'MCP',$1,now())", [orgId]);
      const project = await db.repo.createProject(orgId, "MCP");
      const m = await db.repo.createMonitor(orgId, project.id, monitorCreateSchema.parse({ name: "Agent tools", type: "mcp", target: "https://1.1.1.1/mcp", mcpConfig: config, failureThreshold: 1 }));
      await db.query("insert into alert_channel (organization_id, project_id, name, type, config, auto_enable) values ($1,$2,'Fixture channel','webhook',$3,true)", [orgId, project.id, JSON.stringify({ url: "https://alerts.example/fixture" })]);
      const page = await db.repo.createStatusPage(orgId, project.id, { slug: "mcp-" + crypto.randomUUID(), title: "MCP status" });
      await db.repo.setPageComponents(page.id, orgId, [{ monitorId: m.id }], [project.id]);
      vi.mocked(mcpCheck).mockResolvedValue({ ok: true, latencyMs: 5, mcp: discovery });
      await checkOne(db.repo, m);
      let current = (await db.repo.getMonitor(orgId, m.id, null))!;
      expect(current).toMatchObject({ status: "up", mcpBaseline: discovery.tools, mcpObservation: discovery });
      vi.mocked(deliverMcpAlertTask).mockImplementation(async (_repo, task) => {
        const event = task.event;
        // This separate pool connection cannot see uncommitted changes. Notifications must follow commit.
        expect((await db.repo.getMonitor(orgId, m.id, null))?.status).toBe(event.kind === "incident.opened" ? "down" : "up");
      });
      const failed = { ...discovery, stage: "schema" as const, changes: ["Tool removed: lookup"], tools: [] };
      vi.mocked(mcpCheck).mockResolvedValue({ ok: false, latencyMs: 6, error: "MCP schema: Tool removed: lookup", mcp: failed });
      await checkOne(db.repo, current);
      current = (await db.repo.getMonitor(orgId, m.id, null))!;
      expect(current).toMatchObject({ status: "down", mcpBaseline: discovery.tools, mcpObservation: failed });
      const detail = await db.repo.monitorDetail(m.id);
      expect(detail.incidents.some(i => i.status !== "resolved")).toBe(true);
      expect(deliverMcpAlertTask).toHaveBeenCalledTimes(1);
      expect(detail.results.some(r => r.error?.includes("MCP schema"))).toBe(true);
      const board = await db.repo.statusBoard(page);
      expect(board.components[0].status).toBe("down");
      expect(JSON.stringify(board)).not.toContain("inputSchema");
      vi.mocked(mcpCheck).mockResolvedValue({ ok: true, latencyMs: 4, mcp: discovery });
      await checkOne(db.repo, current);
      expect((await db.repo.getMonitor(orgId, m.id, null))?.status).toBe("up");
      expect((await db.repo.monitorDetail(m.id)).incidents.every(i => i.status === "resolved")).toBe(true);
      expect(deliverMcpAlertTask).toHaveBeenCalledTimes(2);
    } finally { vi.mocked(deliverMcpAlertTask).mockReset(); vi.mocked(mcpCheck).mockReset(); await db.query("delete from organization where id=$1", [orgId]); await db.close(1); }
  });
  it("discards an old manual success after a newer scheduled failure", async () => {
    const db = openDatabase(url!, { max: 3 }); await db.migrate();
    const orgId = "mcp-race-" + crypto.randomUUID();
    let release!: (value: Awaited<ReturnType<typeof mcpCheck>>) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    try {
      await db.query("insert into organization (id,name,slug,created_at) values ($1,'MCP',$1,now())", [orgId]);
      const project = await db.repo.createProject(orgId, "Race");
      const m = await db.repo.createMonitor(orgId, project.id, monitorCreateSchema.parse({ name: "Race", type: "mcp", target: "https://1.1.1.1/mcp", failureThreshold: 1 }));
      await db.repo.setMonitorState(m.id, { status: "up" });
      const stale = (await db.repo.getMonitor(orgId, m.id, null))!;
      vi.mocked(mcpCheck).mockImplementationOnce(() => new Promise(resolve => { release = resolve; entered(); }));
      const old = checkOne(db.repo, stale);
      await started;
      await db.query("update monitor set run_generation=run_generation+1 where id=$1", [m.id]);
      const scheduled = (await db.repo.getMonitor(orgId, m.id, null))!;
      const failed = { ...discovery, stage: "tools/list" as const, tools: [] };
      vi.mocked(mcpCheck).mockResolvedValueOnce({ ok: false, latencyMs: 3, error: "MCP tools/list: JSON-RPC error (-32603)", mcp: failed });
      await checkOne(db.repo, scheduled, undefined, true);
      release({ ok: true, latencyMs: 20, mcp: discovery });
      await old;
      expect(await db.repo.getMonitor(orgId, m.id, null)).toMatchObject({ status: "down", mcpObservation: failed });
      expect((await db.repo.monitorDetail(m.id)).results).toHaveLength(1);
    } finally {
      release?.({ ok: false, error: "test cancelled", mcp: discovery });
      vi.mocked(deliverMcpAlertTask).mockReset(); vi.mocked(mcpCheck).mockReset();
      await db.query("delete from organization where id=$1", [orgId]); await db.close(1);
    }
  });

});
