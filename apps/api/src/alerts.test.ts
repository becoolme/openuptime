import { afterEach, describe, expect, it, vi } from "vitest";
import { deliver, retryDeliveries } from "./alerts";

const ev = { kind: "incident.opened" as const, incident: { id: "i1", title: "Down" }, monitor: { name: "API", target: "https://x" } };

afterEach(() => vi.unstubAllGlobals());

describe("lark channel", () => {
  it("posts a text message, signed when a secret is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await deliver({ type: "lark", config: { url: "https://open.larksuite.com/open-apis/bot/v2/hook/abc", secret: "s3cret" } }, ev, "🔴 API is down");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.msg_type).toBe("text");
    expect(body.content.text).toBe("🔴 API is down");
    expect(typeof body.timestamp).toBe("string");
    expect(body.sign).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("sends no signature without a secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ StatusCode: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await deliver({ type: "lark", config: { url: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" } }, ev, "hi");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sign).toBeUndefined();
  });

  it("fails when the hook refuses the message with HTTP 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 19021, msg: "sign match fail" }), { status: 200 })));
    await expect(deliver({ type: "lark", config: { url: "https://open.larksuite.com/open-apis/bot/v2/hook/abc" } }, ev, "hi")).rejects.toThrow(/19021/);
  });
});

describe("retryDeliveries", () => {
  const item = (attempts: number) => ({
    delivery: { id: "d1", kind: "incident.opened", attempts, organizationId: "o" },
    incident: { id: "i1", title: "API is down", startedAt: new Date(), resolvedAt: null, auto: true, severity: "major" },
    monitor: { id: "m1", projectId: null, name: "API", target: "https://x" },
    channel: { id: "c1", organizationId: "o", type: "webhook", name: "hook", config: { url: "https://hooks.example/x" }, enabled: true },
  });
  const run = async (attempts: number, ok: boolean) => {
    const done: unknown[] = [];
    const repo = { claimRetries: async () => [item(attempts)], finishRetry: async (_id: string, r: unknown) => void done.push(r) };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: ok ? 200 : 500 }));
    await retryDeliveries(repo as never);
    fetchSpy.mockRestore();
    return done[0];
  };
  it("marks a recovered delivery as sent", async () => expect(await run(1, true)).toEqual({ ok: true, error: null, retryInSec: null }));
  it("schedules another attempt, then gives up after the third", async () => {
    expect(await run(1, false)).toMatchObject({ ok: false, retryInSec: 300 });
    expect(await run(2, false)).toMatchObject({ ok: false, retryInSec: null });
  });
});
