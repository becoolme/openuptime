# @openuptime/mcp-rest

Turn a REST API into a remote [MCP](https://modelcontextprotocol.io) server. Streamable HTTP, stateless, JSON responses.
Every tool is a thin REST call made with the **caller's own credentials**, so the API's permissions, scopes and
validation apply unchanged. There is nothing OpenUptime-specific in here.

| Import | What it gives you | Needs |
| --- | --- | --- |
| `@openuptime/mcp-rest` | `createMcpServer`, `defineTool`: JSON-RPC handling, schemas, annotations | `zod` |
| `@openuptime/mcp-rest/hono` | `mountMcp` (the endpoint, 401 challenge, batches) and `mountOAuthMetadata` (RFC 9728 / 8414 documents) | `hono` |
| `@openuptime/mcp-rest/oauth` | `verifyAccessToken`: checks a JWT for your resource against a JWKS | `jose` |

## Use

```ts
import { createMcpServer, defineTool } from "@openuptime/mcp-rest";
import { mountMcp, mountOAuthMetadata } from "@openuptime/mcp-rest/hono";
import { z } from "zod";

const server = createMcpServer({
  info: { name: "my-api", version: "1.0.0" },
  instructions: "Manage things. Ids come from list_things.",
  tools: [
    defineTool({ name: "list_things", description: "List things.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/things" }) }),
    defineTool({ name: "get_thing", description: "Get one thing.", schema: z.object({ id: z.string().uuid() }), readOnly: true, build: (a) => ({ method: "GET", path: `/api/things/${a.id}` }) }),
  ],
  // optional arguments every tool accepts, sent on as headers (which tenant to act in, …)
  context: { shape: { team: z.string().optional() }, toHeaders: ({ team }) => (typeof team === "string" ? { "x-team-id": team } : {}) },
});

mountMcp(app, { server, path: "/api/mcp", scopes: ["mcp:read", "mcp:write"], probePath: "/api/me" });
mountOAuthMetadata(app, {
  resource: (c) => `${new URL(c.req.url).origin}/api/mcp`,
  authorizationServers: () => ["https://auth.example.com"],
  mcpPath: "/api/mcp",
});
```

`mountMcp` calls your own app back with `app.fetch`, forwarding `authorization`, `x-api-key` and `cookie` (the cookie
only from the endpoint's own origin or the origins `cookieOrigins` names). `probePath` is an authenticated `GET` that
turns bad credentials into a real HTTP 401, which is what makes clients start or refresh the OAuth flow.

## Tests

`pnpm --filter @openuptime/mcp-rest test`
