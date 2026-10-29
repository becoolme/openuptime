import { afterEach, describe, expect, it, vi } from "vitest";
import { deliver, teamsText } from "./alerts";
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
    expect(JSON.parse(init.body)).toEqual({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.2", body: [{ type: "TextBlock", text: "API changed", wrap: true }], msteams: { width: "Full" } } }] });
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
  it.each([429, 500])("rejects HTTP %s without leaking credentials", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret", { status })));
    const error = await deliver(channel, event, "Down").catch((e: Error) => e);
    expect((error as Error).message).toBe(`workflow.example.com responded HTTP ${status}`);
    expect((error as Error).message).not.toContain("secret");
  });
  it.each([401, 403])("explains that authenticated Workflow triggers are unsupported on HTTP %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret", { status })));
    const error = (await deliver(channel, event, "Down").catch((e: Error) => e)) as Error;
    expect(error.message).toContain(`workflow.example.com responded HTTP ${status}`);
    expect(error.message).toContain("“Anyone”");
    expect(error.message).not.toContain("secret");
  });
  it("escapes Markdown so monitor names and URLs cannot format text or inject links", async () => {
    expect(teamsText("*bold* _it_ [x](https://evil.example) `code` a\\b")).toBe("\\*bold\\* \\_it\\_ \\[x\\]\\(https://evil.example\\) \\`code\\` a\\\\b");
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    await deliver(channel, event, "[click](https://evil.example) is down");
    expect(JSON.parse(fetch.mock.calls[0][1].body).attachments[0].content.body[0].text).toBe("\\[click\\]\\(https://evil.example\\) is down");
  });
  it("counts escapes toward the cap and never ends on a dangling backslash", () => {
    for (const text of ["*".repeat(3000), "a".repeat(3999) + "_", "_".repeat(1999) + "😀".repeat(500)]) {
      const out = teamsText(text);
      expect(out.length).toBeLessThanOrEqual(4000);
      expect(out.endsWith("…")).toBe(true);
      expect(/(?<!\\)(\\\\)*\\…$/.test(out)).toBe(false);
      expect(new TextDecoder().decode(new TextEncoder().encode(out))).toBe(out);
    }
  });
});
