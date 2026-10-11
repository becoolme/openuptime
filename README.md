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

## Open source vs hosted

The monitoring itself is the same code in both. The hosted service at [openuptime.app](https://openuptime.app) adds
plans, billing and a few features that live only in that build; it plugs into this repo through one interface
(`Edition`, see [docs/editions.md](docs/editions.md)), so nothing in the core is locked or throttled.

| | Self-hosted (this repo, MIT) | Hosted ([openuptime.app](https://openuptime.app)) |
|---|---|---|
| Monitors, incidents, status pages, alert channels, API, MCP | All of it | All of it |
| Limits | None: no plans, quotas or metering | Free plan, paid plans from $5/month ([pricing](https://openuptime.app/pricing)); monitors, checks, emails and history length depend on the plan |
| Running it | You: Postgres, the Worker or container, a mail provider, backups, upgrades | We do; nothing to install |
| SSL certificate monitoring (expiry alerts, `ssl` monitor type) | Not included | Lite and above |
| Custom domain for a status page | Not included | Team |
| Where your data lives | Your database | Ours (Postgres on managed hosting) |

Pick self-hosting if you want to own the data and the infrastructure, or have no limits to worry about. Pick hosted if
you would rather not run anything. Both receive the same core updates.

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
