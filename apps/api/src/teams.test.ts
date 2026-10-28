import { afterEach, describe, expect, it, vi } from "vitest";
import { deliver } from "./alerts";
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));
vi.mock("./pinnedfetch", () => ({ pinnedFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init) }));
const channel = { type: "teams", config: { url: "https://workflow.example.com/trigger?sig=secret" } };
const event = { kind: "incident.opened" as const, incident: { id: "i1", title: "Down" }, monitor: { name: "API", target: "https://example.com" } };
afterEach(() => vi.unstubAllGlobals());
describe("Teams Workflow delivery", () => {
  it.each(["incident.opened", "incident.resolved", "incident.reminder", "incident.escalated"] as const)("sends %s as an Adaptive Card", async (kind) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    await deliver(channel, { ...event, kind }, "API changed");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(channel.config.url);
    expect(JSON.parse(init.body)).toEqual({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.2", body: [{ type: "TextBlock", text: "API changed", wrap: true }] } }] });
  });
  it("bounds Unicode card content below webhook payload limits", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    await deliver(channel, event, "a".repeat(3998) + "😀".repeat(200));
    const body = fetch.mock.calls[0][1].body;
    const text = JSON.parse(body).attachments[0].content.body[0].text;
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(new TextDecoder().decode(new TextEncoder().encode(text))).toBe(text);
    expect(new TextEncoder().encode(body).length).toBeLessThan(28000);
  });
  it.each([401, 429, 500])("rejects HTTP %s without leaking credentials", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret", { status })));
    await expect(deliver(channel, event, "Down")).rejects.toThrow(`workflow.example.com responded HTTP ${status}`);
  });
});
