import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchAlert } from "./alerts";
import { unmetered, type Entitlements } from "./entitlements";
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));
vi.mock("./pinnedfetch", () => ({ pinnedFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init) }));
afterEach(() => vi.unstubAllGlobals());
async function run(policy?: Entitlements["selectAlertChannels"], kind: "incident.opened" | "incident.resolved" | "incident.reminder" | "incident.escalated" = "incident.opened") {
  const queued: any[] = [], logged: any[] = [];
  const channels = ["one", "two", "off"].map((id) => ({ id, organizationId: "org", projectId: "project", type: "webhook", name: id, enabled: id !== "off", config: { url: `https://hooks.example/${id}` } }));
  const repo = {
    listProjects: async () => [], channelsToAlert: async () => channels,
    logDeliveries: async (rows: any[]) => { logged.push(...rows); },
    queueDeliveries: async (rows: any[]) => { queued.push(...rows); return rows.map((r) => ({ ...r, id: r.channelId })); },
    claimDelivery: async () => null, subscribersFor: async () => [],
  } as never;
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await dispatchAlert(repo, "org", { kind, incident: { id: "incident", title: "Down" }, monitor: { id: "monitor", projectId: "project", name: "API", target: "https://example.com" } }, [], { ...unmetered, selectAlertChannels: policy });
  return { queued, logged, fetch };
}
describe("alert routing policy", () => {
  it.each(["incident.opened", "incident.resolved", "incident.reminder", "incident.escalated"] as const)("selects eligible recipients for %s and logs exclusions", async (kind) => {
    const policy = vi.fn(async () => ["two", "two", "other-project", "off"]);
    const result = await run(policy, kind);
    expect(result.queued.map((r) => r.channelId)).toEqual(["two"]);
    expect(policy).toHaveBeenCalledWith("org", { projectId: "project", monitorId: "monitor", incidentId: "incident", kind, at: expect.any(Date), channelIds: ["one", "two"] });
    expect(result.logged).toContainEqual(expect.objectContaining({ channelId: "one", status: "skipped", statusMessage: "skipped: not selected by alert routing policy" }));
    expect(result.logged).toContainEqual(expect.objectContaining({ channelId: "off", statusMessage: "skipped: channel disabled" }));
  });
  it("keeps default routing without a policy", async () => {
    expect((await run()).queued.map((r) => r.channelId)).toEqual(["one", "two"]);
  });
  it("fails closed without exposing policy errors", async () => {
    const result = await run(async () => { throw new Error("secret token"); });
    expect(result.queued).toEqual([]); expect(result.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result.logged)).not.toContain("secret token");
    expect(result.logged).toContainEqual(expect.objectContaining({ statusMessage: "skipped: alert routing policy unavailable" }));
  });
});
