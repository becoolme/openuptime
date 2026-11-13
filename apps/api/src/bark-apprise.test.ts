import { afterEach, describe, expect, it, vi } from "vitest";
import { deliver } from "./alerts";
import { maskConfig, restoreConfig, MASK } from "./secrets";
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));
vi.mock("@openuptime/kit/pinnedfetch", () => ({ pinnedFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init), outboundProxy: () => null, useOutboundProxy: () => {} }));
const event = { kind: "incident.opened" as const, incident: { id: "i1", title: "Down" }, monitor: { name: "API", target: "https://example.com" } };
const bark = { type: "bark", config: { deviceKey: "abcDEF123456" } };
const apprise = { type: "apprise", config: { url: "https://apprise.example.com/notify/ops", tag: "oncall", token: "test-token" } };
afterEach(() => vi.unstubAllGlobals());

describe("bark delivery", () => {
  it("posts to the public server with a time-sensitive level for outages", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetch);
    await deliver(bark, event, "API is down");
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.day.app/push");
    expect(JSON.parse(init.body)).toEqual({ device_key: "abcDEF123456", title: "OpenUptime", body: "API is down", group: "OpenUptime", level: "timeSensitive" });
  });
  it("uses a normal level for recovery and a self-hosted server when given", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetch);
    await deliver({ type: "bark", config: { deviceKey: "abcDEF123456", url: "https://bark.example.com/" } }, { ...event, kind: "incident.resolved" }, "API recovered");
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://bark.example.com/push");
    expect(JSON.parse(init.body).level).toBe("active");
  });
  it("keeps slow responses out of the time-sensitive level", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetch);
    await deliver(bark, { ...event, slow: true }, "API is slow");
    expect(JSON.parse(fetch.mock.calls[0][1].body).level).toBe("active");
  });
  it("cuts a long message to the Bark limit", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetch);
    await deliver(bark, event, "x".repeat(5000));
    const body = JSON.parse(fetch.mock.calls[0][1].body).body as string;
    expect(body.length).toBe(1000);
    expect(body.endsWith("…")).toBe(true);
  });
  it("does not follow redirects and does not reflect provider content", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("abcDEF123456", { status: 307, headers: { location: "https://other.example/" } })); vi.stubGlobal("fetch", fetch);
    await expect(deliver(bark, event, "Down")).rejects.toThrow("api.day.app responded HTTP 307");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("skips a channel without a key and masks the key", async () => {
    await expect(deliver({ type: "bark", config: {} }, event, "Down")).rejects.toThrow("no device key");
    expect(maskConfig(bark.config).deviceKey).toBe(MASK);
    expect(restoreConfig({ deviceKey: MASK }, bark.config).deviceKey).toBe("abcDEF123456");
  });
});

describe("apprise delivery", () => {
  it.each([
    ["incident.opened", "failure"], ["incident.reminder", "failure"], ["incident.escalated", "failure"], ["incident.resolved", "success"],
  ] as const)("posts %s as type %s with the tag and token", async (kind, type) => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetch);
    await deliver(apprise, { ...event, kind }, "API changed");
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://apprise.example.com/notify/ops");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
    expect(JSON.parse(init.body)).toEqual({ title: "OpenUptime", body: "API changed", type, tag: "oncall" });
  });
  it("marks slow responses as warnings and omits an empty tag and token", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetch);
    await deliver({ type: "apprise", config: { url: apprise.config.url } }, { ...event, slow: true }, "Slow");
    const [, init] = fetch.mock.calls[0];
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(JSON.parse(init.body)).toEqual({ title: "OpenUptime", body: "Slow", type: "warning" });
  });
  it("does not redirect a token to another host", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 307, headers: { location: "https://other.example/" } })); vi.stubGlobal("fetch", fetch);
    await expect(deliver(apprise, event, "Down")).rejects.toThrow("HTTP 307");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([401, 424, 500])("rejects HTTP %s without reflecting provider content", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("test-token", { status })));
    await expect(deliver(apprise, event, "Down")).rejects.toThrow(`apprise.example.com responded HTTP ${status}`);
  });
});
