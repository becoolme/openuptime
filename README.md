![OpenUptime](apps/web/public/og.png)

# OpenUptime

Open-source uptime monitoring and status pages. Runs on Cloudflare Workers with Postgres, or in one Docker container.

[Hosted version](https://openuptime.app) · [Docs](https://openuptime.app/docs/self-host) · [Reference](docs/reference.md) · [MIT license](LICENSE)

- HTTP, TCP, DNS, heartbeat, PostgreSQL, MySQL and Redis checks, with keyword matching and slow-response alerts
- Incidents, maintenance windows and public status pages with email / RSS subscriptions
- Alerts to Slack, Lark / Feishu, Telegram, PagerDuty, webhooks and email
- Workspaces, projects, roles, API keys, an MCP server for agents, JSON import / export

| Part | Stack |
|---|---|
| `apps/api` | Hono, better-auth, Cloudflare Worker (cron + queue consumer) |
| `apps/web` | Astro (static pages, SSR for status pages) + React islands |
| `packages/repo` | Storage interface (`Repo`) and entity types |
| `packages/db-pg` | Postgres implementation of `Repo`: Drizzle schema, migrations |

## Self-host with Docker

One container runs the API, the web app and the check scheduler; Postgres comes with the compose file.

```bash
git clone https://github.com/becoolme/openuptime.git && cd openuptime
cp .env.docker.example .env      # set POSTGRES_PASSWORD and BETTER_AUTH_SECRET (openssl rand -hex 32)
docker compose up -d --build     # http://localhost:8080
```

The schema is migrated on start and the data lives in the `pgdata` volume. Set `PUBLIC_URL` when the app is not served
from `http://localhost:8080`. Email is optional; see [Reference](docs/reference.md#email).

## Deploy to Cloudflare

Two Workers: `openuptime-api` (route `<domain>/api/*`, cron, queue consumer) and `openuptime-web` (custom domain,
reaches the API through a service binding). Edit the domain in `apps/api/wrangler.jsonc` and `apps/web/wrangler.jsonc`.

```bash
wrangler queues create openuptime-checks
wrangler hyperdrive create openuptime-prod --connection-string="postgres://…"   # then uncomment `hyperdrive` in apps/api/wrangler.jsonc
DATABASE_URL="postgres://…" pnpm db:migrate
cd apps/api && wrangler secret put BETTER_AUTH_SECRET && wrangler secret put CRON_SECRET && wrangler deploy
cd ../web && pnpm build && wrangler deploy      # deploy the API first: the web Worker binds to it
```

The Queue needs the Workers Paid plan; for the Free plan see [Reference](docs/reference.md#cloudflare-free-plan).

## Develop

```bash
pnpm install
cp .env.example apps/api/.dev.vars   # edit DATABASE_URL and secrets
pnpm db:migrate
pnpm dev:api    # http://localhost:8787  (checks run inline every 15s)
pnpm dev:web    # http://localhost:4321  (proxies /api to the API)
pnpm typecheck
```

Tests, how checks run, the MCP server, alert channels and the other details are in [docs/reference.md](docs/reference.md).

## Contributing & security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## License

[MIT](LICENSE)
