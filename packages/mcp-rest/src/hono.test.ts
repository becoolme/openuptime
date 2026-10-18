import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mountMcp, mountOAuthMetadata } from "./hono";
import { createMcpServer, defineTool } from "./rpc";

const server = createMcpServer({
  info: { name: "demo", version: "1" },
  tools: [
    defineTool({ name: "open_info", description: "Public.", schema: z.object({ slug: z.string() }), readOnly: true, public: true, build: (a) => ({ method: "GET", path: `/api/open/${a.slug}` }) }),
    defineTool({ name: "whoami", description: "Who am I.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/me" }) }),
  ],
});

const app = new Hono();
app.get("/api/me", (c) => {
  if (c.req.header("authorization") !== "Bearer good") return c.json({ error: "no" }, 401);
  return c.json({ user: "u1", cookie: c.req.header("cookie") ?? null });
});
app.get("/api/open/:slug", (c) => c.json({ slug: c.req.param("slug"), auth: c.req.header("authorization") ?? null, cookie: c.req.header("cookie") ?? null }));
mountMcp(app, { server, path: "/api/mcp/public", anonymous: true });
mountMcp(app, { server, path: "/api/mcp", scopes: ["mcp:read"], probePath: "/api/me", cookieOrigins: () => ["https://app.example"] });
mountOAuthMetadata(app, { resource: () => "https://api.example/api/mcp", authorizationServers: () => ["https://api.example/api/auth"], scopes: ["mcp:read"], mcpPath: "/api/mcp" });

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.request("https://api.example/api/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const callWhoami = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami" } };

describe("mountMcp", () => {
  it("answers 401 with a discovery challenge when there are no credentials", async () => {
    const res = await post(callWhoami);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://api.example/.well-known/oauth-protected-resource/api/mcp", scope="mcp:read"');
  });

  it("answers 401 for credentials the API rejects", async () => {
    expect((await post(callWhoami, { authorization: "Bearer bad" })).status).toBe(401);
  });

  it("runs tools with the caller's credentials", async () => {
    const res = await post(callWhoami, { authorization: "Bearer good" });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(JSON.parse(body.result.content[0].text).user).toBe("u1");
  });

  it("does not forward the cookie from a foreign origin, but does from a trusted one", async () => {
    const send = async (origin: string) => {
      const res = await post(callWhoami, { authorization: "Bearer good", cookie: "s=1", origin });
      return JSON.parse(((await res.json()) as any).result.content[0].text).cookie;
    };
    expect(await send("https://evil.example")).toBeNull();
    expect(await send("https://app.example")).toBe("s=1");
  });

  it("skips the credential probe for pings and answers notifications with 202; handles batches", async () => {
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { authorization: "Bearer bad" })).status).toBe(202);
    const res = await post([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }], { authorization: "Bearer good" });
    expect(((await res.json()) as unknown[]).length).toBe(2);
  });

  it("rejects malformed JSON and GET", async () => {
    const bad = await app.request("https://api.example/api/mcp", { method: "POST", headers: { authorization: "Bearer good" }, body: "{" });
    expect(bad.status).toBe(400);
    expect((await app.request("https://api.example/api/mcp")).status).toBe(405);
  });

  it("serves the protected resource metadata", async () => {
    const meta: any = await (await app.request("https://api.example/.well-known/oauth-protected-resource/api/mcp")).json();
    expect(meta).toMatchObject({ resource: "https://api.example/api/mcp", authorization_servers: ["https://api.example/api/auth"], scopes_supported: ["mcp:read"] });
  });

  describe("anonymous endpoint", () => {
    const anon = (body: unknown, headers: Record<string, string> = {}) =>
      app.request("https://api.example/api/mcp/public", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

    it("works without credentials and lists only public tools", async () => {
      const res = await anon({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).result.tools.map((t: any) => t.name)).toEqual(["open_info"]);
    });

    it("runs public tools and never forwards the caller's credentials", async () => {
      const res = await anon({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "open_info", arguments: { slug: "acme" } } }, { authorization: "Bearer good", cookie: "s=1" });
      expect(JSON.parse(((await res.json()) as any).result.content[0].text)).toEqual({ slug: "acme", auth: null, cookie: null });
    });

    it("treats tools that are not public as unknown", async () => {
      const res = await anon({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami" } }, { authorization: "Bearer good" });
      expect(((await res.json()) as any).error.code).toBe(-32602);
    });

    it("leaves the authenticated endpoint demanding credentials and listing everything", async () => {
      expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
      const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "Bearer good" });
      expect(((await res.json()) as any).result.tools.length).toBe(2);
    });
  });
});
