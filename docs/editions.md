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
