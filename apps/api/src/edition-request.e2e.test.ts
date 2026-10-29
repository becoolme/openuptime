import { openDatabase } from "@openuptime/db-pg";
import type { Database, OpenDatabase } from "@openuptime/repo";
import { describe, expect, it } from "vitest";
import { HTTPException } from "hono/http-exception";
import { createApp } from "./app";
import { community, type Edition } from "./edition";
import type { RequestPrincipal } from "./env";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin, CRON_SECRET: "cron" };

function harness(extra: Partial<Edition> = {}) {
  const events: { path: string; status: number; userId?: string; orgId?: string; principal?: RequestPrincipal; database: Database; phase: "before" | "after" }[] = [];
  const closed = new Set<Database>();
  const open: OpenDatabase = (cs, options) => {
    const db = openDatabase(cs, options);
    const close = db.close.bind(db);
    db.close = async (timeout) => { closed.add(db); await close(timeout); };
    return db;
  };
  const edition: Edition = {
    ...community,
    requestMiddleware: async (c, next) => {
      const database = c.get("database");
      events.push({ path: c.req.path, status: 0, database, phase: "before", userId: c.get("userId") });
      expect(closed.has(database)).toBe(false);
      expect(c.get("auth")).toBeDefined(); expect(c.get("repo")).toBe(database.repo);
      await next();
      expect(closed.has(database)).toBe(false);
      // This query must finish before the outer middleware closes the request connection.
      expect(await database.query<{ n: number }>("select 1::int as n")).toEqual([{ n: 1 }]);
      events.push({ path: c.req.path, status: c.res.status, userId: c.get("userId"), orgId: c.get("orgId"), principal: c.get("requestPrincipal"), database, phase: "after" });
    },
    ...extra,
  };
  const app = createApp(open, { edition });
  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${origin}${path}`, init), env as never);
  async function signup() {
    await raw("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const result = await raw("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `observer-${crypto.randomUUID()}@example.com`, password: "correct horse battery", name: "Observer" }) });
    expect(result.status).toBe(200);
    return result.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
  }
  return { raw, events, closed, signup };
}

describe.skipIf(!url)("edition request middleware lifecycle", () => {
  it("wraps existing public and auth routes, and closes only after the observer finishes", async () => {
    const h = harness();
    const health = await h.raw("/health"); expect(health.status).toBe(200);
    await h.signup();
    expect(h.events.some((e) => e.path === "/api/auth/sign-up/email" && e.phase === "after" && e.status === 200)).toBe(true);
    for (const e of h.events) expect(h.closed.has(e.database)).toBe(true);
  });

  it("observes final authenticated identity for core REST operations without bypassing authorization", async () => {
    const h = harness(); const cookie = await h.signup();
    const created = await h.raw("/api/monitors", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Observed", type: "heartbeat" }) });
    expect(created.status).toBe(201);
    const writes = h.events.filter((e) => e.path === "/api/monitors");
    expect(writes[0].userId).toBeUndefined(); expect(writes[1].userId).toBeTruthy(); expect(writes[1].orgId).toBeTruthy();
    expect(writes[1].principal).toMatchObject({ kind: "session", userId: writes[1].userId, orgId: writes[1].orgId, projectScope: null, allProjects: false });
    const denied = await h.raw("/api/monitors"); expect(denied.status).toBe(401);
    expect(h.events.at(-1)).toMatchObject({ path: "/api/monitors", status: 401, userId: undefined, principal: undefined });
  });

  it("wraps nested MCP REST calls separately and keeps each connection alive until its own middleware exits", async () => {
    const h = harness(); const cookie = await h.signup(); h.events.length = 0;
    const result = await h.raw("/api/mcp", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_monitor", arguments: { name: "MCP", type: "heartbeat" } } }) });
    expect(result.status).toBe(200);
    const body = await result.json() as { result: { isError?: boolean } }; expect(body.result.isError).not.toBe(true);
    const after = h.events.filter((e) => e.phase === "after");
    expect(after.map((e) => [e.path, e.status])).toEqual([["/api/me", 200], ["/api/monitors", 201], ["/api/mcp", 200]]);
    expect(after.find((e) => e.path === "/api/monitors")?.userId).toBeTruthy();
    expect(new Set(after.map((e) => e.database)).size).toBe(3);
    expect(after.every((e) => h.closed.has(e.database))).toBe(true);
  });

  it("attributes API-key REST/MCP operations to the verified key and effective workspace/project grant", async () => {
    const h = harness(); const cookie = await h.signup();
    const me = await (await h.raw("/api/me", { headers: { cookie } })).json() as { userId: string; organization: { id: string }; projectId: string };
    const keyRes = await h.raw("/api/auth/api-key/create", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Observer key", metadata: { organizationId: me.organization.id, projectIds: [me.projectId] } }) });
    expect(keyRes.status).toBe(200);
    const key = await keyRes.json() as { id: string; key: string };
    const headers = { "x-api-key": key.key, "x-workspace-id": "untrusted-other-workspace", "x-project-id": "all" };
    expect((await h.raw("/api/me", { headers })).status).toBe(200);
    expect(h.events.at(-1)?.principal).toEqual({ kind: "api-key", credentialId: key.id, userId: me.userId, orgId: me.organization.id, projectId: me.projectId, projectScope: [me.projectId], allProjects: true });
    expect(JSON.stringify(h.events.at(-1)?.principal)).not.toContain(key.key);
    h.events.length = 0;
    const mcp = await h.raw("/api/mcp", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_monitors", arguments: {} } }) });
    expect(mcp.status).toBe(200);
    expect(h.events.find((e) => e.path === "/api/monitors" && e.phase === "after")?.principal).toMatchObject({ kind: "api-key", credentialId: key.id, orgId: me.organization.id });
    // A valid interactive session takes precedence over a supplied key, exactly as in the existing authentication flow.
    await h.raw("/api/me", { headers: { cookie, "x-api-key": key.key } });
    expect(h.events.at(-1)?.principal?.kind).toBe("session");
    await h.raw("/api/me", { headers: { "x-api-key": "ou_invalid", "x-user-id": me.userId } });
    expect(h.events.at(-1)?.principal).toBeUndefined();
  });

  it("observes the error handler's final status, including exceptions from edition routes", async () => {
    const h = harness({ mount: ({ app }) => { app.get("/extension-denied", () => { throw new HTTPException(403, { message: "No access" }); }); } });
    const response = await h.raw("/extension-denied"); expect(response.status).toBe(403);
    expect(h.events.at(-1)).toMatchObject({ path: "/extension-denied", phase: "after", status: 403 });
    expect(h.closed.has(h.events.at(-1)!.database)).toBe(true);
  });

  it("allows early rejection and still closes the request connection", async () => {
    const h = harness({ requestMiddleware: async (c) => c.json({ error: "Unavailable" }, 503) });
    expect((await h.raw("/health")).status).toBe(503); expect(h.closed.size).toBe(1);
    const thrown = harness({ requestMiddleware: async () => { throw new HTTPException(403, { message: "Refused" }); } });
    expect((await thrown.raw("/health")).status).toBe(403); expect(thrown.closed.size).toBe(1);
  });

  it("keeps CORS headers on hook refusals and answers preflight without the hook", async () => {
    const h = harness({ requestMiddleware: async () => { throw new HTTPException(403, { message: "Refused" }); } });
    const denied = await h.raw("/api/me", { headers: { origin } });
    expect(denied.status).toBe(403); expect(denied.headers.get("access-control-allow-origin")).toBe(origin);
    const early = harness({ requestMiddleware: async (c) => c.json({ error: "Unavailable" }, 503) });
    const blocked = await early.raw("/api/me", { headers: { origin } });
    expect(blocked.status).toBe(503); expect(blocked.headers.get("access-control-allow-origin")).toBe(origin);
    const preflight = await early.raw("/api/me", { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET" } });
    expect(preflight.status).toBe(204); expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
  });

  it("keeps concurrent request identity and database state separate", async () => {
    const h = harness(); const cookie = await h.signup(); h.events.length = 0;
    const [signedIn, anonymous] = await Promise.all([h.raw("/api/me", { headers: { cookie } }), h.raw("/api/me")]);
    expect(signedIn.status).toBe(200); expect(anonymous.status).toBe(401);
    const after = h.events.filter((e) => e.phase === "after"); expect(new Set(after.map((e) => e.database)).size).toBe(2);
    expect(after.find((e) => e.status === 200)?.userId).toBeTruthy(); expect(after.find((e) => e.status === 401)?.userId).toBeUndefined();
  });
});
