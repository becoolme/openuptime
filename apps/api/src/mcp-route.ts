import type { Hono } from "hono";
import { mcpResource } from "./auth";
import type { AppEnv } from "./env";
import { handleRpc } from "./mcp";

const originOf = (url: string) => new URL(url).origin;

/**
 * Remote MCP server (Streamable HTTP, stateless) and the OAuth discovery documents agents need to authorize themselves.
 * Tools run through the regular REST API with the caller's own credentials, so permissions, project scopes and
 * validation are exactly the ones that API enforces.
 */
export function mountMcp(app: Hono<AppEnv>) {
  const challenge = (origin: string) =>
    `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp", scope="mcp:read mcp:write"`;

  app.on("POST", "/api/mcp", async (c) => {
    const origin = originOf(c.req.url);
    const unauthorized = () =>
      c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, 401, { "www-authenticate": challenge(origin) });

    // credentials are forwarded as-is; a browser page from another site cannot ride on the session cookie
    const headers = new Headers();
    for (const h of ["authorization", "x-api-key", "x-project-id", "x-workspace-id", "cookie"]) {
      const v = c.req.header(h);
      if (v) headers.set(h, v);
    }
    const foreign = c.req.header("origin");
    if (foreign && foreign !== c.env.WEB_ORIGIN && foreign !== origin) headers.delete("cookie");
    if (!headers.has("authorization") && !headers.has("x-api-key") && !headers.has("cookie")) return unauthorized();

    const raw = (await c.req.json().catch(() => undefined)) as unknown;
    if (raw === undefined) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);

    let executionCtx: Parameters<typeof app.fetch>[2];
    try {
      executionCtx = c.executionCtx as typeof executionCtx;
    } catch {}
    let rejected = false;
    const call = async (r: { method: string; path: string; body?: unknown; headers?: Record<string, string> }) => {
      const h = new Headers(headers);
      for (const [k, v] of Object.entries(r.headers ?? {})) h.set(k, v);
      if (r.body !== undefined) h.set("content-type", "application/json");
      const res = await app.fetch(
        new Request(`${origin}${r.path}`, { method: r.method, headers: h, body: r.body === undefined ? undefined : JSON.stringify(r.body) }),
        c.env,
        executionCtx,
      );
      if (res.status === 401) rejected = true;
      return { status: res.status, text: await res.text() };
    };

    const items = Array.isArray(raw) ? raw : [raw];
    // bad or expired credentials: tell the client with a real 401 so it can (re)start the authorization flow
    const needsAuth = items.some((m) => (m as { method?: string } | null)?.method !== "ping" && !String((m as { method?: string } | null)?.method ?? "").startsWith("notifications/"));
    if (needsAuth) {
      const probe = await call({ method: "GET", path: "/api/me" });
      if (rejected) return unauthorized();
      if (probe.status === 403) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32003, message: probe.text } }, 403);
    }
    const out = (await Promise.all(items.map((m) => handleRpc(m as never, call)))).filter((r) => r !== null);
    if (out.length === 0) return c.body(null, 202);
    return c.json(Array.isArray(raw) ? out : out[0]);
  });
  // no server-initiated stream: this server only answers requests
  app.on(["GET", "DELETE"], "/api/mcp", (c) => c.body(null, 405, { allow: "POST" }));

  // OAuth 2.0 Protected Resource Metadata (RFC 9728), both the path-inserted and the plain form
  const resourceMeta = (c: { env: AppEnv["Bindings"]; json: (b: unknown) => Response }) =>
    c.json({
      resource: mcpResource(c.env),
      authorization_servers: [`${originOf(c.env.BETTER_AUTH_URL)}/api/auth`],
      scopes_supported: ["mcp:read", "mcp:write"],
      bearer_methods_supported: ["header"],
      resource_name: "OpenUptime",
    });
  app.get("/.well-known/oauth-protected-resource", resourceMeta);
  app.get("/.well-known/oauth-protected-resource/api/mcp", resourceMeta);

  // Authorization server metadata at the root, where clients look for an issuer with a path (RFC 8414 §3)
  const asMeta = async (c: { get: (k: "auth") => AppEnv["Variables"]["auth"] }) => {
    const res = await (c.get("auth").api as unknown as { getOAuthServerConfig: (o: { asResponse: true }) => Promise<Response> }).getOAuthServerConfig({ asResponse: true });
    return res;
  };
  for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/api/auth", "/.well-known/openid-configuration", "/.well-known/openid-configuration/api/auth"]) {
    app.get(p, async (c) => {
      const res = await asMeta(c);
      return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } });
    });
  }
}
