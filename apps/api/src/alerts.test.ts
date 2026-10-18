import { afterEach, describe, expect, it, vi } from "vitest";
import { sendPush } from "./apns";
import { deliver, retryDeliveries, sendEscalations, sendReminders } from "./alerts";

// these tests stub the global fetch and use made-up host names; the pinned connection would bypass the stub and go to the real network
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));
vi.mock("./apns", () => ({ sendPush: vi.fn(async () => {}) }));
vi.mock("./pinnedfetch", () => ({ pinnedFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init) }));

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
  const item = (attempts: number, over: { kind?: string; incident?: Record<string, unknown>; enabled?: boolean } = {}) => ({
    delivery: { id: "d1", kind: over.kind ?? "incident.opened", attempts, organizationId: "o" },
    incident: { id: "i1", title: "API is down", startedAt: new Date(), resolvedAt: null, acknowledgedAt: null, auto: true, severity: "major", reminderCount: 2, escalationLevel: 1, ...over.incident },
    monitor: { id: "m1", projectId: null, name: "API", target: "https://x" },
    channel: { id: "c1", organizationId: "o", type: "webhook", name: "hook", config: { url: "https://hooks.example/x" }, enabled: true },
  });
  const run = async (attempts: number, status: number, over = {}) => {
    const done: Record<string, unknown>[] = [];
    const repo = { claimRetries: async () => [item(attempts, over)], finishDelivery: async (_id: string, r: Record<string, unknown>) => void done.push(r) };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status }));
    await retryDeliveries(repo as never);
    fetchSpy.mockRestore();
    return done[0];
  };
  it("marks a recovered delivery as sent", async () => expect(await run(1, 200)).toEqual({ status: "sent", error: null, message: null }));
  it("schedules another attempt, then gives up after the third", async () => {
    expect(await run(1, 500)).toMatchObject({ status: "failed", retryInSec: 300 });
    expect(await run(2, 500)).toMatchObject({ status: "failed", retryInSec: null });
  });
  it("explains a failure with the HTTP status", async () => {
    expect(await run(0, 500)).toMatchObject({ retryInSec: 60, message: expect.stringMatching(/^failed: .*HTTP 500.*trying again in 60 s/) });
    expect((await run(2, 503) as { message: string }).message).toMatch(/^failed: .*HTTP 503.*gave up after 3 attempts/);
  });
  it("does not send a retried down alert for an incident that has recovered, or a recovery for one that was reopened", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await run(1, 200, { kind: "incident.opened", incident: { resolvedAt: new Date() } })).toMatchObject({ status: "skipped", message: expect.stringMatching(/^skipped: .*resolved/) });
    expect(await run(1, 200, { kind: "incident.resolved", incident: { resolvedAt: null } })).toMatchObject({ status: "skipped", message: expect.stringMatching(/^skipped: .*reopened/) });
    expect(fetchSpy).not.toHaveBeenCalled();
    // the matching states still go out
    expect(await run(1, 200, { kind: "incident.resolved", incident: { resolvedAt: new Date() } })).toMatchObject({ status: "sent" });
    fetchSpy.mockRestore();
  });
  it("does not repeat a reminder for an incident that was acknowledged meanwhile", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await run(0, 200, { kind: "incident.reminder", incident: { acknowledgedAt: new Date() } });
    expect(r).toMatchObject({ status: "skipped", message: expect.stringMatching(/^skipped: .*acknowledged/) });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("reminders and escalation", () => {
  const monitor = { id: "m1", organizationId: "o", projectId: "p", name: "API", target: "https://x", channelIds: [] as string[] };
  const incident = { id: "i1", organizationId: "o", title: "API is down", startedAt: new Date(), resolvedAt: null, acknowledgedAt: null, auto: true, severity: "major", reminderCount: 3, escalationLevel: 1 };
  const ch = (id: string, type: string, enabled = true) => ({ id, organizationId: "o", projectId: "p", type, name: id, enabled, config: type === "email" ? { to: "a@example.com" } : {} });

  function fake(over: Record<string, unknown>) {
    const finished: { id: string; status: string; message: string | null }[] = [];
    const logged: Record<string, unknown>[] = [];
    const queued: Record<string, unknown>[] = [];
    const repo = {
      underMaintenance: async () => false,
      queueDeliveries: async (rows: Record<string, unknown>[]) => rows.map((r, i) => { queued.push(r); return { ...r, id: `${r.channelId}`, attempts: 0 }; }),
      claimDelivery: async (id: string) => ({ id, attempts: 0, kind: "x" }),
      finishDelivery: async (id: string, r: { status: string; message: string | null }) => void finished.push({ id, ...r }),
      logDeliveries: async (rows: Record<string, unknown>[]) => void logged.push(...rows),
      pushDevicesForOrganization: async () => [],
      ownerLocale: async () => "en",
      localeByEmail: async () => null,
      ...over,
    };
    return { repo: repo as never, finished, logged, queued };
  }

  it("repeats on push only unless the project opted in to email, and says why a push had nobody to reach", async () => {
    const due = [{ incident, monitor, project: { reminderIntervalMin: 5, reminderEmail: false, escalation: [] }, number: 4 }];
    const f = fake({ claimReminders: async () => due, channelsToAlert: async () => [ch("push1", "push"), ch("mail1", "email"), ch("hook1", "slack")] });
    await sendReminders(f.repo);
    expect(f.queued.map((r) => [r.channelId, r.kind])).toEqual([["push1", "incident.reminder"]]);
    expect(f.finished).toEqual([expect.objectContaining({ id: "push1", status: "skipped", message: expect.stringMatching(/^skipped: no phone/) })]);
  });

  it("includes email channels when the project opted in", async () => {
    const due = [{ incident, monitor, project: { reminderIntervalMin: 5, reminderEmail: true, escalation: [] }, number: 1 }];
    const f = fake({ claimReminders: async () => due, channelsToAlert: async () => [ch("push1", "push"), ch("mail1", "email")] });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    await sendReminders(f.repo).catch(() => {});
    expect(f.queued.map((r) => r.channelId)).toEqual(["push1", "mail1"]);
    vi.restoreAllMocks();
  });

  it("records a suppressed repeat during maintenance instead of sending it", async () => {
    const due = [{ incident, monitor, project: { reminderIntervalMin: 5, reminderEmail: false, escalation: [] }, number: 1 }];
    // the repo is asked about maintenance while claiming, so a suppressed repeat is never counted
    const asked: string[] = [];
    const f = fake({
      claimReminders: async (_limit: number, skip?: (m: typeof monitor) => Promise<boolean>) => ((await skip?.(monitor)) ? [] : due),
      underMaintenance: async (m: { id: string }) => (asked.push(m.id), true),
      channelsToAlert: async () => [ch("push1", "push")],
    });
    expect(await sendReminders(f.repo)).toBe(0);
    expect(asked).toEqual(["m1"]);
    expect(f.queued).toEqual([]);
  });

  it("pushes a phone once per event, however many push channels reach it", async () => {
    const due = [{ incident, monitor, step: { channelIds: ["p1", "p2"], escalateAfterMin: 15 }, level: 1 }];
    const f = fake({
      claimEscalations: async () => due,
      channelsByIds: async () => [ch("p1", "push"), ch("p2", "push")],
      pushDevicesForOrganization: async () => [{ id: "d1", token: "t1", userId: "u", platform: "ios", environment: "production", locale: null }, { id: "d2", token: "t2", userId: "u", platform: "ios", environment: "production", locale: null }],
    });
    vi.mocked(sendPush).mockClear();
    await sendEscalations(f.repo);
    expect(vi.mocked(sendPush).mock.calls.map((c) => c[1].map((d) => d.id))).toEqual([["d1", "d2"]]);
    expect(f.finished.map((x) => x.status).sort()).toEqual(["sent", "skipped"]);
    expect(f.finished.find((x) => x.status === "skipped")!.message).toMatch(/already notified/);
  });

  it("notifies the channels of the due escalation level and records a switched-off one as skipped", async () => {
    const due = [{ incident, monitor, step: { channelIds: ["c1", "c2"], escalateAfterMin: 15 }, level: 2 }];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    const f = fake({ claimEscalations: async () => due, channelsByIds: async () => [{ ...ch("c1", "webhook"), config: { url: "https://hooks.example/x" } }, ch("c2", "webhook", false)] });
    await sendEscalations(f.repo);
    expect(f.queued.map((r) => [r.channelId, r.kind])).toEqual([["c1", "incident.escalated"]]);
    expect(f.finished).toEqual([expect.objectContaining({ id: "c1", status: "sent" })]);
    expect(JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)).toMatchObject({ kind: "incident.escalated", count: 2 });
    expect(f.logged[0]).toMatchObject({ channelId: "c2", status: "skipped", statusMessage: "skipped: channel disabled" });
    fetchSpy.mockRestore();
  });
});
