import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers";

describe("migration generator rejects unsafe merge artifacts", () => {
  it.each(["timestamp", "index", "snapshot"])("rejects a broken %s sequence", (kind) => {
    const root = mkdtempSync(join(tmpdir(), "ou-migration-order-"));
    try {
      mkdirSync(join(root, "scripts"));
      mkdirSync(join(root, "packages/db-pg/drizzle/meta"), { recursive: true });
      mkdirSync(join(root, "packages/db-pg/src"));
      writeFileSync(join(root, "scripts/gen-migrations.mjs"), readFileSync(join(ROOT, "scripts/gen-migrations.mjs")));
      const entries = [{ idx: 0, when: 10, tag: "0000_first" }, { idx: kind === "index" ? 0 : 1, when: kind === "timestamp" ? 9 : 20, tag: "0001_second" }];
      const meta = join(root, "packages/db-pg/drizzle/meta");
      writeFileSync(join(meta, "_journal.json"), JSON.stringify({ entries }));
      writeFileSync(join(meta, "0000_snapshot.json"), JSON.stringify({ id: "first", prevId: "00000000-0000-0000-0000-000000000000" }));
      writeFileSync(join(meta, "0001_snapshot.json"), JSON.stringify({ id: "second", prevId: kind === "snapshot" ? "another-branch" : "first" }));
      const run = spawnSync(process.execPath, ["scripts/gen-migrations.mjs"], { cwd: root, encoding: "utf8" });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/Invalid migration journal order|Broken migration snapshot chain/);
    } finally { rmSync(root, { recursive: true }); }
  });
});
