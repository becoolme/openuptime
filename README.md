# OpenUptime

Open-source uptime monitoring and status pages. Runs on Cloudflare Workers with Postgres, or in one Docker container.

[Hosted version](https://openuptime.app) · [Docs](https://openuptime.app/docs/self-host) · [MIT license](LICENSE)

- HTTP, TCP, DNS, heartbeat, PostgreSQL, MySQL and Redis checks, with keyword matching and slow-response alerts
- Incidents, maintenance windows and public status pages with email / RSS subscriptions
- Alerts to Slack, Lark / Feishu, Telegram, PagerDuty, webhooks and email
- Workspaces, projects, roles, API keys, an MCP server for agents, JSON import / export

| Part | Stack |
|---|---|
| `apps/api` | Hono, better-auth (+ organization, api-key), Cloudflare Worker (cron + queue consumer) |
| `apps/web` | Astro (static pages + SSR only for status pages, Cloudflare adapter) + React islands |
| `packages/repo` | Storage interface (`Repo`) and entity types, no driver code |
| `packages/db-pg` | Postgres implementation of `Repo`: Drizzle schema, migrations, postgres.js |

## Self-host with Docker

One container runs the API, the web app and the check scheduler; Postgres comes with the compose file.

```bash
git clone https://github.com/becoolme/openuptime.git && cd openuptime
cp .env.docker.example .env      # set POSTGRES_PASSWORD and BETTER_AUTH_SECRET (openssl rand -hex 32)
docker compose up -d --build     # http://localhost:8080
```

- **Schema** is migrated automatically on start; the data lives in the `pgdata` volume.
- **Public URL**: set `PUBLIC_URL` when it is not `http://localhost:8080` (cookies and email links use it).
- **Email** (invitations, password reset, alerts, status page subscriptions) is optional. Set `EMAIL_FROM` plus one of:
  `RESEND_API_KEY` (Resend, sender on a verified domain), `SMTP_URL` (`smtps://user:pass@host:465`; URL-encode special
  characters) or `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` (`SMTP_SECURE=true` for implicit TLS on 465,
  otherwise STARTTLS). The connection is verified at startup and logged. Without it, emails are written to the log.
- **Scaling**: checks are leased with `FOR UPDATE SKIP LOCKED`, so several containers can run against one database.
- **Prebuilt image**: tagged releases are published to `ghcr.io/becoolme/openuptime` by `.github/workflows/docker.yml`.
  To use one, set `OPENUPTIME_IMAGE` in `.env` and run `docker compose pull`.

## Develop

```bash
pnpm install
cp .env.example apps/api/.dev.vars   # edit DATABASE_URL and secrets
pnpm db:migrate
pnpm dev:api    # http://localhost:8787  (checks run inline every 15s)
pnpm dev:web    # http://localhost:4321  (proxies /api to the API)
```

## How checks run

1. A Cron Trigger fires every minute (`* * * * *`, minimum interval: 60s).
2. It atomically leases due monitors (`UPDATE … FOR UPDATE SKIP LOCKED`), so overlapping runs never duplicate work.
3. Leased monitors are packed 25 per message into the `openuptime-checks` Queue.
4. The queue consumer (same Worker) runs each pack with its own invocation budget, writes results, opens and resolves incidents, and fans out alerts (Slack, Lark / Feishu, webhook, Telegram, PagerDuty, email).

Without a bound queue (local dev, or `POST /internal/run-checks` with `x-cron-secret`), checks run inline.

## Deploy

Two Workers: `openuptime-api` (route `<domain>/api/*`, cron, queue consumer) and `openuptime-web` (custom domain, reaches the API through a service binding). Edit the domain in `apps/api/wrangler.jsonc` and `apps/web/wrangler.jsonc`.

```bash
wrangler queues create openuptime-checks
wrangler hyperdrive create openuptime-prod --connection-string="postgres://…"   # then uncomment `hyperdrive` in apps/api/wrangler.jsonc
DATABASE_URL="postgres://…" pnpm db:migrate
cd apps/api && wrangler secret put BETTER_AUTH_SECRET && wrangler secret put CRON_SECRET && wrangler deploy
cd ../web && pnpm build && wrangler deploy      # deploy the API first: the web Worker binds to it
```

Email goes through Cloudflare Email Sending: onboard the sending domain, then set `EMAIL_FROM` in `apps/api/wrangler.jsonc`. The Queue needs the Workers Paid plan. To run on the Free plan, delete the `queues` block from `apps/api/wrangler.jsonc` and skip `wrangler queues create`: the minute cron then runs up to 40 monitors inline. See `/docs/self-host`.

## Accounts & teams

- Workspaces with projects, members and roles; invitations expire after `INVITE_TTL_DAYS` (default 7). Set `DISABLE_SIGNUP=true` to close registration (invited people can still join).
- Email verification is requested at sign-up (it never blocks sign-in), optional TOTP two-step verification with backup codes, account deletion and a JSON data export under **Account**.
- Legal pages live at `/privacy` and `/terms`; the REST reference is at `/docs/api`.

## API keys

Create one under **API keys** in the app, then send `x-api-key: <key>` or `Authorization: Bearer <key>` to `/api/*`.

## MCP (agents)

`POST /api/mcp` is an MCP server (Streamable HTTP) with tools for monitors, incidents, status pages, channels and maintenance windows. Every tool calls the REST API with the caller's credentials.

```bash
claude mcp add --transport http openuptime https://<your-host>/api/mcp
```

Clients authorize with OAuth 2.1 (dynamic client registration + PKCE; discovery at `/.well-known/oauth-protected-resource`). The user chooses what the agent may reach (every workspace, selected workspaces, or only selected projects) and approves `mcp:read` / `mcp:write`; the grant can be revoked under **API keys → Authorized agents**. An API key (`Authorization: Bearer ou_…`) works too. An agent with several workspaces calls `list_workspaces` and passes `workspace` / `project` ids to the other tools (REST: `x-workspace-id` / `x-project-id` headers). `create_project` works in any workspace where the grant covers all projects; `create_workspace` only for agents authorized for every workspace. Tokens are JWTs for the resource `<BETTER_AUTH_URL>/api/mcp`, so clients must send the RFC 8707 `resource` parameter (the MCP spec requires it).

## Monitoring features

- **HTTP** checks: expected status, optional keyword (must contain / must not contain), custom request headers (use for bearer/basic auth).
- **TCP**, **DNS**, **Heartbeat** (with a grace period before a missed ping counts as a failure).
- **PostgreSQL**, **MySQL / MariaDB**, **Redis** reachability probes (handshake / `PING`; no credentials are sent).
- **Response-time alerts**: per-monitor "slow" threshold (default 1500 ms) marks a monitor degraded; optionally open a minor incident after N consecutive slow checks.
- **Tags** to group and filter monitors, plus **JSON import / export** (`GET /api/monitors/export`, `POST /api/monitors/import`).
- **Stats** come from an hourly rollup (`check_rollup`), so uptime stays cheap as history grows. Raw check results are kept 90 days by default (Settings → Check history); rollups for a year.
- **Per-monitor alert routing**: pick which channels a monitor notifies; none selected = all.
- **Maintenance windows**: checks continue, but no incidents or alerts for covered monitors.
- Not supported on Workers: TLS certificate expiry (the runtime does not expose certificates) and multi-region probing.

## Status page subscriptions

Each public status page offers email subscriptions (double opt-in, one-click unsubscribe link in every mail) and an RSS feed at `/api/public/status/<slug>/rss`. Subscribers are emailed when an incident opens or resolves on a monitor shown on that page. Email goes through the Cloudflare Email Service `send_email` binding (`EMAIL`) and needs `EMAIL_FROM`; without them mails are printed to the log. Past incidents are paginated on the page (`?before=<cursor>`, also `GET /api/public/status/<slug>/incidents`).

## Alert channels

| Type | Config |
| --- | --- |
| Slack | incoming webhook URL |
| Lark / Feishu | custom bot webhook URL (`open.larksuite.com` or `open.feishu.cn`), optional signing secret |
| Webhook | URL (receives a JSON POST) |
| Telegram | bot token + chat ID |
| PagerDuty | Events API v2 routing key (trigger on open, resolve on recovery) |
| Email | recipient address (sent via Cloudflare Email Service; logged to the console without the `EMAIL` binding / `EMAIL_FROM`) |

## Analytics (Plausible)

Off by default. Set these on the web Worker (`vars` in `apps/web/wrangler.jsonc`, or the process environment in Docker) and every page — landing, docs, app, status pages — starts reporting, no rebuild needed:

| Variable | Meaning |
|---|---|
| `PLAUSIBLE_DOMAIN` | the site to report to (`data-domain`; several may be comma-separated). Unset = no script is loaded. |
| `PLAUSIBLE_SRC` | where the script comes from. Defaults to `https://plausible.io/js/script.js`; for self-hosted Plausible use e.g. `https://stats.example.com/js/script.js`. |

Pages load `/ou-analytics.js`, which injects the Plausible script only when `PLAUSIBLE_DOMAIN` is set. If you turn it on, update the privacy page, which says there are no third-party analytics scripts.

## Language & theme

The app ships English and 简体中文 (switcher in the sidebar; stored in the `ou_lang` cookie, defaults to the browser language).
Light/dark is toggled from the same place. To add strings, wrap them with `t()` and add the translation to `apps/web/src/lib/zh.ts`.

## Tests & CI

```bash
DATABASE_URL=postgres://… pnpm --filter @openuptime/api test   # scheduler integration tests (skipped without a DB)
pnpm --filter @openuptime/web test       # web unit tests (routes, i18n dictionary, redirect safety)
pnpm typecheck
```

GitHub Actions (`.github/workflows/ci.yml`) runs typecheck, the web build, migrations and the tests against a Postgres service.

## Contributing & security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## License

[MIT](LICENSE)
