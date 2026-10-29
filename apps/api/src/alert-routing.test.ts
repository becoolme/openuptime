import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchAlert, retryDeliveries, sendReminders } from "./alerts";
import { unmetered, type Entitlements } from "./entitlements";
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));
vi.mock("./pinnedfetch", () => ({ pinnedFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init) }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });
const at = new Date("2026-10-28T00:00:00Z");
async function run(policy?: Entitlements["allowAlertChannel"], kind: "incident.opened" | "incident.resolved" | "incident.reminder" | "incident.escalated" = "incident.opened", noRows = false, ageSec = 60) {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(at.getTime() + ageSec * 1000));
  const queued: any[] = [], logged: any[] = [], finished: any[] = [];
  const channels = ["one", "two", "off"].map((id) => ({ id, organizationId: "org", projectId: "project", type: "webhook", name: id, enabled: id !== "off", config: { url: `https://hooks.example/${id}` } }));
  const incident = { id: "incident", organizationId: "org", title: "Down", resolvedAt: null };
  const monitor = { id: "monitor", projectId: "project", name: "API", target: "https://example.com" };
  const repo = {
    listProjects: async () => [], channelsToAlert: async () => channels,
    logDeliveries: async (rows: any[]) => { logged.push(...rows); },
    queueDeliveries: async (rows: any[]) => { queued.push(...rows); return noRows ? [] : rows.map((r) => ({ ...r, id: r.channelId })); },
    claimDelivery: async (id: string) => ({ id, kind, attempts: 0, createdAt: at }), subscribersFor: async () => [],
    finishDelivery: async (id: string, result: any) => { finished.push({ id, ...result }); },
    claimRetries: async () => finished.filter((r) => r.status === "failed").map((r) => ({
      delivery: { ...r, organizationId: "org", kind, attempts: 1, createdAt: at },
      incident, monitor, channel: channels.find((c) => c.id === r.id),
    })),
  } as never;
  const fetch = vi.fn().mockImplementation(async () => new Response("{}")); vi.stubGlobal("fetch", fetch);
  await dispatchAlert(repo, "org", { kind, incident, monitor }, [], { ...unmetered, allowAlertChannel: policy });
  return { repo, queued, logged, finished, fetch };
}
describe("alert routing policy", () => {
  it.each(["incident.opened", "incident.resolved", "incident.reminder", "incident.escalated"] as const)("selects eligible recipients for %s and records exclusions", async (kind) => {
    const policy = vi.fn(async (_org: string, input: { channelId: string }) => input.channelId === "two");
    const result = await run(policy, kind);
    expect(result.queued.every((r) => r.error === "alert routing policy unavailable")).toBe(true);
    expect(result.finished.filter((r) => r.status === "sent").map((r) => r.id)).toEqual(["two"]);
    expect(policy).toHaveBeenCalledWith("org", { projectId: "project", monitorId: "monitor", incidentId: "incident", kind, at, channelId: "one" });
    expect(result.finished).toContainEqual(expect.objectContaining({ id: "one", status: "skipped", message: "skipped: not selected by alert routing policy" }));
    expect(result.logged).toContainEqual(expect.objectContaining({ channelId: "off", statusMessage: "skipped: channel disabled" }));
    expect(policy).toHaveBeenCalledTimes(2);
  });
  it("keeps default routing without a policy", async () => {
    expect((await run()).finished.filter((r) => r.status === "sent").map((r) => r.id)).toEqual(["one", "two"]);
  });
  it.each([{ allowed: false }, "true", 1, null, undefined])("rejects non-boolean policy approval %j", async (value) => {
    const result = await run(async () => value as never);
    expect(result.fetch).not.toHaveBeenCalled();
    expect(result.finished.every((r) => r.status === "skipped")).toBe(true);
  });
  it("retains unavailable decisions for retry, without leaking errors or sending before authorization", async () => {
    const result = await run(async () => { throw new Error("secret token"); });
    expect(result.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result.finished)).not.toContain("secret token");
    expect(result.finished).toContainEqual(expect.objectContaining({ status: "failed", error: "alert routing policy unavailable", retryInSec: 120, keepAttempts: true }));
    const policy = vi.fn(async (_org: string, input: { channelId: string }) => input.channelId === "two");
    await retryDeliveries(result.repo, 10, { ...unmetered, allowAlertChannel: policy });
    expect(result.fetch).toHaveBeenCalledTimes(1);
    expect(policy).toHaveBeenCalledWith("org", expect.objectContaining({ at, channelId: "two" }));
    expect(result.finished).toContainEqual(expect.objectContaining({ id: "one", status: "skipped" }));
    expect(result.finished).toContainEqual(expect.objectContaining({ id: "two", status: "sent" }));
  });
  it("keeps pending decisions closed when the policy is removed", async () => {
    const result = await run(async () => { throw new Error("unavailable"); });
    await retryDeliveries(result.repo);
    expect(result.fetch).not.toHaveBeenCalled();
    expect(result.finished.slice(-2).every((r) => r.status === "failed")).toBe(true);
  });
  it("logs the cause of a policy failure on the server only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await run(async () => { throw new Error("secret token"); });
    expect(log.mock.calls.flat().some((a) => a instanceof Error && a.message === "secret token")).toBe(true);
    expect(JSON.stringify(result.finished)).not.toContain("secret token");
  });
  it("does not spend the attempt budget while the policy is down, and gives up after the window", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const waiting = await run(async () => { throw new Error("down"); });
    expect(waiting.finished.every((r) => r.status === "failed" && r.keepAttempts === true && r.retryInSec === 120)).toBe(true);
    const old = await run(async () => { throw new Error("down"); }, "incident.opened", false, 7 * 3600);
    expect(old.finished.every((r) => r.status === "failed" && r.retryInSec === null && !r.keepAttempts && /gave up after 6 hours/.test(r.message))).toBe(true);
  });
  it("records a failed delivery when a policy failure meets a missing delivery row", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await run(async () => { throw new Error("down"); }, "incident.opened", true);
    expect(result.fetch).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().some((a) => typeof a === "string" && a.includes("ALERT NOT SENT"))).toBe(true);
    expect(result.logged.filter((r) => r.status === "failed").map((r) => r.channelId).sort()).toEqual(["one", "two"]);
    const denied = await run(async () => false, "incident.opened", true);
    expect(denied.logged.filter((r) => r.status === "skipped" && r.error.includes("routing policy")).length).toBe(2);
  });
  it("applies the policy to repeat alerts", async () => {
    const channel = { id: "push1", organizationId: "org", projectId: "project", type: "webhook", name: "push", enabled: true, config: { url: "https://hooks.example/p" } };
    const incident = { id: "incident", organizationId: "org", title: "Down", resolvedAt: null };
    const monitor = { id: "monitor", projectId: "project", name: "API", target: "https://example.com" };
    const queued: any[] = [], finished: any[] = [];
    const repo = {
      listProjects: async () => [], underMaintenance: async () => false,
      claimReminders: async () => [{ incident, monitor, project: { reminderEmail: false }, number: 1 }],
      channelsToAlert: async () => [{ ...channel, type: "push" }], logDeliveries: async () => {},
      queueDeliveries: async (rows: any[]) => { queued.push(...rows); return rows.map((r) => ({ ...r, id: "d1" })); },
      claimDelivery: async (id: string) => ({ id, kind: "incident.reminder", attempts: 0, createdAt: at }),
      finishDelivery: async (id: string, r: any) => { finished.push({ id, ...r }); }, subscribersFor: async () => [],
    } as never;
    const policy = vi.fn(async () => false);
    expect(await sendReminders(repo, { ...unmetered, allowAlertChannel: policy })).toBe(1);
    expect(policy).toHaveBeenCalledWith("org", expect.objectContaining({ kind: "incident.reminder", channelId: "push1" }));
    expect(queued[0].error).toBe("alert routing policy unavailable");
    expect(finished).toContainEqual(expect.objectContaining({ status: "skipped", message: "skipped: not selected by alert routing policy" }));
  });
});
