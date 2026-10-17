import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers";

describe("embedded migrations", () => {
  it("match the SQL files drizzle generated (run `node scripts/gen-migrations.mjs` after `pnpm db:generate`)", () => {
    const run = spawnSync(process.execPath, ["scripts/gen-migrations.mjs", "--check"], { cwd: ROOT, encoding: "utf8" });
    expect(run.stderr + run.stdout).toContain("in sync");
    expect(run.status).toBe(0);
  });
});
