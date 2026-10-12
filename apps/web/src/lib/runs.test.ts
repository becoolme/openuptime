import { describe, expect, it } from "vitest";
import type { CheckResult } from "./api";
import { groupRuns } from "./runs";

const row = (id: string, checkedAt: string, region: string, ok: boolean, latencyMs: number | null): CheckResult =>
  ({ id, checkedAt, region, ok, latencyMs, statusCode: ok ? 200 : null, error: ok ? null : "boom" });

describe("groupRuns", () => {
  it("keeps one row per run for a single-region monitor", () => {
    const runs = groupRuns([row("2", "t2", "auto", true, 100), row("1", "t1", "auto", false, null)]);
    expect(runs.map((r) => r.rows.length)).toEqual([1, 1]);
    expect(runs.map((r) => r.state)).toEqual(["up", "down"]);
  });
  it("folds rows recorded at the same moment into one run, in the monitor's region order", () => {
    const runs = groupRuns(
      [row("a", "t2", "eu", true, 300), row("b", "t2", "us", true, 100), row("c", "t2", "ap", false, null), row("d", "t1", "us", true, 90)],
      ["us", "eu", "ap"],
    );
    expect(runs).toHaveLength(2);
    expect(runs[0].rows.map((r) => r.region)).toEqual(["us", "eu", "ap"]);
    expect(runs[0]).toMatchObject({ okCount: 2, latencyMs: 200, state: "degraded" });
    expect(runs[1]).toMatchObject({ okCount: 1, latencyMs: 90, state: "up" });
  });
  it("puts regions that are no longer configured last and reports a run nobody answered as down", () => {
    const runs = groupRuns([row("a", "t", "old", false, null), row("b", "t", "us", false, null)], ["us"]);
    expect(runs[0].rows.map((r) => r.region)).toEqual(["us", "old"]);
    expect(runs[0]).toMatchObject({ state: "down", latencyMs: null });
  });
});
