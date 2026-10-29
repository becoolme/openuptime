// Applies drizzle migrations without CREATE SCHEMA, for hosted Postgres users that lack
// database-level CREATE privilege (drizzle's own migrator always issues CREATE SCHEMA IF NOT EXISTS).
// Keeps the same bookkeeping table format, in the public schema.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { validateMigrationHistory } from "./src/migration-history.mjs";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
// --check: read-only dry run. Validates the applied history against this build and lists what would be
// applied, without creating tables or running any migration SQL.
const checkOnly = process.argv.includes("--check");
const sql = postgres(url, { max: 1 });
const journal = JSON.parse(readFileSync("./drizzle/meta/_journal.json", "utf8"));

const migrations = journal.entries.map((e) => ({ ...e, sql: readFileSync(`./drizzle/${e.tag}.sql`, "utf8") }));
try {
  if (checkOnly) {
    const pending = await sql.begin("read only", async (tx) => {
      const [{ t }] = await tx`select to_regclass('public.__drizzle_migrations')::text as t`;
      const history = t ? await tx`select created_at, hash from public.__drizzle_migrations order by id` : [];
      return validateMigrationHistory(migrations, history);
    });
    for (const e of pending) console.log("would apply", e.tag);
    console.log("history ok");
    process.exit(0);
  }
  const applied = await sql.begin(async (tx) => {
    const tags = [];
    await tx`select pg_advisory_xact_lock(hashtext('openuptime:migrate'))`;
    await tx`create table if not exists public.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
    const history = await tx`select created_at, hash from public.__drizzle_migrations order by id`;
    for (const e of validateMigrationHistory(migrations, history)) {
      for (const stmt of e.sql.split("--> statement-breakpoint")) if (stmt.trim()) await tx.unsafe(stmt);
      await tx`insert into public.__drizzle_migrations (hash, created_at) values (${createHash("sha256").update(e.sql).digest("hex")}, ${e.when})`;
      tags.push(e.tag);
    }
    return tags;
  });
  for (const tag of applied) console.log("applied", tag);
  console.log("up to date");
} finally { await sql.end(); }
