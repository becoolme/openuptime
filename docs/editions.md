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

## Routed email recovery

When an edition supplies `allowAlertChannel`, pending routing authorization is stored before delivery starts. Orphaned and interrupted deliveries recheck the policy at their original routing time. Before attempting email quota, the current delivery attempt persists a separate checkpoint. Recovery still authorizes routing but does not spend quota again, so interruption after spending the last email credit cannot turn an unsent alert into a quota skip. A checkpoint failure sends nothing and retries authorization; a stale worker cannot checkpoint a newer claim.

The checkpoint precedes the quota call. A crash in between can leave one email uncharged; an interrupted quota call may also have an unknown result. Recovery favors delivery without a second charge, consistent with the existing fail-open email ledger policy. This is not exactly-once accounting or exactly-once email delivery. Deployments needing exact quota accounting must implement a transactional, delivery-ID-based reservation in their ledger.

### 路由邮件恢复

版本提供 `allowAlertChannel` 时，发送前会持久化待校验的路由状态。孤立或中断的投递恢复时，使用原路由时间重新授权。调用邮件额度服务前，当前投递尝试会单独记录扣额阶段；恢复仍校验路由，但不重复扣额，因此用掉最后一封额度后中断，不会让尚未发送的告警因额度不足而被跳过。阶段写入失败时不发送，并保留授权重试；旧任务不能修改新领取任务的阶段。

阶段记录先于扣额调用，两者之间中断可能少计一封邮件；扣额调用中断时，其结果也可能未知。恢复优先避免再次扣额并继续投递，这与现有邮件账本异常时继续发送的策略一致，不保证精确一次计费或精确一次投递。需要严格额度一致性的部署，应在账本中按投递 ID 实现事务化、幂等的额度预留。
