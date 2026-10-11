import type { Monitor } from "@openuptime/repo";

/**
 * What a workspace may use. The open-source build never limits anything (`unmetered`); the hosted edition passes its
 * own implementation to `createApp` and to the scheduler entry points, so no billing rule lives in this repository.
 *
 * Usage is measured in credits: one check that makes an outbound request is one credit (see `creditCost`).
 */
export interface Entitlements {
  /**
   * Take `credits` for work that is about to run. Resolves with how many were granted, between 0 and `credits`:
   * fewer than asked means the allowance for the current period is used up and the rest must not run.
   */
  spendCredits(workspaceId: string, credits: number): Promise<number>;
  /** The allowance and what is used of it, for display. null when the workspace is not metered. */
  creditBalance(workspaceId: string): Promise<CreditBalance | null>;
}

export type CreditBalance = {
  /** Credits included in the period. */
  limit: number;
  used: number;
  /** The period is [start, end): it starts on the subscription's day of the month and resets at `end`. */
  periodStart: Date;
  periodEnd: Date;
};

/** Self-hosted default: nothing is counted, nothing is refused. */
export const unmetered: Entitlements = {
  spendCredits: async (_workspaceId, credits) => credits,
  creditBalance: async () => null,
};

/**
 * Credits one check costs. A heartbeat monitor makes no request of ours: the app being watched pings us, and
 * evaluating a missed deadline is free, so a workspace is never blinded to a dead cron job because it ran out.
 */
export const creditCost = (m: Pick<Monitor, "type">) => (m.type === "heartbeat" ? 0 : 1);

/** The same day of the month `n` months after `d` (UTC), clamped to the month's end: Jan 31 + 1 month = Feb 28/29. */
function addMonths(d: Date, n: number) {
  const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
  const last = new Date(Date.UTC(new Date(first).getUTCFullYear(), new Date(first).getUTCMonth() + 1, 0)).getUTCDate();
  const t = new Date(first);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

/**
 * The monthly period `now` falls in, counted from the subscription start (`anchor`): a subscription started on the 15th
 * renews on the 15th. Every boundary is computed from the anchor, so a clamped February does not drag later months.
 * Before the anchor it answers the first period.
 */
export function billingPeriod(anchor: Date, now: Date = new Date()): { start: Date; end: Date } {
  let k = Math.max(0, (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + now.getUTCMonth() - anchor.getUTCMonth());
  while (k > 0 && now < addMonths(anchor, k)) k--;
  while (now >= addMonths(anchor, k + 1)) k++;
  return { start: addMonths(anchor, k), end: addMonths(anchor, k + 1) };
}
