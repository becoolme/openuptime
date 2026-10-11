import { createHash } from "node:crypto";
import type { Db } from "./client";
import { MIGRATIONS } from "./migrations.generated";

/**
 * Applies the embedded drizzle migrations, using the same bookkeeping table as `migrate-plain.mjs`
 * (and no CREATE SCHEMA, so it works for hosted Postgres users without database-level CREATE).
 * Idempotent: already-applied migrations are skipped. Runs in one transaction behind an advisory lock, so instances that
 * start at the same time (or a second /internal/migrate call) wait for each other instead of colliding.
 */
export async function migrate(db: Db, migrations = MIGRATIONS) {
  const sql = db.$client;
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('openuptime:migrate'))`;
    await tx`create table if not exists public.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
    const [last] = await tx`select created_at from public.__drizzle_migrations order by created_at desc limit 1`;
    const lastAt = last ? Number(last.created_at) : -1;
    const applied: string[] = [];
    for (const m of migrations) {
      if (m.when <= lastAt) continue;
      for (const stmt of m.sql.split("--> statement-breakpoint")) if (stmt.trim()) await tx.unsafe(stmt);
      await tx`insert into public.__drizzle_migrations (hash, created_at) values (${createHash("sha256").update(m.sql).digest("hex")}, ${m.when})`;
      applied.push(m.tag);
    }
    return applied;
  });
}
