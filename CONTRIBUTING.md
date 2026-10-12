# Contributing

Thanks for helping. Bug reports, fixes, docs and translations are all welcome.

## Setup

```bash
pnpm install
cp .env.example apps/api/.dev.vars   # edit DATABASE_URL and secrets
DATABASE_URL=postgres://user:pass@localhost:5432/openuptime_dev pnpm db:migrate   # same URL as in .dev.vars
pnpm dev:api    # http://localhost:8787
pnpm dev:web    # http://localhost:4321
```

You need Node 22+, pnpm and a Postgres database. See the README for the full picture.

## Before you open a pull request

```bash
pnpm typecheck
pnpm --filter @openuptime/web test
DATABASE_URL=postgres://… pnpm --filter @openuptime/db-pg test            # a migrated, disposable database
TEST_DATABASE_URL=postgres://… pnpm --filter @openuptime/api test         # an empty database (see docs/reference.md)
```

- Keep changes focused; one concern per pull request.
- Add or update tests next to the code you change.
- Match the surrounding style. New UI strings go through `t()` with a translation in `apps/web/src/lib/zh.ts`.
- Schema changes need a migration: edit the schema in `packages/db-pg/src/`, run `pnpm db:generate`, then
  `node scripts/gen-migrations.mjs` so the embedded migrations stay in sync.
- Open an issue first for anything large, so we can agree on the approach.

## Security

Do not file vulnerabilities as public issues; see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is released under the [MIT license](LICENSE).
