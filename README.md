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

## Deploy to Cloudflare

The site is two Workers on one domain:

| Worker | Serves | Also does |
|---|---|---|
| `openuptime-api` | `your-domain/api/*` (a Worker **route** on your zone) | minute cron, queue consumer that runs the checks |
| `openuptime-web` | everything else on `your-domain` (a Worker **custom domain**) | status pages (SSR); reaches the API through a service binding |

Keeping the API under `/api/*` of the same domain means session cookies stay same-origin. You need no separate API hostname.

**Before you start**

- A Cloudflare account and a domain whose DNS is on Cloudflare (the zone).
- A Postgres database reachable from the internet (Neon, Supabase, RDS, your own). Workers connect through Hyperdrive.
- Node.js 22+ and pnpm.
- Workers **Paid** plan for the Queue (default). On the Free plan, run in inline mode instead: see [Reference](docs/reference.md#cloudflare-free-plan).

### 1. Get the code and sign in

```bash
git clone https://github.com/becoolme/openuptime.git && cd openuptime
pnpm install
cd apps/api && npx wrangler login
```

All `npx wrangler …` commands below run in `apps/api` unless noted.

### 2. Create the Queue and Hyperdrive

```bash
npx wrangler queues create openuptime-checks
npx wrangler hyperdrive create openuptime-prod --connection-string="postgres://user:pass@host:5432/db"
```

The second command prints an id. In `apps/api/wrangler.jsonc` uncomment the `hyperdrive` line and paste it:

```jsonc
"hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<id printed above>" }],
```

The commented `placement` line is optional (it runs the Worker next to your database host); leave it commented unless you
want that.

### 3. Create the schema

From the repository root:

```bash
DATABASE_URL="postgres://user:pass@host:5432/db" pnpm db:migrate
```

It only applies what is new, so run it again after every upgrade. If your database role cannot `CREATE SCHEMA`, use
`node migrate-plain.mjs` in `packages/db-pg` with the same `DATABASE_URL`.

### 4. Point the config at your domain

Edit two files. In both, replace `openuptime.app` with your own domain.

`apps/api/wrangler.jsonc`, where `zone_name` is the zone (the apex domain) even when you serve from a subdomain:

```jsonc
"routes": [{ "pattern": "status.example.com/api/*", "zone_name": "example.com" }],
"vars": {
  "BETTER_AUTH_URL": "https://status.example.com",   // public origin: cookies, OAuth, email links
  "WEB_ORIGIN": "https://status.example.com",        // same value
  "EMAIL_FROM": "alerts@example.com"                 // sender address, see Reference → Email
}
```

`apps/web/wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "status.example.com", "custom_domain": true }],
"vars": { "PRODUCT_URL": "https://status.example.com" }   // target of the "Powered by" link on status pages
```

The custom domain creates its DNS record and certificate for you; the hostname must not already have a DNS record
pointing elsewhere.

### 5. Set the secrets

```bash
npx wrangler secret put BETTER_AUTH_SECRET     # openssl rand -hex 32
npx wrangler secret put CRON_SECRET            # any long random string; guards /internal/*
```

If wrangler asks to create the Worker first, answer yes. Optional: `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` add
"Sign in with GitHub".

### 6. Deploy

```bash
npx wrangler deploy                           # in apps/api
cd ../web && pnpm build && npx wrangler deploy
```

Deploy the API first: the web Worker binds to it by name.

### 7. Check it

```bash
curl https://status.example.com/api/health    # {"ok":true}
```

Open the domain and sign up. Once your own account exists you can set `"DISABLE_SIGNUP": "true"` in the API `vars` and
deploy again to close registration (invited people can still join).

**Upgrade later:** pull, `pnpm install`, `pnpm db:migrate`, then deploy the API and the web Worker, in that order.

## Self-host with Docker

One container runs the API, the web app and the check scheduler; Postgres comes with the compose file.

```bash
git clone https://github.com/becoolme/openuptime.git && cd openuptime
cp .env.docker.example .env      # set POSTGRES_PASSWORD and BETTER_AUTH_SECRET (openssl rand -hex 32)
docker compose up -d --build     # http://localhost:8080
```

The schema is migrated on start and the data lives in the `pgdata` volume. Set `PUBLIC_URL` when the app is not served
from `http://localhost:8080`. Email is optional; see [Reference](docs/reference.md#email).

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

## Contributing & security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## License

[MIT](LICENSE)
