import { mountMcp as mountMcpEndpoint, mountOAuthMetadata } from "@openuptime/mcp-rest/hono";
import type { Hono } from "hono";
import { mcpResource } from "./auth";
import type { AppEnv } from "./env";
import { PUBLIC_TOOLS, server } from "./mcp";

const originOf = (url: string) => new URL(url).origin;
const SCOPES = ["mcp:read", "mcp:write"];

/**
 * Remote MCP server and the OAuth discovery documents agents need to authorize themselves. The protocol, the transport
 * and the metadata documents come from @openuptime/mcp-rest; this wires them to our API and authorization server.
 */
export function mountMcp(app: Hono<AppEnv>) {
  // read-only tools for public status pages; no credentials, and nothing the caller sends reaches the API
  mountMcpEndpoint(app, { server, path: "/api/mcp/public", anonymous: true });
  // a small discovery document for agents and directories
  app.get("/.well-known/mcp.json", (c) => {
    const base = mcpResource(c.env).replace(/\/api\/mcp\/?$/, "");
    return c.json(
      {
        name: "OpenUptime",
        description: "Uptime monitoring and status pages. The endpoint without credentials reads public status pages by slug.",
        endpoints: [
          { url: `${base}/api/mcp`, transport: "streamable-http", authorization: "oauth2", scopes: SCOPES, tools: "monitors, incidents, status pages and maintenance of your workspaces" },
          { url: `${base}/api/mcp/public`, transport: "streamable-http", authorization: "none", tools: PUBLIC_TOOLS.map((t) => t.name) },
        ],
      },
      200,
      { "cache-control": "public, max-age=3600" },
    );
  });
  mountMcpEndpoint(app, {
    server,
    path: "/api/mcp",
    scopes: SCOPES,
    contextHeaders: ["x-project-id", "x-workspace-id"],
    // a browser page from another site cannot ride on the session cookie; our own web app can
    cookieOrigins: (c) => [c.env.WEB_ORIGIN],
    probePath: "/api/me",
  });
  mountOAuthMetadata(app, {
    resource: (c) => mcpResource(c.env),
    authorizationServers: (c) => [`${originOf(c.env.BETTER_AUTH_URL)}/api/auth`],
    scopes: SCOPES,
    resourceName: "OpenUptime",
    mcpPath: "/api/mcp",
    authorizationServer: {
      paths: ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/api/auth", "/.well-known/openid-configuration", "/.well-known/openid-configuration/api/auth"],
      load: (c) => (c.get("auth").api as unknown as { getOAuthServerConfig: (o: { asResponse: true }) => Promise<Response> }).getOAuthServerConfig({ asResponse: true }),
    },
  });
}
