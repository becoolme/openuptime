import type { Monitor } from "@openuptime/repo";
import { describe, expect, it } from "vitest";
import { billingPeriod, creditCost, unmetered, type Entitlements } from "./entitlements";
import { withinCredits } from "./scheduler";

const mon = (organizationId: string, type = "http") => ({ id: crypto.randomUUID(), organizationId, type }) as Monitor;
const iso = (d: Date) => d.toISOString();

describe("billingPeriod", () => {
  it("renews on the subscription's day of the month", () => {
    const anchor = new Date("2026-03-15T10:30:00Z");
    const p = billingPeriod(anchor, new Date("2026-05-20T00:00:00Z"));
    expect([iso(p.start), iso(p.end)]).toEqual(["2026-05-15T10:30:00.000Z", "2026-06-15T10:30:00.000Z"]);
  });
  it("starts a new period exactly at the boundary", () => {
    const anchor = new Date("2026-03-15T10:30:00Z");
    expect(iso(billingPeriod(anchor, new Date("2026-04-15T10:29:59Z")).start)).toBe("2026-03-15T10:30:00.000Z");
    expect(iso(billingPeriod(anchor, new Date("2026-04-15T10:30:00Z")).start)).toBe("2026-04-15T10:30:00.000Z");
  });
  it("clamps to the end of short months without drifting afterwards", () => {
    const anchor = new Date("2026-01-31T00:00:00Z");
    const feb = billingPeriod(anchor, new Date("2026-02-10T00:00:00Z"));
    expect([iso(feb.start), iso(feb.end)]).toEqual(["2026-01-31T00:00:00.000Z", "2026-02-28T00:00:00.000Z"]);
    const mar = billingPeriod(anchor, new Date("2026-03-30T00:00:00Z"));
    expect([iso(mar.start), iso(mar.end)]).toEqual(["2026-02-28T00:00:00.000Z", "2026-03-31T00:00:00.000Z"]);
  });
  it("crosses the year and answers the first period before the anchor", () => {
    const anchor = new Date("2026-11-20T00:00:00Z");
    expect(iso(billingPeriod(anchor, new Date("2027-01-05T00:00:00Z")).start)).toBe("2026-12-20T00:00:00.000Z");
    expect(iso(billingPeriod(anchor, new Date("2026-01-01T00:00:00Z")).start)).toBe("2026-11-20T00:00:00.000Z");
  });
});

describe("withinCredits", () => {
  /** A ledger with a fixed allowance per workspace. */
  const ledger = (left: Record<string, number>): Entitlements => ({
    ...unmetered,
    spendCredits: async (w, n) => {
      const g = Math.min(n, left[w] ?? 0);
      left[w] = (left[w] ?? 0) - g;
      return g;
    },
    creditBalance: async () => null,
  });

  it("runs everything when unmetered", async () => {
    const ms = [mon("a"), mon("a"), mon("b")];
    expect(await withinCredits(ms, unmetered)).toEqual(ms);
  });
  it("runs only what the workspace's credits cover, per workspace", async () => {
    const a = [mon("a"), mon("a"), mon("a")];
    const b = [mon("b")];
    const run = await withinCredits([...a, ...b], ledger({ a: 2, b: 5 }));
    expect(run).toEqual([a[0], a[1], b[0]]);
  });
  it("never charges or blocks heartbeat monitors", async () => {
    expect(creditCost({ type: "heartbeat" })).toBe(0);
    const hb = mon("a", "heartbeat");
    expect(await withinCredits([hb, mon("a")], ledger({ a: 0 }))).toEqual([hb]);
  });
  it("keeps monitoring when the ledger fails", async () => {
    const broken: Entitlements = { ...unmetered, spendCredits: async () => { throw new Error("db down"); }, creditBalance: async () => null };
    const ms = [mon("a"), mon("a")];
    expect(await withinCredits(ms, broken)).toEqual(ms);
  });
});
