import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Repo } from "@openuptime/repo";
import { notifyIncidentUpdate } from "./alerts";
import { actionEmail, configureEmail, setMailTransport } from "./email";
import { unmetered, type Entitlements } from "./entitlements";

const sent: { fromName: string; to: string; html: string; text: string }[] = [];
const target = (email: string, hideBranding: boolean) => ({ email, locale: "en", token: `t-${email}`, slug: "acme", title: "Acme Status", hideBranding });
const repo = {
  subscribersFor: async () => [target("hidden@example.com", true), target("shown@example.com", false)],
} as unknown as Repo;
const update = { status: "investigating", body: "Looking into it" };
const inc = { organizationId: "org", monitorId: "m1", title: "API errors" };

beforeEach(() => {
  configureEmail({ EMAIL_FROM: "alerts@example.com", WEB_ORIGIN: "https://app.example.com" } as never);
  setMailTransport(async (m) => void sent.push(m));
  sent.length = 0;
});
afterEach(() => setMailTransport(undefined));

describe("white-labelled mail", () => {
  it("replaces the OpenUptime header and sender with the brand name", () => {
    const mail = actionEmail({ title: "T", body: "B", cta: "Open", url: "https://x.test", brand: "Acme Status" });
    expect(mail.html).toContain("Acme Status");
    expect(mail.html).not.toContain("logo-mark.png");
    expect(actionEmail({ title: "T", body: "B", cta: "Open", url: "https://x.test" }).html).toContain("logo-mark.png");
  });

  it("sends subscriber mail under the page title when the page hides the brand and the plan allows it", async () => {
    await notifyIncidentUpdate(repo, inc, update, unmetered);
    expect(sent.find((m) => m.to === "hidden@example.com")).toMatchObject({ fromName: "Acme Status" });
    expect(sent.find((m) => m.to === "hidden@example.com")!.html).not.toContain("logo-mark.png");
    expect(sent.find((m) => m.to === "shown@example.com")).toMatchObject({ fromName: "Acme Status via OpenUptime" });
  });

  it("keeps the OpenUptime brand for everyone when the plan does not include hiding it", async () => {
    const basic: Entitlements = { ...unmetered, plan: async () => ({ id: "basic", name: "Basic", maxActiveMonitors: 1, minIntervalSec: 60, hideBranding: false }) };
    await notifyIncidentUpdate(repo, inc, update, basic);
    expect(sent.map((m) => m.fromName)).toEqual(["Acme Status via OpenUptime", "Acme Status via OpenUptime"]);
  });
});
