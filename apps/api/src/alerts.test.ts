import { afterEach, describe, expect, it, vi } from "vitest";
import { sendPush } from "./apns";
import { sendEmail } from "./email";
import { clearProjectNames, deliver, dispatchAlert, retryDeliveries, sendEscalations, sendReminders, withProject } from "./alerts";

// these tests stub the global fetch and use made-up host names; the pinned connection would bypass the stub and go to the real network
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));
vi.mock("./email", async (orig) => ({ ...(await orig<typeof import("./email")>()), sendEmail: vi.fn(async () => {}) }));
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

describe("retry of a reopened incident", () => {
  const base = new Date("2026-10-17T10:00:00Z");
  const at = (min: number) => new Date(base.getTime() + min * 60_000);
  const run = async (self: Date, others: { createdAt: Date; status?: string; channelId?: string }[]) => {
    const done: Record<string, unknown>[] = [];
    const bodies: unknown[] = [];
    const repo = {
      claimRetries: async () => [{
        delivery: { id: "d2", kind: "incident.opened", attempts: 1, organizationId: "o", channelId: "c1", createdAt: self },
        incident: { id: "i1", organizationId: "o", title: "API is down", startedAt: base, resolvedAt: null, acknowledgedAt: null, auto: true, severity: "major", evaluationNote: "reopened: failed again", reminderCount: 0, escalationLevel: 0 },
        monitor: { id: "m1", projectId: null, name: "API", target: "https://x" },
        channel: { id: "c1", organizationId: "o", type: "slack", name: "s", config: { url: "https://hooks.example/x" }, enabled: true },
      }],
      incidentDeliveries: async () => others.map((o, i) => ({ id: `d${i}`, kind: "incident.opened", channelId: "c1", status: "sent", ...o })),
      finishDelivery: async (_id: string, r: Record<string, unknown>) => void done.push(r),
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => (bodies.push(JSON.parse(String(init?.body))), new Response("", { status: 200 })));
    await retryDeliveries(repo as never);
    return { done: done[0], bodies };
  };
  afterEach(() => vi.restoreAllMocks());

  it("keeps saying \"again\" when the retried alert is the one sent for the reopen", async () => {
    const r = await run(at(20), [{ createdAt: at(0) }]);
    expect(r.done).toMatchObject({ status: "sent" });
    expect((r.bodies[0] as { text: string }).text).toContain("is down again");
  });

  it("drops a late retry of the original alert once a reopen alert has gone out", async () => {
    const r = await run(at(0), [{ createdAt: at(20) }]);
    expect(r.done).toMatchObject({ status: "skipped", message: expect.stringMatching(/reopened/) });
    expect(r.bodies).toEqual([]);
  });

  it("still sends the original when the later alert was skipped or failed, or went to another channel", async () => {
    for (const later of [{ status: "skipped" }, { status: "failed" }, { channelId: "c2" }]) {
      const r = await run(at(0), [{ createdAt: at(20), ...later }]);
      expect(r.done, JSON.stringify(later)).toMatchObject({ status: "sent" });
      vi.restoreAllMocks();
    }
  });
});

describe("push dedupe across channels", () => {
  const push = { type: "push", organizationId: "o", config: {} };
  const devices = [{ id: "dev1" }, { id: "dev2" }];
  const repo = { pushDevicesForOrganization: async () => devices } as never;

  it("lets a second push channel reach the phones when the first one failed", async () => {
    const mocked = vi.mocked(sendPush);
    mocked.mockReset();
    mocked.mockRejectedValueOnce(new Error("APNs down")).mockResolvedValue(undefined);
    const pushed = new Map<string, Promise<boolean>>();
    const a = deliver(push, ev, "t", "en", repo, pushed).catch((e) => e);
    const b = deliver(push, ev, "t", "en", repo, pushed);
    expect(await a).toBeInstanceOf(Error);
    await b;
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(mocked.mock.calls[1][1]).toEqual(devices);
  });

  it("still pushes a phone once when the first channel succeeded", async () => {
    const mocked = vi.mocked(sendPush);
    mocked.mockReset();
    mocked.mockResolvedValue(undefined);
    const pushed = new Map<string, Promise<boolean>>();
    await deliver(push, ev, "t", "en", repo, pushed);
    await expect(deliver(push, ev, "t", "en", repo, pushed)).rejects.toThrow(/already notified/);
    expect(mocked).toHaveBeenCalledTimes(1);
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

describe("project name in alerts", () => {
  const projects = (list: { id: string; name: string }[]) => ({ listProjects: vi.fn(async () => list) });
  const two = [{ id: "p1", name: "favicon.im" }, { id: "p2", name: "other" }];
  const mon = { id: "m1", projectId: "p1", name: "WWW homepage", target: "https://x" };
  const opened = { kind: "incident.opened" as const, incident: { id: "i1", title: "WWW homepage is down" }, monitor: mon };
  afterEach(() => { clearProjectNames(); vi.restoreAllMocks(); });

  /** Send `event` through dispatchAlert to one channel of `type` and return what the channel got. */
  async function sent(event: typeof opened & Record<string, unknown>, list: { id: string; name: string }[], type = "slack", extra: Record<string, unknown> = {}) {
    const cfg: Record<string, unknown> = { slack: { url: "https://hooks.example/s" }, lark: { url: "https://open.larksuite.com/h" }, telegram: { botToken: "t", chatId: "1" }, pagerduty: { routingKey: "k" }, webhook: { url: "https://hooks.example/w" } };
    const bodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => (bodies.push(JSON.parse(String(init?.body))), new Response(JSON.stringify({ code: 0 }), { status: 200 })));
    const channel = { id: "c1", organizationId: "o", projectId: null, type, name: "c", enabled: true, config: cfg[type] };
    const repo = {
      ...projects(list),
      channelsToAlert: async () => [channel],
      logDeliveries: async () => {},
      queueDeliveries: async (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r, id: "d1", attempts: 0 })),
      claimDelivery: async (id: string) => ({ id, attempts: 0, kind: event.kind }),
      finishDelivery: async () => {},
      subscribersFor: async () => [],
      ...extra,
    };
    await dispatchAlert(repo as never, "o", event as never);
    return { bodies, repo };
  }

  it("names the project after the status emoji when the workspace has several projects", async () => {
    expect((await sent(opened, two)).bodies[0]).toEqual({ text: "🔴 [favicon.im] WWW homepage is down — WWW homepage is down" });
    expect((await sent({ ...opened, slow: true } as never, two)).bodies[0]).toEqual({ text: "🟡 [favicon.im] WWW homepage is responding slowly — WWW homepage is down" });
    expect((await sent({ ...opened, reopened: true } as never, two)).bodies[0]).toEqual({ text: "🔴 [favicon.im] WWW homepage is down again — WWW homepage is down" });
  });

  it("keeps today's text in a workspace with a single project", async () => {
    expect((await sent(opened, [two[0]])).bodies[0]).toEqual({ text: "🔴 WWW homepage is down — WWW homepage is down" });
  });

  it("covers reminder, escalation and recovery", async () => {
    expect((await sent({ ...opened, kind: "incident.reminder", count: 2 } as never, two)).bodies[0]).toEqual({ text: "⏰ [favicon.im] WWW homepage is still down and nobody has acknowledged it — reminder 2" });
    expect((await sent({ ...opened, kind: "incident.escalated" } as never, two)).bodies[0]).toEqual({ text: "🚨 [favicon.im] WWW homepage is still down and nobody has acknowledged it — escalated to you" });
    expect((await sent({ ...opened, kind: "incident.resolved" } as never, two)).bodies[0]).toEqual({ text: "✅ [favicon.im] WWW homepage has recovered" });
  });

  it("uses the same text on lark, telegram and the pagerduty summary", async () => {
    expect((await sent(opened, two, "lark")).bodies[0]).toMatchObject({ msg_type: "text", content: { text: "🔴 [favicon.im] WWW homepage is down — WWW homepage is down" } });
    expect((await sent(opened, two, "telegram")).bodies[0]).toEqual({ chat_id: "1", text: "🔴 [favicon.im] WWW homepage is down — WWW homepage is down" });
    expect((await sent(opened, two, "pagerduty")).bodies[0]).toMatchObject({ payload: { summary: "🔴 [favicon.im] WWW homepage is down — WWW homepage is down" } });
  });

  it("always puts the project in the webhook payload, whatever the project count", async () => {
    expect((await sent(opened, two, "webhook")).bodies[0]).toMatchObject({ project: { id: "p1", name: "favicon.im" } });
    expect((await sent(opened, [two[0]], "webhook")).bodies[0]).toMatchObject({ project: { id: "p1", name: "favicon.im" } });
  });

  it("sends the alert without a project when the lookup fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { bodies } = await sent(opened, [], "slack", { listProjects: async () => { throw new Error("db down"); } });
    expect(bodies[0]).toEqual({ text: "🔴 WWW homepage is down — WWW homepage is down" });
    const w = await sent(opened, [], "webhook", { listProjects: async () => { throw new Error("db down"); } });
    expect(w.bodies[0]).not.toHaveProperty("project");
    expect(err).toHaveBeenCalled();
  });

  it("reads the workspace's projects once for a burst of alerts", async () => {
    const repo = projects(two);
    await withProject(repo as never, "o", opened);
    await withProject(repo as never, "o", opened);
    expect(repo.listProjects).toHaveBeenCalledTimes(1);
  });

  it("does not look anything up for a monitor without a project", async () => {
    const repo = projects(two);
    const e = { ...opened, monitor: { ...mon, projectId: null } };
    expect(await withProject(repo as never, "o", e)).toBe(e);
    expect(repo.listProjects).not.toHaveBeenCalled();
  });

  it("names the project in a retried alert", async () => {
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => (bodies.push(JSON.parse(String(init?.body))), new Response("", { status: 200 })));
    const repo = {
      ...projects(two),
      claimRetries: async () => [{
        delivery: { id: "d1", kind: "incident.opened", attempts: 1, organizationId: "o", channelId: "c1", createdAt: new Date() },
        incident: { id: "i1", organizationId: "o", title: "WWW homepage is down", startedAt: new Date(), resolvedAt: null, acknowledgedAt: null, auto: true, severity: "major", reminderCount: 0, escalationLevel: 0 },
        monitor: mon,
        channel: { id: "c1", organizationId: "o", type: "slack", name: "s", config: { url: "https://hooks.example/x" }, enabled: true },
      }],
      finishDelivery: async () => {},
    };
    await retryDeliveries(repo as never);
    expect(bodies[0]).toEqual({ text: "🔴 [favicon.im] WWW homepage is down — WWW homepage is down" });
  });

  it("names the project in a reminder and an escalation", async () => {
    const bodies: { text?: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => (bodies.push(JSON.parse(String(init?.body))), new Response("", { status: 200 })));
    const incident = { id: "i1", organizationId: "o", title: "WWW homepage is down", startedAt: new Date(), resolvedAt: null, acknowledgedAt: null, auto: true, severity: "major", reminderCount: 1, escalationLevel: 1 };
    const hook = { id: "c1", organizationId: "o", type: "slack", name: "s", enabled: true, config: { url: "https://hooks.example/x" } };
    const repo = {
      ...projects(two),
      underMaintenance: async () => false,
      claimReminders: async () => [{ incident, monitor: { ...mon, organizationId: "o", channelIds: [] }, project: { reminderEmail: false }, number: 1 }],
      claimEscalations: async () => [{ incident, monitor: { ...mon, organizationId: "o", channelIds: [] }, step: { channelIds: ["c1"] }, level: 1 }],
      channelsToAlert: async () => [{ ...hook, type: "push" }],
      channelsByIds: async () => [hook],
      queueDeliveries: async (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r, id: "d1", attempts: 0 })),
      claimDelivery: async (id: string) => ({ id, attempts: 0, kind: "x" }),
      finishDelivery: async () => {},
      logDeliveries: async () => {},
      pushDevicesForOrganization: async () => [{ id: "dev" }],
    };
    vi.mocked(sendPush).mockClear();
    await sendReminders(repo as never);
    expect(vi.mocked(sendPush).mock.calls[0][2]).toMatchObject({ kind: "incident.reminder", project: { id: "p1", name: "favicon.im" }, multiProject: true });
    await sendEscalations(repo as never);
    expect(bodies[0].text).toBe("🚨 [favicon.im] WWW homepage is still down and nobody has acknowledged it — escalated to you");
  });

  it("prefixes the email subject and lists the project, in the reader's language", async () => {
    const mail = vi.mocked(sendEmail);
    const send = async (event: Record<string, unknown>, lang: "en" | "zh-CN") => {
      mail.mockClear();
      await deliver({ type: "email", name: "mail", config: { to: "a@example.com" } }, { ...opened, incident: { id: "i1", title: "x", startedAt: new Date() }, ...event } as never, "t", lang);
      return mail.mock.calls[0][0] as unknown as { subject: string; html?: string; text?: string };
    };
    const multi = { project: { id: "p1", name: "favicon.im" }, multiProject: true };
    expect((await send(multi, "en")).subject).toBe("[favicon.im] 🔴 WWW homepage is down · OpenUptime");
    expect((await send({ ...multi, kind: "incident.resolved" }, "en")).subject).toBe("[favicon.im] ✅ WWW homepage has recovered · OpenUptime");
    const zh = await send(multi, "zh-CN");
    expect(zh.subject).toMatch(/^\[favicon\.im\] 🔴 /);
    expect(JSON.stringify(zh)).toContain("项目");
    expect(JSON.stringify(await send(multi, "en"))).toContain("favicon.im");
    // one project: unchanged
    const single = await send({ project: multi.project }, "en");
    expect(single.subject).toBe("🔴 WWW homepage is down · OpenUptime");
    expect(JSON.stringify(single)).not.toContain("favicon.im");
  });
});
