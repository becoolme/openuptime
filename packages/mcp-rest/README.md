# @openuptime/mcp-rest

Turn a REST API into a remote [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server, so AI agents such
as Claude can use it as a set of tools.

- **Transport:** Streamable HTTP, stateless, JSON responses (no sessions, no server-pushed streams).
- **Tools are REST calls.** Each tool validates its arguments with a [zod](https://zod.dev) schema and turns them into
  one HTTP request. The request goes back through your own app with the **caller's own credentials**, so your
  permissions, API-key scopes, rate limits and validation apply exactly as they do for any other client. The MCP layer
  adds no privileges of its own.
- **OAuth ready.** It answers unauthenticated calls with the `401` challenge MCP clients expect, serves the OAuth
  discovery documents, and can verify JWT access tokens.
- **Small and framework-light.** The core depends only on `zod`. The HTTP adapter targets [Hono](https://hono.dev) and
  works on Cloudflare Workers, Node, Bun and Deno. Token verification uses [jose](https://github.com/panva/jose).

It was extracted from [OpenUptime](https://github.com/becoolme/openuptime), where it serves `POST /api/mcp`. Nothing in
it is specific to OpenUptime.

## Entry points

| Import | Provides | Needs |
| --- | --- | --- |
| `@openuptime/mcp-rest` | `createMcpServer`, `defineTool`, types: JSON-RPC handling, tool manifest, argument validation | `zod` |
| `@openuptime/mcp-rest/hono` | `mountMcp`, `mountOAuthMetadata`: the HTTP endpoint and the OAuth discovery documents | `hono` |
| `@openuptime/mcp-rest/oauth` | `verifyAccessToken`: checks a JWT access token for your resource | `jose` |

`hono` and `jose` are optional peer dependencies; install only what you import.

## Install

Inside this monorepo:

```jsonc
// package.json of the consuming app
{ "dependencies": { "@openuptime/mcp-rest": "workspace:*" } }
```

The package is currently `private` and its `exports` point at TypeScript sources, which suits a bundler (wrangler,
esbuild, Vite, tsx). To use it from another repository, copy the folder, or remove `private`, build to JavaScript and
point `exports` at the output before publishing to npm.

## Quick start

```ts
import { Hono } from "hono";
import { z } from "zod";
import { createMcpServer, defineTool } from "@openuptime/mcp-rest";
import { mountMcp, mountOAuthMetadata } from "@openuptime/mcp-rest/hono";

const server = createMcpServer({
  info: { name: "my-api", version: "1.0.0" },
  instructions: "Manage things. Ids are uuids returned by list_things.",
  tools: [
    defineTool({
      name: "list_things",
      description: "List things with their ids.",
      schema: z.object({}),
      readOnly: true,
      build: () => ({ method: "GET", path: "/api/things" }),
    }),
    defineTool({
      name: "rename_thing",
      description: "Change the name of a thing.",
      schema: z.object({ id: z.string().uuid(), name: z.string().min(1).max(80) }),
      build: ({ id, name }) => ({ method: "PATCH", path: `/api/things/${id}`, body: { name } }),
    }),
  ],
});

const app = new Hono();
// ... your REST API routes under /api ...

mountMcp(app, {
  server,
  path: "/api/mcp",
  scopes: ["mcp:read", "mcp:write"],
  probePath: "/api/me", // an authenticated GET; see "Authentication" below
});
mountOAuthMetadata(app, {
  resource: (c) => `${new URL(c.req.url).origin}/api/mcp`,
  authorizationServers: () => ["https://auth.example.com"],
  scopes: ["mcp:read", "mcp:write"],
  mcpPath: "/api/mcp",
});

export default app;
```

Point an MCP client at `https://your-host/api/mcp`.

## Defining tools

```ts
defineTool({
  name: "delete_thing",          // unique; what the model calls
  description: "…",              // written for the model: what it does, when to use it, what the arguments mean
  schema: z.object({ id: z.string().uuid() }),
  destructive: true,             // optional hints, sent as MCP annotations
  build: ({ id }) => ({ method: "DELETE", path: `/api/things/${id}` }),
});
```

| Field | Meaning |
| --- | --- |
| `name`, `description` | Shown to the model. Good descriptions matter more than anything else here. |
| `schema` | A `z.object`. It is converted to JSON Schema for `tools/list` and validates every call. |
| `readOnly` | Sets `readOnlyHint` and `idempotentHint`: the tool changes nothing. |
| `destructive` | Sets `destructiveHint`: the tool removes data. Clients may ask the user first. |
| `build(args)` | Returns the REST request: `{ method, path, body?, headers? }`. `body` is sent as JSON. |

`defineTool` only exists to give `build` the type of its own schema; it returns a plain `Tool`, so you can keep tools
in a `Tool[]`.

Bad arguments and REST errors (status 400 and up) are returned as **tool errors** (`isError: true` with the message), so
the model can read them and retry. Protocol errors (unknown method, unknown tool, malformed request) use JSON-RPC error
codes.

### Tool metadata

Describe each argument with `.describe(...)`, including units, discovery sources and clearing/replacement behavior.
A tool description should explain when to use it, its result and any side effects beyond the schema.
`readOnly` and `destructive` set the corresponding MCP hints. `idempotent` may override the default (true for
read-only tools, false otherwise); set `openWorld: true` when a call interacts with external systems.
`aliases: ["old_name"]` preserves legacy calls while only the canonical `name` appears in discovery. Aliases use the
same validation and public/private boundary as their canonical tool; names and aliases must be unique across tools.

### Context arguments

Some APIs need to know where a call acts: a tenant, a workspace, a project. Declare optional arguments once and they
are added to every tool and sent on as headers instead of reaching `build`:

```ts
createMcpServer({
  // …
  context: {
    shape: { team: z.string().optional().describe("Team id. Omit to use the default one.") },
    toHeaders: ({ team }) => (typeof team === "string" ? { "x-team-id": team } : {}),
  },
});
```

Also list the header in `mountMcp({ contextHeaders: ["x-team-id"] })` if clients may send it on the MCP request itself.

## `createMcpServer(options)`

| Option | Meaning |
| --- | --- |
| `info` | `{ name, version }`, reported on `initialize`. |
| `instructions` | Optional free text the model sees when it connects. |
| `tools` | The `Tool[]`. |
| `context` | Optional extra arguments for every tool, see above. |
| `protocolVersions` | Accepted MCP versions, newest first. Default `2025-06-18`, `2025-03-26`, `2024-11-05`. A client asking for another version gets the newest. |

It returns `{ info, tools, manifest, handle }`. `handle(message, call)` answers one JSON-RPC message (`initialize`,
`ping`, `tools/list`, `tools/call`) and returns `null` for notifications. `call` is your function that performs a
`RestCall` and returns `{ status, text }`. You normally never call `handle` yourself, because `mountMcp` does, but it
makes the server easy to test or to host behind another transport.

## `mountMcp(app, options)`

Registers `POST <path>` (and answers `405` with `Allow: POST` to `GET` and `DELETE`, since the server never pushes).

| Option | Default | Meaning |
| --- | --- | --- |
| `server` | | The server from `createMcpServer`. |
| `path` | | Endpoint path, for example `/api/mcp`. |
| `scopes` | none | Scopes named in the `401` challenge so clients know what to request. |
| `credentialHeaders` | `authorization`, `x-api-key`, `cookie` | Headers that carry credentials. They are forwarded as-is, and at least one must be present. |
| `contextHeaders` | none | Other headers to forward, such as a workspace id. |
| `cookieOrigins` | none | Origins other than the endpoint's own that may use a session cookie (for example your web app). |
| `probePath` | none | An authenticated `GET` run before the first real call; see below. |
| `anonymous` | `false` | Serve without credentials: nothing the caller sends is forwarded, and only tools defined with `public: true` are listed or callable. Mount it as a second endpoint (for example `/api/mcp/public`) beside the authenticated one. |
| `resourceMetadataPath` | `/.well-known/oauth-protected-resource<path>` | Where clients find the protected-resource metadata. |

JSON-RPC batches are supported, up to 10 messages each (a larger one is answered with `400` and JSON-RPC error `-32600`). A body that contains only notifications is answered with `202`.

### How a call flows

1. The credentials in the MCP request are copied onto every REST request the tools make.
2. Each tool call becomes `app.fetch(new Request(origin + path, …))` against **the same app**, in-process. Your
   routes, middleware and database see an ordinary authenticated request.
3. The REST response is returned to the model as text (JSON is pretty-printed).

Because the call goes through your normal request pipeline, there is no second authorization system to keep in sync.

## Authentication

The server does not authenticate anyone itself. It forwards credentials to your API and relies on the API to accept or
reject them.

- **No credentials** → `401` with `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`. This is how an MCP client
  learns where to start OAuth.
- **Credentials your API rejects** → the same `401`, if you set `probePath`. The probe is a cheap authenticated `GET`
  (for example `/api/me`) sent once per request that has real work to do (not for `ping` or notifications). Without it,
  a rejected token would only surface as a tool error inside a `200` response, and the client would not know to refresh
  or re-authorize. A `403` from the probe becomes a JSON-RPC error `-32003` with HTTP `403`.
- **Session cookies** are forwarded only when the request has no `Origin` header, the same origin as the endpoint, or an
  origin listed in `cookieOrigins`. A page on another site cannot make a user's browser call the MCP endpoint with their
  cookie.
- **API keys and bearer tokens** are forwarded untouched.

### OAuth discovery

`mountOAuthMetadata(app, options)` serves:

- `GET /.well-known/oauth-protected-resource` and, with `mcpPath`, `…/oauth-protected-resource<mcpPath>`: the
  [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) document naming your resource, authorization servers and scopes.
- Optionally, with `authorizationServer: { paths, load }`, the authorization server's own metadata at the given paths
  (for an issuer with a path component, [RFC 8414 §3](https://www.rfc-editor.org/rfc/rfc8414#section-3) says clients
  look at the root). `load` returns the upstream `Response`; it is re-served with `Cache-Control: public, max-age=300`.

### Verifying access tokens

If your API accepts JWT access tokens issued for the MCP resource, `verifyAccessToken` does the signature, issuer and
audience check:

```ts
import { verifyAccessToken } from "@openuptime/mcp-rest/oauth";

const claims = await verifyAccessToken(bearerToken, {
  jwks: () => auth.api.getJwks(),                 // the authorization server's JWKS
  issuer: "https://auth.example.com",
  audience: "https://your-host/api/mcp",          // the resource tokens were issued for (RFC 8707)
});
if (!claims) throw new Error("invalid token");     // not a JWT, bad signature, wrong issuer or audience, expired
```

It returns the JWT payload, or `null`. It never throws and ignores strings that are not three-part JWTs (such as
opaque API keys), so you can call it first and fall back to other credential types.

## Testing

```bash
pnpm --filter @openuptime/mcp-rest test
pnpm --filter @openuptime/mcp-rest typecheck
```

The tests cover the protocol (version negotiation, tool manifest, argument validation, error mapping, notifications) and
the Hono adapter (401 challenge, credential probe, cookie handling, batches, malformed input, metadata documents).
`createMcpServer(...).handle` takes a plain `call` function, so you can test your own tool list without HTTP; see
`apps/api/src/mcp.test.ts` in this repository.

## Limitations

- **Tools only.** No resources, prompts, sampling or elicitation.
- **Stateless.** No `Mcp-Session-Id`, no server-initiated messages, no resumable streams.
- **JSON responses only.** No SSE streaming of a single response.
- **Hono only** for the HTTP adapter. The core is framework-free; adapting another framework means reimplementing the
  ~60 lines of `mountMcp` around `server.handle`.

## License

MIT, like the rest of the repository.
