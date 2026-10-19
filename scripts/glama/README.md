# Glama evaluation sandbox

Glama evaluates source servers through stdio. OpenUptime's production transport remains Streamable HTTP.
`server.mjs` bridges newline-delimited JSON-RPC to the real local `/api/mcp` endpoint. It starts an empty,
temporary PostgreSQL cluster and the bundled Community API, then signs up a disposable test user through the normal
authentication route. Tool discovery and calls use that user's session and the existing API permissions.

The sandbox accepts no database URL, API key or remote endpoint. It does not inherit SMTP, probes or other deployment
settings. Both services bind to loopback; processes and database files are removed on stdin EOF or termination.
API startup logs go to stderr so stdout contains only JSON-RPC. The evaluator listener uses the production API routes
without a background check scheduler. Do not deploy this evaluator as a public service.

## Glama Docker configuration

- Node.js: `22`
- Base image: `debian:bookworm-slim`
- Python: `3.12` (only used by the platform's base image setup)
- Build steps:

```json
[
  "apt-get update && apt-get install -y --no-install-recommends postgresql libpq-dev && rm -rf /var/lib/apt/lists/*",
  "pnpm install --frozen-lockfile",
  "node scripts/gen-migrations.mjs && pnpm --filter @openuptime/api build:glama"
]
```

- CMD arguments: `["node", "scripts/glama/server.mjs"]`
- Environment variables schema: `{"type":"object","properties":{},"required":[]}`
- Placeholder parameters: `{}`

No production credentials or external database are needed. PostgreSQL tools must be on PATH (`pg_config` resolves
their installation directory); the Debian package provides them. Root containers run PostgreSQL as the package's
`postgres` user. Local non-root runs use the current OS user.

## Local verification

Build the API with the same commands, install PostgreSQL, then run:

```sh
node --test scripts/glama/server.test.mjs
```

The integration test starts its own cluster. It checks initialize, the real tool manifest, an authenticated monitor
create/read/update/delete round trip, malformed JSON recovery, and shutdown cleanup. It never runs checks against
external services.
