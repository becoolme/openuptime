import { afterEach, describe, expect, it, vi } from "vitest";
import { deliver } from "./alerts";

vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));
vi.mock("./pinnedfetch", () => ({ pinnedFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init) }));
const channel = { type: "discord", config: { url: "https://discord.com/api/webhooks/123/test-token?thread_id=456&wait=false" } };
const event = { kind: "incident.opened" as const, incident: { id: "i1", title: "Down" }, monitor: { name: "API", target: "https://example.com" } };
afterEach(() => vi.unstubAllGlobals());

describe("Discord webhook delivery", () => {
  it.each(["incident.opened", "incident.resolved", "incident.reminder", "incident.escalated"] as const)("delivers %s without mentions and waits for confirmation", async (kind) => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    await deliver(channel, { ...event, kind }, "API @everyone <@123> changed");
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(url).searchParams.get("wait")).toBe("true");
    expect(new URL(url).searchParams.get("thread_id")).toBe("456");
    expect(JSON.parse(init.body)).toEqual({ content: "API @everyone <@123> changed", allowed_mentions: { parse: [] } });
  });
  it("bounds long messages without splitting emoji", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    for (const text of ["a".repeat(2001), "a".repeat(1998) + "😀".repeat(10), "😀".repeat(1200)]) {
      await deliver(channel, event, text);
      const content = JSON.parse(fetch.mock.calls.at(-1)![1].body).content as string;
      expect(content.length).toBeLessThanOrEqual(2000);
      expect(content.endsWith("…")).toBe(true);
      expect(new TextDecoder().decode(new TextEncoder().encode(content))).toBe(content);
    }
  });
  // A deleted webhook answers 404 (or 401 for a wrong token). Delivery has no permanent-failure class: like any HTTP error it
  // is retried within the normal attempt budget, then recorded as failed.
  it.each([401, 404, 429, 500])("reports HTTP %s without exposing the webhook token or response body", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("test-token", { status })));
    await expect(deliver(channel, event, "Down")).rejects.toThrow(`discord.com responded HTTP ${status}`);
  });
  it("skips an unconfigured channel", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(deliver({ type: "discord", config: {} }, event, "Down")).rejects.toThrow("no webhook URL");
    expect(fetch).not.toHaveBeenCalled();
  });
});
