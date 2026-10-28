import { afterEach, describe, expect, it, vi } from "vitest";
import { deliver } from "./alerts";
import { maskConfig, restoreConfig, MASK } from "./secrets";
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));
vi.mock("./pinnedfetch", () => ({ pinnedFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init) }));
const channel = { type: "ntfy", config: { url: "https://ntfy.example.com", topic: "ops", token: "test-token", priority: "4" } };
const event = { kind: "incident.opened" as const, incident: { id: "i1", title: "Down" }, monitor: { name: "API", target: "https://example.com" } };
afterEach(() => vi.unstubAllGlobals());
describe("ntfy delivery", () => {
  it.each(["incident.opened", "incident.resolved", "incident.reminder", "incident.escalated"] as const)("publishes %s with auth and priority", async (kind) => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetch);
    await deliver(channel, { ...event, kind }, "API changed");
    const [, init] = fetch.mock.calls[0];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
    expect(JSON.parse(init.body)).toEqual({ topic: "ops", message: "API changed", title: "OpenUptime", priority: 4 });
  });
  it("truncates UTF-8 messages safely and defaults priority without a token", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetch);
    await deliver({ type: "ntfy", config: { url: channel.config.url, topic: "ops" } }, event, "😀".repeat(2000));
    const [, init] = fetch.mock.calls[0]; const body = JSON.parse(init.body);
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(body.priority).toBe(3);
    expect(new TextEncoder().encode(body.message).length).toBeLessThanOrEqual(4096);
    expect(body.message.endsWith("…")).toBe(true);
    expect(body.message).not.toContain("�");
  });
  it("does not redirect a token to another host", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 307, headers: { location: "https://other.example/" } })); vi.stubGlobal("fetch", fetch);
    await expect(deliver(channel, event, "Down")).rejects.toThrow("HTTP 307");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([401, 429, 500])("rejects HTTP %s without reflecting provider content", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("test-token", { status })));
    await expect(deliver(channel, event, "Down")).rejects.toThrow(`ntfy.example.com responded HTTP ${status}`);
  });
  it("masks stored access tokens and restores placeholders", () => {
    expect(maskConfig(channel.config).token).toBe(MASK);
    expect(restoreConfig({ token: MASK }, channel.config).token).toBe("test-token");
  });
});
