import { createHash } from "node:crypto";

/** Validate the exact applied prefix before executing or skipping migration SQL. */
export function validateMigrationHistory(migrations, applied) {
  let previous = -1;
  const tags = new Set();
  for (const m of migrations) {
    if (!Number.isSafeInteger(m.when) || m.when <= previous || tags.has(m.tag)) throw new Error("Invalid migration order: regenerate migrations against the current base");
    previous = m.when;
    tags.add(m.tag);
  }
  if (applied.length > migrations.length) throw new Error("Database migration history is ahead of this build");
  for (let i = 0; i < applied.length; i++) {
    const m = migrations[i];
    if (applied[i].created_at === null || Number(applied[i].created_at) !== m.when || applied[i].hash !== createHash("sha256").update(m.sql).digest("hex")) throw new Error(`Database migration history diverges at ${m.tag}; restore the applied history and regenerate pending migrations against the current base`);
  }
  return migrations.slice(applied.length);
}
