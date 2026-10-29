# Editions: open core and the hosted build

OpenUptime is MIT-licensed and everything in this repository works without limits. The hosted service at openuptime.app
adds plans and billing on top **without editing the core**: it plugs in through one interface, `Edition`
(`apps/api/src/edition.ts`).

```ts
interface Edition {
  entitlements(ctx: { database; env }): Entitlements;   // what a workspace may use
  mount?({ app, authed }): void;                         // extra routes (billing, webhooks)
  migrate?(database): Promise<string[]>;                 // the edition's own tables
}
```

`community` (the default) returns `unmetered`: nothing is counted and nothing is refused.

## What the core enforces

The core asks the edition's `Entitlements` and acts on the answer; it knows nothing about prices or payment.

| Question | Where it is asked | Refusal |
| --- | --- | --- |
| `spendCredits` — one credit per check that makes an outbound request | scheduler, manual check | check skipped / `402 credits_exhausted` |
| `plan().maxActiveMonitors` | create, import, resume | `402 monitor_limit` |
| `plan().minIntervalSec` | create, interval change | `402 interval_not_allowed` |
| `spendEmails` — alert emails and status-page subscriber emails | alert dispatch, incident updates | email skipped and logged as `skipped:`; other channels are unaffected |

System mail (verification, password reset, invitations, channel test) is never counted.

`GET /api/usage` returns `{ metered: false }` on a deployment with no plans, and the web app then hides *Plan & usage*.

## Writing an edition

Entry points: `worker.ts` exports `createWorker(edition)`; a hosted build adds its own entry file that calls it, and
its own `wrangler` config. `Database.query` runs SQL against the same connection, so an edition can keep its tables
next to ours without touching `Repo`.

## Request middleware extensions

An edition may supply `requestMiddleware`, a standard `MiddlewareHandler<AppEnv>`. It is registered after the per-request database, repository, auth and entitlements are created, and after CORS, and before every route. This placement covers existing public routes, Better Auth routes, authenticated REST routes, edition routes and MCP transport routes, and also `/health` and the `/internal/*` scheduler and migration routes; check `c.req.path` and return early or call `next()` for the ones you do not want to touch, because a refusal there would block health checks and cron. A response or exception from the hook carries CORS headers; CORS preflight (`OPTIONS`) requests are answered by CORS and never reach the hook. Without the hook, Community behavior is unchanged.

The hook must leave request and response streams usable by downstream handlers. Do not consume `c.req.raw` directly; any strictly necessary, bounded inspection must use a clone and respect the route’s body limits. Prefer route-level validated fields rather than recording raw bodies.

Await `next()` to run downstream middleware and the handler. Afterwards `c.res.status` is the final status produced by Hono's error handling, and `c.get("userId")` / `c.get("orgId")` are available only when the downstream route established that authenticated context. The hook does **not** authenticate callers: public requests and Better Auth's own handlers may have no such context. Never infer identity or authority from arbitrary request headers or path parameters.

Routes that do not run `requireOrg` (including OAuth workspace picking and authorization setup) intentionally have no `requestPrincipal`; a session alone does not establish an authorized workspace.

After `requireOrg` succeeds, `c.get("requestPrincipal")` is a frozen snapshot of verified attribution: `kind` (`session`, `api-key`, or `oauth`), `userId`, the effective `orgId`, `projectId`, `allProjects`, and `projectScope`. API keys include only their non-secret database `credentialId`; OAuth includes the verified `clientId`. No token, key value or session secret is included. Identity, workspace membership and project access must all succeed before this snapshot is set. A later business validation failure can still have a verified principal; an authentication/scope refusal cannot. This records the effective workspace selection, not an untrusted caller-supplied workspace header. In the all-projects view the project ID is a fallback; use `allProjects` and `projectScope` to interpret it.

The outer request middleware closes the database only after this hook returns. Await database writes inside the hook; do not launch detached promises against the request database, including through `waitUntil`, because cleanup may close that connection first. Worker cleanup retains its existing `waitUntil` behavior; Node awaits close normally. Middleware may return early or throw, and request cleanup still runs.

MCP dispatches its tools through nested REST requests, each with its own context, connection and hook invocation. The outer MCP transport's HTTP 200 is not proof of a successful mutation. A future audit implementation must select the actual authorized REST operation, distinguish attempts from committed results, avoid double-counting the transport wrapper, and define what happens if persistence fails. This hook is neither an audit store nor an atomic transaction with domain mutations.

Use route/field allowlists for any logging. Raw URLs can contain heartbeat or subscription tokens; request/response bodies, cookies, authorization headers and arbitrary error strings can contain secrets. This extension adds no request-body capture, logging store, billing or retention policy.

### 请求中间件扩展

版本可以提供标准的 `MiddlewareHandler<AppEnv>` 类型 `requestMiddleware`。它在请求级数据库、仓库、认证及额度对象初始化之后、CORS 之后、所有路由之前注册，因此覆盖公开、Better Auth、已认证 REST、版本扩展及 MCP 路由，也包括 `/health` 和 `/internal/*` 定时任务与迁移路由；不想处理的路径请检查 `c.req.path` 后直接调用 `next()`，否则在这些路由上拒绝请求会阻断健康检查和定时任务。接口返回的响应或抛出的异常会带上 CORS 头；CORS 预检（`OPTIONS`）请求由 CORS 直接应答，不会进入该接口。不配置时 Community 行为保持不变。

接口必须保持请求及响应流可供后续处理器读取，不能直接消耗 `c.req.raw`；确需有限度检查时使用副本并遵守路由正文大小限制，优先读取路由已经验证的字段，不记录原始正文。

未执行 `requireOrg` 的路由（包括 OAuth 工作区选择和授权准备）有意不提供 `requestPrincipal`；仅有登录会话不等于已经验证工作区访问权限。

通过 `await next()` 执行后续处理，再读取 Hono 错误处理后的最终 `c.res.status`。只有后续路由完成认证上下文设置时，`userId` / `orgId` 才存在；公开请求及 Better Auth 自身的处理器可能不设置这些字段。此接口不替代认证，不能根据任意请求头或路径参数认定身份与权限。

`requireOrg` 验证成功后，`requestPrincipal` 是冻结的已验证归因快照，包含认证方式（session/API key/OAuth）、用户、实际工作区、项目、全部项目标记和有效项目范围。API key 只包含非密钥的数据库 ID，OAuth 只包含已验证的 clientId，不包含 token、key 值或 session 密钥。身份、成员资格及项目范围必须全部验证成功才会设置；业务校验失败可以保留已验证主体，认证或范围校验失败不会伪造主体。工作区取实际生效的选择，而非未经验证的请求头。全部项目视图的 projectId 只是回退项目，需结合 allProjects 和 projectScope 理解。

外层中间件在此接口返回后才关闭数据库。数据库写入必须在接口内等待完成，不能对请求数据库启动未等待的 Promise，也不能把这类操作交给 `waitUntil` 后提前返回，否则连接可能已经被关闭。接口提前返回或抛错时仍执行连接清理。

MCP 工具通过内部 REST 请求执行，每次请求都有独立的上下文、连接和接口调用。外层 MCP 的 HTTP 200 不证明变更成功。未来审计应识别实际获授权的 REST 操作、区分尝试与结果、防止重复记录外层传输，并规定持久化失败的行为。此扩展本身不是审计存储，也不与业务变更处于同一原子事务。

日志应使用路由及字段白名单。原始 URL 可能包含心跳或订阅 token；请求/响应正文、Cookie、认证头及任意错误字符串可能包含密钥。此扩展不增加正文采集、日志存储、计费或保留策略。
