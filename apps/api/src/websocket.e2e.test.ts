import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "websocket-monitor-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };

describe.skipIf(!url)("websocket monitors through the API", () => {
  it("stores the message to send, checks the target and protects a request with stored headers", async () => {
    const db = openDatabase(url!, { max: 1 });
    await db.migrate();
    const app = createApp(openDatabase);
    const call = async (cookie: string, method: string, path: string, body?: unknown) => {
      const r = await app.fetch(new Request(`${origin}/api${path}`, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never);
      return { status: r.status, body: await r.json().catch(() => null) as any, cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
    };
    const signup = async () => {
      const r = await call("", "POST", "/auth/sign-up/email", { email: `websocket-${crypto.randomUUID()}@example.com`, name: "WebSocket", password: "correct horse battery" });
      expect(r.status).toBe(200);
      return { id: r.body.user.id, cookie: r.cookie };
    };
    try {
      const owner = await signup();
      const orgId = (await call(owner.cookie, "GET", "/me")).body.organization.id;

      const mon = await call(owner.cookie, "POST", "/monitors", { name: "Socket", type: "websocket", target: "wss://1.1.1.1/socket", wsMessage: '{"op":"ping"}', keyword: "pong" });
      expect(mon.status).toBe(201);
      expect(mon.body).toMatchObject({ type: "websocket", target: "wss://1.1.1.1/socket", wsMessage: '{"op":"ping"}', keyword: "pong" });
      const path = `/monitors/${mon.body.id}`;
      expect((await call(owner.cookie, "GET", path)).body.wsMessage).toBe('{"op":"ping"}');

      // an empty message goes back to a handshake-only check
      expect((await call(owner.cookie, "PATCH", path, { wsMessage: "" })).body.wsMessage).toBeNull();
      expect((await db.repo.getMonitor(orgId, mon.body.id, null))?.wsMessage).toBeNull();
      expect((await call(owner.cookie, "PATCH", path, { wsMessage: "x".repeat(2001) })).status).toBe(400);

      // a handshake-only monitor needs nothing but the URL
      const bare = await call(owner.cookie, "POST", "/monitors", { name: "Bare", type: "websocket", target: "ws://1.1.1.1:8080/" });
      expect(bare.status).toBe(201);
      expect(bare.body.wsMessage).toBeNull();

      expect(await call(owner.cookie, "POST", "/monitors", { name: "Wrong", type: "websocket", target: "https://1.1.1.1/socket" })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/ws:\/\/ and wss:\/\//) } });
      // private targets are refused as for http
      expect((await call(owner.cookie, "POST", "/monitors", { name: "Private", type: "websocket", target: "ws://127.0.0.1:8080/" })).status).toBe(400);

      // a member may not redirect a request that carries the owner's stored headers, the message included
      const member = await signup();
      await db.query(`insert into member (id, organization_id, user_id, role, created_at) values ($1, $2, $3, 'member', now())`, [crypto.randomUUID(), orgId, member.id]);
      const active = await call(member.cookie, "POST", "/auth/organization/set-active", { organizationId: orgId });
      member.cookie = active.cookie || member.cookie;
      const guarded = await call(owner.cookie, "POST", "/monitors", { name: "Guarded", type: "websocket", target: "wss://1.1.1.1/socket", headers: { Authorization: "Bearer fixture-only" } });
      expect(guarded.status).toBe(201);
      expect(await call(member.cookie, "PATCH", `/monitors/${guarded.body.id}`, { wsMessage: "send me the token" })).toMatchObject({ status: 403, body: { code: "protected_request_headers" } });
      expect((await call(member.cookie, "PATCH", `/monitors/${guarded.body.id}`, { name: "Renamed" })).status).toBe(200);
    } finally {
      await db.close(1);
    }
  });
});
