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

- **HTTP** checks: GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS; optional request bodies up to 16 KiB UTF-8 for methods other than GET/HEAD; expected status, optional keyword (must contain / must not contain), custom request headers (use for bearer/basic auth).
- **TCP**, **DNS**, **Heartbeat** (with a grace period before a missed ping counts as a failure).
- **PostgreSQL**, **MySQL / MariaDB**, **Redis** reachability probes (handshake / `PING`; no credentials are sent).
- **Response-time alerts**: per-monitor "slow" threshold (default 1500 ms) marks a monitor degraded; optionally open a minor incident after N consecutive slow checks.
- **Tags** to group and filter monitors, plus **JSON import / export** (`GET /api/monitors/export`, `POST /api/monitors/import`).
- **Stats** come from an hourly rollup (`check_rollup`), so uptime stays cheap as history grows. Raw check results are kept 90 days by default (Settings → Check history); rollups for a year.
- **Per-monitor alert routing**: pick which channels a monitor notifies; none selected = all.
- **Maintenance windows**: checks continue, but no incidents or alerts for covered monitors.
- **Multi-region checks** (HTTP, TCP and WebSocket only): run `apps/probe` in several places (the Docker image or any Node host, or Vercel functions) and set `PROBE_REGIONS` (JSON of region id → URL) and `PROBE_SECRET` on the API. A monitor checks from its own location (`auto`) unless you pick regions for it, up to the plan's limit. A run fails when most of the regions that answered failed; an unreachable probe is left out of the vote, and when none answers the check runs locally. Each region counts as one check. `GET /api/regions` lists what is available, and `POST /api/monitors/:id/check` with `{ "region": "…" }` sends one unrecorded request from that region. See `apps/probe/README.md` and the docs page at `/docs/regions`.
- Not supported on Workers: TLS certificate expiry (the runtime does not expose certificates).

### Monitor import identity

`POST /api/monitors/import/preview` validates the same array or `{source, monitors}` envelope as execution, without creating monitors. Review per-row warnings, capacity and duplicate status, then send the same data to `POST /api/monitors/import`, with the returned `destination` to guard against changing workspace/project. Each item should have a stable `sourceId` (or `id`) within a source namespace; missing IDs are derived from type/name/target. Import identity is unique within organization/project/source. Repeated and concurrent executions skip identities instead of updating existing monitors. Deletion removes the identity so the row may be imported again. Exports carry provenance, including native monitor IDs. Preview reserves no capacity and execution revalidates. Invalid rows are skipped; plan over-capacity rejects the whole batch. Source channels and dependencies cannot be mapped and produce warnings. Masked credentials and unsupported authentication/body configuration (any field whose name suggests a credential, such as `basic_auth_user` or `oauth_token`) are rejected. A duplicate row reports the monitor that already holds the identity and warns when its name or target differs. Over plan capacity returns 402 with the same `error`, numeric `limit`, `active` and `plan` as creating one monitor, and the batch detail under `capacity`; the destination includes the project name.

## Status page subscriptions

Each public status page offers email subscriptions (double opt-in, one-click unsubscribe link in every mail) and an RSS feed at `/api/public/status/<slug>/rss`. Subscribers are emailed when an incident opens or resolves on a monitor shown on that page. Email goes through the Cloudflare Email Service `send_email` binding (`EMAIL`) and needs `EMAIL_FROM`; without them mails are printed to the log. Past incidents are paginated on the page (`?before=<cursor>`, also `GET /api/public/status/<slug>/incidents`).

## Alert channels

| Type | Config |
| --- | --- |
| Slack | incoming webhook URL |
| Discord | channel webhook URL; create it in the channel’s Integrations settings. Alerts do not trigger mentions. |
| Microsoft Teams | Workflow webhook URL accepting an Adaptive Card message envelope. Use “When a Teams webhook request is received” with “Anyone” authentication; authenticated tenant/user triggers and legacy MessageCard connectors are not supported. A successful delivery means the workflow accepted the request, not that its later posting action completed. |
| ntfy | server origin URL (for example `https://ntfy.sh`), topic, optional bearer access token, priority string `1`–`5` (default `3`). Topic: 1–64 letters, digits, `_` or `-`. Redirects are refused; the public-target network policy applies to self-hosted servers too, so a server on a private address is refused unless private targets are allowed. An access token requires an `https://` server and printable ASCII; an empty token removes it. The topic is masked in API responses. Long messages are truncated below 4096 UTF-8 bytes. Receives outage, recovery and escalation alerts; periodic incident reminders intentionally remain limited to push and project-opted-in email, as with other webhook channels. |
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
- **Stored request headers and bodies are protected.** Changing a monitor's target, method, headers or body while retaining a stored header value or body requires an owner or admin; members can replace all headers with their own values or remove them.
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

## Migration history and concurrent schema PRs

Schema PRs must be merged one at a time. After another schema PR merges, rebase the remaining PR, preserve its schema changes, remove only its unapplied generated SQL/journal/snapshot additions, then run `pnpm db:generate` and `node scripts/gen-migrations.mjs`. Renaming a SQL file or editing a timestamp is insufficient: the snapshot `prevId` chain and timestamp order must follow the current base. Test both a fresh database and an upgrade from the previously deployed version.

Both migration entry points validate that the database's applied timestamps and SQL SHA-256 hashes form an exact prefix of the build's migrations, under the same transaction advisory lock. A divergent or newer history is an error, not a skipped migration. SQL identity is byte-exact, including line endings: do not edit or normalize previously applied SQL. Restore the matching historical files and regenerate only pending migrations; never bypass this error by deleting or manually marking migration history rows.

### Checking a database before deploying

`DATABASE_URL=… pnpm --filter @openuptime/db-pg exec node migrate-plain.mjs --check` runs `validateMigrationHistory` in a read-only transaction. It creates nothing and executes no migration SQL; it prints `would apply <tag>` for each pending migration and `history ok`, or fails with the divergence error. Run it against a copy or restore of production (or production itself with a read-only role) before a deploy. Because the check compares timestamps and SQL hashes in row order, historical rows that were applied out of order will fail it; fix that on a copy first, never by editing the history table on production.

### Transaction limits

`migrate-plain.mjs` and `migrate.ts` apply all pending migrations in one transaction. Consequently `CREATE INDEX CONCURRENTLY` (and other statements that cannot run in a transaction) is not supported, and an enum value added with `ALTER TYPE … ADD VALUE` cannot be used by a later migration in the same run. Ship such changes as separate deploys.

### 迁移历史与并行开发

含数据库变更的 PR 必须逐个合并。每合并一个，其余 PR 应更新到最新基线，保留 schema 修改，仅移除自己尚未部署的生成产物，再执行 `pnpm db:generate` 和 `node scripts/gen-migrations.mjs`。仅改文件编号或时间戳不够，snapshot 的 prevId 链和时间戳顺序必须衔接最新基线；同时验证空库安装与已部署版本升级。

两个迁移入口在同一事务锁下验证数据库历史的时间戳和 SQL SHA-256 是否为当前版本的精确前缀。分叉或数据库历史超前时明确报错，不能静默跳过。SQL 校验包含换行等字节，不能修改已部署的历史文件；应恢复匹配的历史文件并重新生成待部署迁移，不得通过删除或手工标记历史记录绕过错误。

### 部署前检查数据库

`DATABASE_URL=… pnpm --filter @openuptime/db-pg exec node migrate-plain.mjs --check` 在只读事务中运行 `validateMigrationHistory`，不创建任何对象，也不执行迁移 SQL；它会列出 `would apply <tag>` 和 `history ok`，或报告分叉错误。部署前请对生产库的副本（或使用只读角色连接生产库）运行。该检查按行顺序比较时间戳和 SQL 哈希，历史上乱序执行的记录会导致失败；请先在副本上排查，不要直接修改生产库的历史表。

### 事务限制

两个迁移入口都在同一个事务中执行所有待执行迁移，因此不支持 `CREATE INDEX CONCURRENTLY` 等不能在事务内运行的语句，同一次运行中也不能使用 `ALTER TYPE … ADD VALUE` 刚新增的枚举值。这类变更请拆成单独的部署。

### Status distribution policies

Edition implementations may supply `Entitlements.statusPageAccess(page, request)` and `canNotifySubscriber(workspaceId, subscriber)`. The default has neither hook and keeps public behavior. The access hook runs before board/history cache reads on all slug routes, including feeds, badges and subscription creation. Denials return 404; exceptions do not allow access. Deployments with a policy bypass shared caches and use private/no-store responses even for publicly allowed pages. The server-rendered status page forwards the visitor's `cookie` and `authorization` headers and their host in `x-forwarded-host`; the request URL a policy sees is internal (`https://openuptime.internal/...`), so read the host from that header. If the policy itself fails, the page answers 503 `Unavailable` (private, no-store) rather than 404. Token confirmation/unsubscribe routes remain available; subscriber eligibility is rechecked before incident/update/maintenance emails and before spending quota.

These are extension interfaces, not a private-status product. A deployment adding access controls must handle identity/invitations, authorize subscriber email ownership, purge any already-cached public response when enabling the policy, and apply the same policy to its own custom-domain proxies.

The public MCP tools (`/api/mcp/public`, `?via=mcp`) send no credentials, so an access policy sees an anonymous request: a page it protects is refused to those tools unless the policy admits anonymous requests marked `via=mcp`.

Policy approvals must be the boolean `true`; truthy objects or strings are denied. Subscriber checks run in batches of at most eight, and the complete eligibility pass finishes before quota is spent or mail is sent. Automatic incident notification denials and policy failures produce skipped/failed alert-history entries; policy exceptions are logged only as fixed diagnostic categories, never their raw message.

### 状态分发策略

版本实现可以提供 `Entitlements.statusPageAccess(page, request)` 和 `canNotifySubscriber(workspaceId, subscriber)`。默认两者都不设置，保持公开行为。访问策略在所有 slug 路由（包括订阅源、徽章和创建订阅）读取看板或历史缓存之前执行；拒绝返回 404，异常不会放行。启用策略的部署绕过共享缓存，即使页面允许访问也使用 private/no-store。服务端渲染的状态页会转发访客的 `cookie` 和 `authorization` 请求头，以及访客访问的主机（`x-forwarded-host`）；策略看到的请求 URL 是内部地址（`https://openuptime.internal/...`），请从该请求头读取主机。策略本身出错时页面返回 503 `Unavailable`（private, no-store），而不是 404。确认和退订令牌路由仍可使用；发送事件、更新或维护邮件前，以及消耗额度前，会重新检查订阅者资格。

公开 MCP 工具（`/api/mcp/public`，`?via=mcp`）不携带任何凭据，访问策略看到的是匿名请求：除非策略放行带 `via=mcp` 的匿名请求，否则受策略保护的页面对这些工具一律拒绝。

这些只是扩展接口，不是私有状态页产品。增加访问控制的部署需要自行处理身份与邀请、验证订阅邮箱归属、启用策略时清除已缓存的公开响应，并对自己的自定义域名代理应用同一策略。

策略的批准值必须是布尔 `true`，真值对象或字符串一律视为拒绝。订阅者检查每批最多八个，全部资格检查完成后才消耗额度或发送邮件。事件自动通知被拒绝或策略出错时，告警历史会记录为跳过/失败；策略异常只记录固定类别的诊断信息，不记录原始消息。
### Alert routing policies

An edition may implement `Entitlements.allowAlertChannel(workspaceId, input)`. It receives one already-eligible channel ID, project, monitor, incident, event kind and the original delivery time. Return true to deliver or false to record a skipped delivery. A policy cannot add another channel or enable a disabled one. This applies to initial incident/recovery delivery and the existing reminder/escalation paths, after their normal eligibility rules (reminders remain push, plus opted-in email).

Policy exceptions retain a failed delivery and retry every two minutes without using up the normal three-attempt budget, so an outage of the policy does not fail alerts permanently; a delivery older than six hours is given up. The cause of a policy exception is written to the server log only. If a delivery row cannot be created at all there is nothing to retry: the alert is not sent, the loss is logged as `ALERT NOT SENT` and a failed row is recorded when the database allows it. Retries reevaluate pending decisions at the original delivery time and do not send while the policy is unavailable; once authorized, provider retries retain the original recipient without reevaluating routing. Routing failures use a generic reason without provider details. A routing failure is charged no email quota. Subscriber email and direct channel tests are separate. As with existing delivery, if the database cannot create a delivery row there is no durable retry; even the direct-send fallback still checks the policy.

The default has no policy. This is a general interface, not an on-call scheduler; an integration must validate membership/ownership and present empty or unavailable coverage to operators.

Ending a maintenance window and cancelling a series are idempotent: an already ended, missing, or out-of-scope resource is a successful no-op. Success does not imply a row was changed.

结束维护或取消系列是幂等操作：已结束、不存在或不在权限范围内的资源均不作修改并返回成功，成功响应不表示一定修改了记录。
