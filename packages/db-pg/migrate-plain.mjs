// Applies drizzle migrations without CREATE SCHEMA, for hosted Postgres users that lack
// database-level CREATE privilege (drizzle's own migrator always issues CREATE SCHEMA IF NOT EXISTS).
// Keeps the same bookkeeping table format, in the public schema.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const sql = postgres(url, { max: 1 });
const journal = JSON.parse(readFileSync("./drizzle/meta/_journal.json", "utf8"));

await sql`create table if not exists public.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
const [last] = await sql`select created_at from public.__drizzle_migrations order by created_at desc limit 1`;
const lastAt = last ? Number(last.created_at) : -1;

for (const e of journal.entries) {
  if (e.when <= lastAt) continue;
  const text = readFileSync(`./drizzle/${e.tag}.sql`, "utf8");
  await sql.begin(async (tx) => {
    for (const stmt of text.split("--> statement-breakpoint")) if (stmt.trim()) await tx.unsafe(stmt);
    await tx`insert into public.__drizzle_migrations (hash, created_at) values (${createHash("sha256").update(text).digest("hex")}, ${e.when})`;
  });
  console.log("applied", e.tag);
}
console.log("up to date");
await sql.end();
