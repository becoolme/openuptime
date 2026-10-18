import type { Context, Hono } from "hono";
import type { McpServer, RestCall } from "./rpc";

export type MountMcpOptions = {
  server: McpServer;
  /** Where the endpoint lives, e.g. "/api/mcp". Only POST is served: this server never pushes to the client. */
  path: string;
  /** Scopes named in the 401 challenge, so a client knows what to ask for. */
  scopes?: string[];
  /** Headers that carry credentials and are forwarded as-is. At least one must be present. */
  credentialHeaders?: string[];
  /** Other headers forwarded as-is (which workspace or project to act in, …). */
  contextHeaders?: string[];
  /** Origins besides the endpoint's own that may ride on a session cookie; a page from any other site cannot. */
  cookieOrigins?: (c: Context) => string[];
  /** A cheap authenticated GET that is run before the first real call, to turn bad credentials into a real HTTP 401. */
  probePath?: string;
  /**
   * Serve without credentials. Nothing the caller sends is forwarded (no cookie, no key, no context headers) and only the
   * server's tools marked `public` are listed or callable. Use it for a second endpoint next to the authenticated one.
   */
  anonymous?: boolean;
  /** Where the protected-resource metadata is served; defaults to the RFC 9728 path-inserted form for `path`. */
  resourceMetadataPath?: string;
};

const originOf = (url: string) => new URL(url).origin;
/** Most messages one JSON-RPC batch may carry; a larger one is refused before any of it runs. */
export const MAX_BATCH = 10;
const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", id: null, error: { code, message } });

/**
 * Remote MCP server over Streamable HTTP, stateless, JSON responses. Every tool call is dispatched back into `app` as an
 * ordinary request carrying the caller's own credentials, so the API's permissions, scopes and validation apply as they
 * do for any other client.
 */
export function mountMcp(app: Hono<any>, options: MountMcpOptions) {
  const { server, path } = options;
  const credentialHeaders = options.credentialHeaders ?? ["authorization", "x-api-key", "cookie"];
  const forwarded = [...credentialHeaders, ...(options.contextHeaders ?? [])];
  const scope = options.scopes?.length ? `, scope="${options.scopes.join(" ")}"` : "";
  const metadataPath = options.resourceMetadataPath ?? `/.well-known/oauth-protected-resource${path}`;
  const challenge = (origin: string) => `Bearer resource_metadata="${origin}${metadataPath}"${scope}`;

  app.on("POST", path, async (c) => {
    const origin = originOf(c.req.url);
    const unauthorized = () => c.json(rpcError(-32001, "Unauthorized"), 401, { "www-authenticate": challenge(origin) });

    const headers = new Headers();
    for (const h of options.anonymous ? [] : forwarded) {
      const v = c.req.header(h);
      if (v) headers.set(h, v);
    }
    const foreign = c.req.header("origin");
    if (foreign && foreign !== origin && !(options.cookieOrigins?.(c) ?? []).includes(foreign)) headers.delete("cookie");
    if (!options.anonymous && !credentialHeaders.some((h) => headers.has(h))) return unauthorized();

    const raw = (await c.req.json().catch(() => undefined)) as unknown;
    if (raw === undefined) return c.json(rpcError(-32700, "Parse error"), 400);

    let executionCtx: Parameters<typeof app.fetch>[2];
    try {
      executionCtx = c.executionCtx as typeof executionCtx;
    } catch {}
    let rejected = false;
    const call = async (r: RestCall) => {
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

    if (Array.isArray(raw) && raw.length > MAX_BATCH) return c.json(rpcError(-32600, `Invalid Request: a batch holds at most ${MAX_BATCH} messages`), 400);
    const items = Array.isArray(raw) ? raw : [raw];
    // bad or expired credentials: tell the client with a real 401 so it can (re)start the authorization flow
    const method = (m: unknown) => String((m as { method?: string } | null)?.method ?? "");
    const needsAuth = items.some((m) => method(m) !== "ping" && !method(m).startsWith("notifications/"));
    if (needsAuth && options.probePath && !options.anonymous) {
      const probe = await call({ method: "GET", path: options.probePath });
      if (rejected) return unauthorized();
      if (probe.status === 403) return c.json(rpcError(-32003, probe.text), 403);
    }
    const out = (await Promise.all(items.map((m) => server.handle(m as never, call, { publicOnly: !!options.anonymous })))).filter((r) => r !== null);
    if (out.length === 0) return c.body(null, 202);
    return c.json(Array.isArray(raw) ? out : out[0]);
  });
  app.on(["GET", "DELETE"], path, (c) => c.body(null, 405, { allow: "POST" }));
}

export type OAuthMetadataOptions = {
  /** The resource identifier tokens are issued for (RFC 8707); usually the MCP endpoint's URL. */
  resource: (c: Context) => string;
  /** Issuer URLs of the authorization servers that can issue tokens for it. */
  authorizationServers: (c: Context) => string[];
  scopes?: string[];
  resourceName?: string;
  /** Path of the MCP endpoint, for the path-inserted metadata URL; omit to serve only the plain one. */
  mcpPath?: string;
  /** Serve the authorization server's own metadata from the root too (RFC 8414 §3), where clients look for an issuer with a path. */
  authorizationServer?: { paths: string[]; load: (c: Context) => Promise<Response> };
};

/** OAuth 2.0 Protected Resource Metadata (RFC 9728), and optionally the authorization server's metadata documents. */
export function mountOAuthMetadata(app: Hono<any>, options: OAuthMetadataOptions) {
  const resourceMeta = (c: Context) =>
    c.json({
      resource: options.resource(c),
      authorization_servers: options.authorizationServers(c),
      ...(options.scopes ? { scopes_supported: options.scopes } : {}),
      bearer_methods_supported: ["header"],
      ...(options.resourceName ? { resource_name: options.resourceName } : {}),
    });
  app.get("/.well-known/oauth-protected-resource", resourceMeta);
  if (options.mcpPath) app.get(`/.well-known/oauth-protected-resource${options.mcpPath}`, resourceMeta);

  const as = options.authorizationServer;
  if (!as) return;
  for (const p of as.paths) {
    app.get(p, async (c) => {
      const res = await as.load(c);
      return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } });
    });
  }
}
