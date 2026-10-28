import type { Repo } from "@openuptime/repo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMaintenanceReminders } from "./alerts";
import { configureEmail, setMailTransport } from "./email";
import { unmetered, type Entitlements } from "./entitlements";

const claim = {
  window: { id: "w1", name: "DB upgrade", startsAt: new Date(Date.now() + 3600_000), endsAt: new Date(Date.now() + 7200_000) },
  page: { id: "p1", organizationId: "org", title: "Acme", slug: "acme", hideBranding: false },
  subscribers: [
    { email: "a@example.com", locale: "en", token: "t1", slug: "acme", title: "Acme", hideBranding: false, monitorIds: [] },
    { email: "b@example.com", locale: "en", token: "t2", slug: "acme", title: "Acme", hideBranding: false, monitorIds: [] },
  ],
};

function fake(allowed = 5) {
  const released: string[] = [];
  const hits = new Map<string, number>();
  const repo = {
    claimMaintenanceReminders: async () => [claim],
    releaseMaintenanceReminder: async (w: string) => void released.push(w),
    withinLimit: async (key: string, limit: number) => {
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return n <= limit;
    },
  } as unknown as Repo;
  const entitlements: Entitlements = { ...unmetered, spendEmails: async (_o: string, n: number) => Math.min(n, allowed) };
  return { repo, released, entitlements };
}

describe("sendMaintenanceReminders", () => {
  beforeEach(() => {
    configureEmail({ EMAIL_FROM: "alerts@example.com", WEB_ORIGIN: "https://app.example.com" } as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => setMailTransport(undefined));

  it("retries a failed policy without sending and still processes later claimed windows", async () => {
    const f = fake();
    const sent: string[] = [];
    setMailTransport(async (mail) => { sent.push(mail.to); });
    const second = { ...claim, window: { ...claim.window, id: "w2" }, subscribers: [{ ...claim.subscribers[0], email: "later@example.com" }] };
    f.repo.claimMaintenanceReminders = async () => [claim, second] as never;
    const spend = vi.fn(async (_org: string, n: number) => n);
    const entitlements = { ...f.entitlements, spendEmails: spend, canNotifySubscriber: async (_org: string, sub: { email: string }) => {
      if (sub.email !== "later@example.com") throw new Error("private policy credential");
      return true;
    } };
    await sendMaintenanceReminders(f.repo, entitlements);
    expect(f.released).toEqual(["w1"]);
    expect(sent).toEqual(["later@example.com"]);
    expect(spend).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("private policy credential"));
  });

  it("bounds policy retries and does not retry an explicit policy denial", async () => {
    const f = fake();
    const sent = vi.fn(); setMailTransport(sent);
    const broken = { ...f.entitlements, canNotifySubscriber: async () => { throw new Error("unavailable"); } };
    for (let i = 0; i < 5; i++) await sendMaintenanceReminders(f.repo, broken);
    expect(f.released).toEqual(["w1", "w1", "w1"]);
    expect(sent).not.toHaveBeenCalled();
    const denied = fake();
    await sendMaintenanceReminders(denied.repo, { ...denied.entitlements, canNotifySubscriber: async () => false });
    expect(denied.released).toEqual([]);
  });

  it("keeps the claim when the plan's email allowance leaves nobody to mail", async () => {
    const f = fake(0);
    await sendMaintenanceReminders(f.repo, f.entitlements);
    expect(f.released).toEqual([]);
  });

  it("keeps the claim when only some mails fail", async () => {
    const f = fake();
    let n = 0;
    setMailTransport(async () => { if (n++ === 0) throw new Error("smtp down"); });
    await sendMaintenanceReminders(f.repo, f.entitlements);
    expect(f.released).toEqual([]);
  });

  it("gives the claim back when every mail fails, but only for three attempts", async () => {
    const f = fake();
    setMailTransport(async () => { throw new Error("smtp down"); });
    for (let i = 0; i < 5; i++) await sendMaintenanceReminders(f.repo, f.entitlements);
    expect(f.released).toEqual(["w1", "w1", "w1"]);
  });
});
