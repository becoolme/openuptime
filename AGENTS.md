# Working in this repository

Guidance for coding agents and for people. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup and the checks to run; this
file adds the rules a change has to follow.

## Every fix and feature goes into the changelog

A change that a user, an operator or an API client can notice **must add a changelog entry in the same commit**. The
changelog is the page at `/changelog`, and it is the only place we record what changed.

Needs an entry:

- a new feature, monitor type, setting, API endpoint, integration or documentation page of its own;
- a fix for behavior someone could see: wrong results, broken screens, errors, bad defaults;
- a change to limits, defaults, pricing or plan contents, or to how something is deployed or configured;
- a security fix, described at the level a user needs ("private targets are refused by default"), never with detail that
  helps an attacker. Vulnerabilities themselves follow [SECURITY.md](SECURITY.md).

Does not need one: refactors, tests, CI and tooling, comment or typo fixes, internal documentation, and follow-up commits
that only finish a feature whose entry already exists.

### Where entries live

| Change | File | List |
| --- | --- | --- |
| Ships in the open-source (Community) edition, and therefore in Cloud too | `apps/web/src/lib/changelog.ts` | `COMMUNITY_ENTRIES` |
| Exists only in the hosted (Cloud) edition | `apps/web/src/lib/changelog-cloud.ts` | `CLOUD_ENTRIES` |

`main` holds the Community edition. `CLOUD_ENTRIES` is empty there and is filled on the hosted branch, which merges
`main` and never the other way round. Write a Community entry on `main` first; the hosted branch inherits it.

When a Community change behaves differently on the hosted service (plan limits, hosted regions, hosted-only defaults),
keep one Community entry and describe the hosted difference in its `cloud` field. Do not duplicate it as a Cloud entry.

### Entry format

```ts
{
  id: "multi-region-checks",            // kebab-case, unique across both lists; it is the page anchor
  date: "2026-10-12",                   // YYYY-MM-DD, the day the change was merged
  edition: "community",                 // "community" or "cloud"
  title: { en: "Check from several regions", zh: "多区域检测" },
  summary: { en: "One sentence on what this gives the reader.", zh: "…" },
  points: [                             // 1 to 5 bullets, each one sentence
    { en: "What they can now do, or what no longer goes wrong.", zh: "…" },
  ],
  cloud: { en: "What this means on the hosted service.", zh: "…" },   // optional, Community entries only
  link: { href: "/docs/regions", label: { en: "Read the multi-region docs", zh: "阅读多区域检测文档" } }, // optional
}
```

Writing rules:

- **Both languages are required.** Every `L` has `en` and `zh`, written natively, not word for word. The test fails on a
  missing one.
- **Say what changed for the reader**, in plain words: "Switch workspace without reloading the page", not "refactor
  workspace context". No file names, function names or commit hashes.
- **Title** is a short noun phrase or verb phrase, 2 to 6 words, no trailing period. **Summary** is one sentence.
- **One entry per user-facing change.** Several fixes in one area on the same day share one entry ("Smaller
  improvements" is the catch-all for loose ends). A follow-up fix to a feature shipped the same day goes into that
  entry's `points`; later it gets its own entry.
- **State only what is true.** Numbers, limits and regions come from the code or the docs. No marketing adjectives, no
  promises about the future.
- **Add the entry at the top of its list.** The page sorts by date, newest first, and keeps list order within a day.
- Link to the relevant docs page when there is one. Links are site paths (`/docs/...`), not absolute URLs.
- Never put secrets, customer names, internal hostnames or incident detail in an entry.

Check your entry with `pnpm --filter @openuptime/web test`: it verifies unique ids, real dates and both languages. To see
it, build the web app and open `/changelog`.

## Other conventions

- **UI strings** go through `t()` with a Chinese translation in `apps/web/src/lib/zh.ts`. Docs pages carry both
  languages in the markup.
- **Tests** sit next to the code they cover. Run the checks listed in CONTRIBUTING before committing.
- **A rule that has bitten us gets a test.** When a mistake slips through (an undocumented variable, a stale embedded
  migration, hosted code on `main`), add a check for it rather than a reminder here. Repo-wide checks live in
  `apps/api/src/guards/`.
- **Environment variables** are documented in `.env.example`, `.env.docker.example` and `docker-compose.yml`; the guard
  tests fail when they and the code disagree.
- **Hosted-edition code** (`apps/api/src/cloud/`, `worker.cloud.ts`, `wrangler.cloud.jsonc`, `apps/web/edge/`) never
  appears on `main`; nothing there may import from it.
- **Migrations**: change the schema in `packages/db-pg/src/`, run `pnpm db:generate`, then
  `node scripts/gen-migrations.mjs`. Merge schema PRs one at a time. After another schema PR merges, rebase
  the remaining PR on the new base, retain its schema edits, remove only its unapplied generated artifacts,
  and regenerate SQL, journal and snapshots. Never just renumber files or timestamps: timestamp order and the
  snapshot `prevId` chain must match deployed history. Never alter a migration already applied to a database.
- **Commits**: an imperative subject that says what the change does, a body that says why when it is not obvious. Do not
  add attribution or "generated by" lines to commit messages or pull request descriptions. Stage files explicitly
  rather than with `git add -A`.
- **Security contact** for reports: `hi@openuptime.app`. Never put real credentials, tokens or customer data in the
  repository, tests or fixtures.
