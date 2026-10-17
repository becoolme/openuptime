import { mountMcp as mountMcpEndpoint, mountOAuthMetadata } from "@openuptime/mcp-rest/hono";
import type { Hono } from "hono";
import { mcpResource } from "./auth";
import type { AppEnv } from "./env";
import { server } from "./mcp";

const originOf = (url: string) => new URL(url).origin;
const SCOPES = ["mcp:read", "mcp:write"];

/**
 * Remote MCP server and the OAuth discovery documents agents need to authorize themselves. The protocol, the transport
 * and the metadata documents come from @openuptime/mcp-rest; this wires them to our API and authorization server.
 */
export function mountMcp(app: Hono<AppEnv>) {
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
