import type { Repo } from "@openuptime/repo";
import { describe, expect, it } from "vitest";
import { dispatchAlert } from "./alerts";
import { unmetered, type Entitlements } from "./entitlements";

const channel = { id: "ch1", organizationId: "org", projectId: null, type: "email", name: "Ops", enabled: true, config: { to: "ops@example.com" } };

/** Just enough repo for one email channel and two status-page subscribers. */
function fakeRepo() {
  const logged: Record<string, unknown>[] = [];
  const repo = {
    channelsToAlert: async () => [channel],
    ownerLocale: async () => "en",
    localeByEmail: async () => null,
    subscribersFor: async () => [
      { email: "a@example.com", locale: "en", token: "t1", slug: "s", title: "S" },
      { email: "b@example.com", locale: "en", token: "t2", slug: "s", title: "S" },
    ],
    queueDeliveries: async (rows: Record<string, unknown>[]) => rows.map((r, i) => ({ ...r, id: `d${i}`, attempts: 0, status: "pending" })),
    claimDelivery: async (id: string) => ({ id, kind: "incident.opened", attempts: 0 }),
    finishDelivery: async (id: string, r: Record<string, unknown>) => void logged.push({ id, ...r }),
    logDeliveries: async (rows: Record<string, unknown>[]) => void logged.push(...rows),
  } as unknown as Repo;
  return { repo, logged };
}

const ev = { kind: "incident.opened" as const, incident: { id: "i1", title: "Down" }, monitor: { id: "m1", name: "Site", target: "https://example.com" } };

describe("email allowance", () => {
  it("skips email alerts and subscriber mails once the allowance is used up, and records why without a retry", async () => {
    const { repo, logged } = fakeRepo();
    const none: Entitlements = { ...unmetered, spendEmails: async () => 0 };
    await dispatchAlert(repo, "org", ev, [], none);
    expect(logged).toHaveLength(2);
    for (const row of logged) {
      expect(row).toMatchObject({ status: "skipped" });
      expect(String(row.error)).toMatch(/^skipped:/);
      expect(String(row.message ?? row.statusMessage)).toMatch(/^skipped:/);
      expect(row.retryInSec).toBeUndefined();
    }
  });

  it("counts one email per alert plus one per subscriber", async () => {
    const { repo } = fakeRepo();
    const asked: number[] = [];
    const counting: Entitlements = { ...unmetered, spendEmails: async (_w, n) => (asked.push(n), n) };
    await dispatchAlert(repo, "org", ev, [], counting);
    expect(asked.sort()).toEqual([1, 2]);
  });
});
