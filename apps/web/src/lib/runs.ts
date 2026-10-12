import type { CheckResult } from "./api";

/** One scheduled check: the rows a monitor recorded at the same moment, one per region. */
export type Run = {
  at: string;
  rows: CheckResult[];
  okCount: number;
  /** Mean latency of the rows that have one, rounded; null when none do. */
  latencyMs: number | null;
  /** up: every region answered ok, down: none did, degraded: some did. */
  state: "up" | "degraded" | "down";
};

/**
 * Newest-first rows into runs. A multi-region check is written in one statement, so its rows share `checkedAt`;
 * a region's row inside a run follows `order` (the monitor's own region order), regions not listed come last.
 */
export function groupRuns(results: CheckResult[], order: string[] = []): Run[] {
  const rank = (r: CheckResult) => {
    const i = order.indexOf(r.region ?? "auto");
    return i === -1 ? order.length : i;
  };
  const runs: Run[] = [];
  let rows: CheckResult[] = [];
  const flush = () => {
    if (!rows.length) return;
    const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
    const okCount = sorted.filter((r) => r.ok).length;
    const lat = sorted.map((r) => r.latencyMs).filter((v): v is number => typeof v === "number");
    runs.push({
      at: sorted[0].checkedAt,
      rows: sorted,
      okCount,
      latencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      state: okCount === sorted.length ? "up" : okCount === 0 ? "down" : "degraded",
    });
    rows = [];
  };
  for (const r of results) {
    if (rows.length && rows[0].checkedAt !== r.checkedAt) flush();
    rows.push(r);
  }
  flush();
  return runs;
}
