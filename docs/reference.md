# Reference

Details that do not fit the README. For deployment guides see the [docs](https://openuptime.app/docs/self-host).

## Email

Email (invitations, password reset, alerts, status page subscriptions) is optional. Set `EMAIL_FROM` plus one of:
`RESEND_API_KEY` (Resend, sender on a verified domain), `SMTP_URL` (`smtps://user:pass@host:465`; URL-encode special
characters) or `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` (`SMTP_SECURE=true` for implicit TLS on 465,
otherwise STARTTLS). The connection is verified at startup and logged. Without it, emails are written to the log.
On Cloudflare Workers, email goes through Cloudflare Email Sending: onboard the sending domain, then set `EMAIL_FROM`
in `apps/api/wrangler.jsonc`.

## Docker

- **Scaling**: checks are leased with `FOR UPDATE SKIP LOCKED`, so several containers can run against one database.
- **Prebuilt image**: tagged releases are published to `ghcr.io/becoolme/openuptime` by `.github/workflows/docker.yml`.
  To use one, set `OPENUPTIME_IMAGE` in `.env` (for example `ghcr.io/becoolme/openuptime:0.1.0`, or `:latest`), then
  run `docker compose pull && docker compose up -d`. Without it the compose file builds from source.

## Cloudflare Free plan

The Queue needs the Workers Paid plan. To run on the Free plan, delete the `queues` block from `apps/api/wrangler.jsonc`
and skip `wrangler queues create`: the minute cron then runs up to 40 monitors inline.

## How checks run

1. A Cron Trigger fires every minute (`* * * * *`, minimum interval: 60s).
2. It atomically leases due monitors (`UPDATE … FOR UPDATE SKIP LOCKED`), so overlapping runs never duplicate work.
3. Leased monitors are packed 25 per message into the `openuptime-checks` Queue.
4. The queue consumer (same Worker) runs each pack with its own invocation budget, writes results, opens and resolves incidents, and fans out alerts (Slack, Lark / Feishu, webhook, Telegram, PagerDuty, email).

Without a bound queue (local dev, or `POST /internal/run-checks` with `x-cron-secret`), checks run inline.

### Which targets a check may reach

Monitors and alert webhooks may only point at public addresses. Literal IPs in private, loopback, link-local (cloud
metadata) and other reserved ranges, names that can only be internal (`localhost`, `*.local`, `*.internal`, single-label
names such as a compose service) and, on Node, names that resolve to such an address are refused: when a monitor or
channel is saved (HTTP 400, `target_not_allowed`) and again on every check, including each redirect hop. Set
`ALLOW_PRIVATE_TARGETS=true` to monitor internal services; do it only when you trust every account on the instance.
Cloudflare Workers cannot reach private ranges in any case. `CHECK_USER_AGENT` overrides the User-Agent of HTTP checks. `SELFCHECK_URLS` (comma-separated URLs) replaces the public
sites a failed check fetches to tell a down target from an offline checker; an empty value turns that check off. Targets
that resolve to private addresses skip it.

Sign-in, sign-up, two-step and password-reset endpoints are rate limited per client address and per email address. On
Cloudflare the client address is the edge's; in Docker it is known only with `TRUST_PROXY=true` (exactly one reverse
proxy in front, appending `X-Forwarded-For`); without it only the per-email limits apply.

## Accounts & teams

- Workspaces with projects, members and roles; invitations expire after `INVITE_TTL_DAYS` (default 7). Set `DISABLE_SIGNUP=true` to close registration (invited people can still join).
- Set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` (a [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) widget) to require a verified challenge on email sign-up: the form shows the widget and the API checks the token. Both must be set; GitHub sign-in is not covered.
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
- **Multi-region checks** (HTTP, TCP and WebSocket only): run `apps/probe` in several places (the Docker image or any Node host, or Vercel functions) and set `PROBE_REGIONS` (JSON of region id → URL) and `PROBE_SECRET` on the API. A monitor checks from its own location (`auto`) unless you pick regions for it, up to the plan's limit. A run fails when most of the regions that answered failed; an unreachable probe is left out of the vote, and when none answers the check runs locally. Each region counts as one check. `GET /api/regions` lists what is available, and `POST /api/monitors/:id/check` with `{ "region": "…" }` sends one unrecorded request from that region. See `apps/probe/README.md` and the docs page at `/docs/regions`.
- Not supported on Workers: TLS certificate expiry (the runtime does not expose certificates).

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

Pages load `/ou-analytics.js`, which injects the Plausible script only when `PLAUSIBLE_DOMAIN` is set. If you turn it on, say so in your privacy page: the bundled `/privacy` text describes the hosted service at openuptime.app, so replace it with your own anyway.

## Language & theme

The app ships English and 简体中文 (switcher in the sidebar; stored in the `ou_lang` cookie, defaults to the browser language).
Light/dark is toggled from the same place. To add strings, wrap them with `t()` and add the translation to `apps/web/src/lib/zh.ts`.

## Upgrade notes

Behaviour that changed and can surprise an existing install. Run `pnpm db:migrate` (Docker applies migrations on start) before deploying.

- **Private targets are refused.** Monitors and alert webhooks that resolve to private, loopback or link-local addresses fail unless `ALLOW_PRIVATE_TARGETS=true`. Docker users who monitor services on their own network need that setting.
- **Credentials are masked for members.** Channel configs and monitor headers show `••••••••` to non-admins; owners and admins see the real values.
- **Stored request headers are protected.** Changing a monitor's target, method or headers while retaining a stored header value requires an owner or admin; members can replace all headers with their own values or remove them.
- **Authentication endpoints are rate limited** per client address and per email (HTTP 429). Behind a reverse proxy set `TRUST_PROXY=true`, otherwise every visitor shares one address.
- **Secrets are validated at start** in Docker: `BETTER_AUTH_SECRET` and `CRON_SECRET` must not be the `change-me…` placeholder and need at least 16 characters.
- **One automatic incident per monitor and kind.** Migration `0016` merges duplicate open incidents and adds a unique index.
- **iOS push (APNs):** `APNS_KEY` (the `.p8` contents; `\n` accepted), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`; all four enable the `push` channel type and `push.apns` in `GET /api/config`. Devices register through `PUT /api/push/devices`. On Node the sender speaks HTTP/2 through `node:http2`; on Workers `fetch` does.
- **Optional:** `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` (sign-up challenge) and `LEGAL_LINKS` (terms and privacy consent line on sign-up).

## Tests & CI

```bash
pnpm typecheck
pnpm --filter @openuptime/web test                                  # web unit tests (routes, i18n dictionary, redirect safety)
DATABASE_URL=postgres://… pnpm db:migrate                           # a disposable database
DATABASE_URL=postgres://… pnpm --filter @openuptime/db-pg test      # storage tests against that database
TEST_DATABASE_URL=postgres://…/empty_db pnpm --filter @openuptime/api test   # API + scheduler + OAuth/MCP end-to-end tests
```

The API tests that need a database are skipped when `TEST_DATABASE_URL` is unset; it must point at an **empty** database
because the OAuth/MCP end-to-end test applies the migrations itself.

GitHub Actions (`.github/workflows/ci.yml`) runs typecheck, the web build, migrations and the tests against a Postgres service.

### Domain registration expiry

Community `domain` monitors accept an explicit registered domain and `domainExpiryWarnDays` (1–365, default 30). Use a daily interval; intervals are bounded to one hour–one day. RDAP uses IANA bootstrap and registry expiration events, not registrar billing or website availability. Unknown registry dates fail explicitly; confirmed probe-side network faults are inconclusive and never cached or counted. Shared PostgreSQL cache fills serialize by key. Known dates expire after 26 hours but refresh when fewer than 24 hours remain, so effective reuse is about two hours and daily checks normally refetch; unknown registry results cache for fifteen minutes, bootstrap data for 24 hours. Expired entries are never reused as healthy. Calls require public HTTPS, refuse redirects, and cap bodies at 1 MiB. Domain incidents distinguish unknown, near-expiry and passed registration dates and recover after verified renewal. Public status projects unknown dates as unknown and expiry warnings as degraded, excludes registration checks from uptime percentages, and never uses them to suppress dependent service alerts.
