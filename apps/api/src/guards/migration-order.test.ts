import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers";

function runGenerator(entries: { idx: number; when: number; tag: string }[], prevOf: (i: number) => string = (i) => (i === 0 ? "00000000-0000-0000-0000-000000000000" : `s${i - 1}`)) {
  const root = mkdtempSync(join(tmpdir(), "ou-migration-order-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "packages/db-pg/drizzle/meta"), { recursive: true });
    mkdirSync(join(root, "packages/db-pg/src"));
    writeFileSync(join(root, "scripts/gen-migrations.mjs"), readFileSync(join(ROOT, "scripts/gen-migrations.mjs")));
    const dir = join(root, "packages/db-pg/drizzle");
    writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ entries }));
    entries.forEach((e, i) => {
      writeFileSync(join(dir, `meta/${String(e.idx).padStart(4, "0")}_snapshot.json`), JSON.stringify({ id: `s${i}`, prevId: prevOf(i) }));
      writeFileSync(join(dir, `${e.tag}.sql`), "select 1;");
    });
    return spawnSync(process.execPath, ["scripts/gen-migrations.mjs"], { cwd: root, encoding: "utf8" });
  } finally { rmSync(root, { recursive: true }); }
}

describe("migration generator accepts valid journals", () => {
  it("accepts a plain journal", () => {
    const run = runGenerator([{ idx: 0, when: 10, tag: "0000_first" }, { idx: 1, when: 20, tag: "0001_second" }]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("accepts a journal whose tags run one behind idx (hosted edition)", () => {
    const run = runGenerator([{ idx: 0, when: 10, tag: "0000_first" }, { idx: 1, when: 20, tag: "0000_offset_a" }, { idx: 2, when: 30, tag: "0001_offset_b" }]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });
});

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
