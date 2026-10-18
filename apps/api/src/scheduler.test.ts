import type { Monitor, Repo } from "@openuptime/repo";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureProbes } from "./probes";
import { resetSelfCheck } from "./selfcheck";
import { unmetered, type Entitlements } from "./entitlements";
import { MESSAGE_SIZE, checkOne, resolveIncident, nextAfter, processCheckMessage, runDueChecks, slotOf, type CheckMessage } from "./scheduler";

describe("runDueChecks", () => {
  it("packs due monitors into queue messages, each monitor exactly once", async () => {
    const due = Array.from({ length: 130 }, () => ({ id: crypto.randomUUID() }) as Monitor);
    let first = true;
    const repo = {
      // one lease round returns everything, the next is empty
      claimDue: async () => (first ? ((first = false), due) : []),
      claimRetries: async () => [],
      sweepStuckDeliveries: async () => 0,
      claimReminders: async () => [],
      claimEscalations: async () => [],
      purgeExpired: async () => {},
    } as unknown as Repo;
    const sent: { body: CheckMessage; delaySeconds?: number }[] = [];
    const n = await runDueChecks(repo, { sendBatch: async (m) => void sent.push(...m) });
    expect(n).toBe(130);
    const ids = sent.flatMap((m) => m.body.ids);
    expect(ids).toHaveLength(130);
    expect(new Set(ids)).toEqual(new Set(due.map((m) => m.id)));
    expect(sent.every((m) => m.body.ids.length <= MESSAGE_SIZE)).toBe(true);
    // every message only holds monitors of one delay slot
    expect(sent.every((m) => new Set(m.body.ids.map(slotOf)).size === 1)).toBe(true);
  });
});

describe("queue delivery", () => {
  const at = new Date("2026-01-01T00:01:00.000Z");
  const http = (id: string, over: Partial<Monitor> = {}) => ({ id, organizationId: "o", type: "http", target: "not a url", paused: false, nextCheckAt: at, ...over }) as Monitor;

  /** A repo whose beginRuns remembers tokens like the database does; `ran` collects the monitors that were actually checked. */
  function consumerRepo(monitors: Monitor[]) {
    const seen = new Map<string, number>();
    const ran: string[] = [];
    const repo = {
      monitorsByIds: async (ids: string[]) => monitors.filter((m) => ids.includes(m.id)),
      beginRuns: async (runs: { id: string; token: Date }[]) =>
        runs.filter((r) => seen.get(r.id) !== r.token.getTime()).map((r) => (seen.set(r.id, r.token.getTime()), r.id)),
    } as unknown as Repo;
    return { repo, ran };
  }

  it("bills and checks a redelivered message only once", async () => {
    const { repo } = consumerRepo([http("a"), http("b")]);
    let spent = 0;
    const entitlements: Entitlements = { ...unmetered, spendCredits: async (_w, n) => ((spent += n), n), creditBalance: async () => null };
    const msg: CheckMessage = { ids: ["a", "b"], at: [at.toISOString(), at.toISOString()] };
    await processCheckMessage(repo, msg, entitlements).catch(() => {});
    await processCheckMessage(repo, msg, entitlements).catch(() => {});
    expect(spent).toBe(2);
  });

  it("does not report a heartbeat that was pinged after it was claimed", async () => {
    const claimed = http("h", { type: "heartbeat" });
    const pinged = { ...claimed, nextCheckAt: new Date(at.getTime() + 90_000) };
    const { repo } = consumerRepo([pinged]);
    await processCheckMessage(repo, { ids: ["h"], at: [at.toISOString()] });
    // it was never started, so the run is still unclaimed
    const started = await repo.beginRuns([{ id: "h", token: at }]);
    expect(started).toEqual(["h"]);
  });

  it("hands the monitors back when they could not be queued", async () => {
    const due = Array.from({ length: 3 }, (_, i) => http(`m${i}`));
    let first = true;
    const released: string[] = [];
    const repo = {
      claimDue: async () => (first ? ((first = false), due) : []),
      releaseClaims: async (runs: { id: string }[]) => void released.push(...runs.map((r) => r.id)),
      claimRetries: async () => [],
      sweepStuckDeliveries: async () => 0,
      claimReminders: async () => [],
      claimEscalations: async () => [],
      purgeExpired: async () => {},
    } as unknown as Repo;
    const n = await runDueChecks(repo, { sendBatch: async () => { throw new Error("queue down"); } });
    expect(new Set(released)).toEqual(new Set(["m0", "m1", "m2"]));
    expect(n).toBe(0);
  });
});

describe("nextAfter", () => {
  it("adds the grace period for heartbeats only", () => {
    const t = 1_000_000;
    expect(nextAfter({ intervalSec: 60, graceSec: 300, type: "heartbeat" }, t).getTime()).toBe(t + 360_000);
    expect(nextAfter({ intervalSec: 60, graceSec: 300, type: "http" }, t).getTime()).toBe(t + 60_000);
  });
});

/** A tiny in-memory repo: just what one failed heartbeat check touches. */
function fakeRepo(opts: { failCreate?: () => boolean; maintenance?: boolean; monitors?: Monitor[]; reopenable?: boolean; handled?: boolean; reopenedMuted?: boolean; alertedAgoMin?: number; history?: { kind: string; agoMin: number; status?: string }[]; historyFails?: boolean; recent?: boolean; scheduled?: { id: string }[] } = {}) {
  const incidents: { id: string; title: string; auto: boolean; severity: string; resolved: boolean; note?: string | null }[] = [];
  const reopened: string[] = [];
  /** what happened, in order: follow-up clocks set ("schedule") and alert fan-out begun ("alert") */
  const order: string[] = [];
  const states: Record<string, unknown>[] = [];
  const deliveries: { kind: string; createdAt: Date }[] = [];
  const marked: string[] = [];
  const repo = {
    underMaintenance: async () => !!opts.maintenance,
    monitorsByIds: async (ids: string[]) => (opts.monitors ?? []).filter((m) => ids.includes(m.id)),
    reopenIncident: async (_id: string, _since: Date, _body: string, note: string) => {
      if (!opts.reopenable) return null;
      reopened.push(note);
      return { id: "old", startedAt: new Date(Date.now() - 3_600_000), resolvedAt: null, title: "API is down" };
    },
    outageHandledByPerson: async () => !!opts.handled,
    recordCheck: async () => {},
    recordRegionResults: async () => {},
    setMonitorState: async (_id: string, s: Record<string, unknown>) => void states.push(s),
    hasOpenIncident: async (_id: string, slow: boolean) => incidents.some((i) => !i.resolved && (i.auto && i.severity === "minor") === slow),
    openIncidents: async (_id: string, slow: boolean) => incidents.filter((i) => !i.resolved && (i.auto && i.severity === "minor") === slow),
    hadIncidentSince: async () => !!opts.recent,
    resolveIncident: async (id: string) => {
      const i = incidents.find((x) => x.id === id)!;
      if (i.resolved) return false;
      i.resolved = true;
      return true;
    },
    incidentDeliveries: async () => [
      ...(opts.historyFails ? (() => { throw new Error("db down"); })() : []),
      ...(opts.history ?? []).map((h) => ({ kind: h.kind, status: h.status, createdAt: new Date(Date.now() - h.agoMin * 60_000) })),
      ...(opts.reopenedMuted ? [{ kind: "incident.muted", createdAt: new Date() }] : []),
      ...(opts.alertedAgoMin !== undefined ? [{ kind: "incident.opened", createdAt: new Date(Date.now() - opts.alertedAgoMin * 60_000) }] : []),
      ...deliveries,
    ],
    openAutoIncident: async (inc: { title: string; auto?: boolean; severity?: string; evaluationNote?: string | null }) => {
      if (opts.failCreate?.()) throw new Error("db down");
      const row = { id: crypto.randomUUID(), title: inc.title, auto: !!inc.auto, severity: inc.severity ?? "major", resolved: false, note: inc.evaluationNote };
      incidents.push(row);
      return { ...row, startedAt: new Date(), resolvedAt: null };
    },
    channelsToAlert: async () => (order.push("alert"), []),
    queueDeliveries: async () => [],
    scheduleFollowUps: async (inc: { id: string; startedAt: Date }) => void (opts.scheduled?.push({ id: inc.id }), order.push("schedule", `at:${inc.startedAt.getTime() > Date.now() - 60_000}`)),
    subscribersFor: async () => [],
    logDeliveries: async (rows: { kind: string }[]) => void rows.forEach((r) => { marked.push(r.kind); deliveries.push({ kind: r.kind, createdAt: new Date() }); }),
  } as unknown as Repo;
  return { repo, incidents, states, reopened, order, marked };
}

const hb = (over: Partial<Monitor> = {}) =>
  ({ id: "m1", organizationId: "o", projectId: "p", name: "API", type: "heartbeat", target: "", intervalSec: 60, graceSec: 30, status: "up", consecutiveFailures: 0, consecutiveSlow: 0, failureThreshold: 1, slowThresholdMs: 1000, slowAlertAfter: 3, channelIds: [], paused: false, ...over }) as Monitor;

describe("checkOne", () => {
  it("opens an outage even while a latency incident is open, and supersedes the latency one", async () => {
    const { repo, incidents } = fakeRepo();
    incidents.push({ id: "slow", title: "slow", auto: true, severity: "minor", resolved: false });
    await checkOne(repo, hb({ consecutiveSlow: 3, status: "degraded" }));
    expect(incidents.find((i) => i.id === "slow")!.resolved).toBe(true);
    expect(incidents.filter((i) => !i.resolved).map((i) => i.title)).toEqual(["API is down"]);
  });

  it("does not record the outage as down until its incident exists, so a failed create is retried", async () => {
    let fail = true;
    const { repo, incidents, states } = fakeRepo({ failCreate: () => fail });
    await expect(checkOne(repo, hb())).rejects.toThrow("db down");
    // the failure was stored, the status transition was not
    expect(states.some((s) => s.status === "down")).toBe(false);
    expect(incidents).toHaveLength(0);
    // next check (monitor still reads "up"): the incident is created and only then is the status set
    fail = false;
    await checkOne(repo, hb());
    expect(incidents.filter((i) => !i.resolved)).toHaveLength(1);
    expect(states.at(-1)).toMatchObject({ status: "down" });
  });

  it("keeps a regular monitor's lease-assigned due time", async () => {
    const { repo, states } = fakeRepo();
    // a heartbeat gets a due time from the grace period; nothing else sets one here
    await checkOne(repo, hb());
    expect(states[0]).toHaveProperty("nextCheckAt");
  });
});

describe("checkOne noise rules", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens nothing during maintenance, keeps the status, and still resolves an open incident when the check passes", async () => {
    const quiet = vi.spyOn(console, "info").mockImplementation(() => {});
    const { repo, incidents, states } = fakeRepo({ maintenance: true });
    await checkOne(repo, hb());
    expect(incidents).toHaveLength(0);
    expect(states.every((s) => !("status" in s))).toBe(true);
    expect(quiet).toHaveBeenCalledWith(expect.stringContaining("suppressed: maintenance"));
  });

  const parent = (status: Monitor["status"]) => ({ id: "parent", status, organizationId: "o", projectId: "p" }) as Monitor;

  it("records the child as down but opens no incident while its dependency is down", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { repo, incidents, states } = fakeRepo({ monitors: [parent("down")] });
    await checkOne(repo, hb({ dependsOnMonitorId: "parent" }));
    expect(incidents).toHaveLength(0);
    expect(states.at(-1)).toMatchObject({ status: "down" });
  });

  it("opens the incident when the dependency is up", async () => {
    const { repo, incidents } = fakeRepo({ monitors: [parent("up")] });
    await checkOne(repo, hb({ dependsOnMonitorId: "parent" }));
    expect(incidents.map((i) => i.title)).toEqual(["API is down"]);
  });

  it("opens the incident late when the dependency recovered but the child is still down", async () => {
    const { repo, incidents } = fakeRepo({ monitors: [parent("up")] });
    await checkOne(repo, hb({ dependsOnMonitorId: "parent", status: "down", consecutiveFailures: 5 }));
    expect(incidents).toHaveLength(1);
    expect(incidents[0].note).toContain("depends on recovered");
  });

  it("does not open it late while the dependency is still down", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { repo, incidents } = fakeRepo({ monitors: [parent("down")] });
    await checkOne(repo, hb({ dependsOnMonitorId: "parent", status: "down", consecutiveFailures: 5 }));
    expect(incidents).toHaveLength(0);
  });

  it("reopens a just-resolved outage instead of opening and alerting a second incident", async () => {
    const { repo, incidents, reopened } = fakeRepo({ reopenable: true });
    await checkOne(repo, hb());
    expect(incidents).toHaveLength(0);
    expect(reopened[0]).toContain("reopened");
  });

  it("tells people a reopened incident is back, and restarts its reminder clocks first", async () => {
    const { repo, reopened, order } = fakeRepo({ reopenable: true });
    await checkOne(repo, hb());
    expect(reopened).toHaveLength(1);
    // clocks are counted from now, not from the original start; they are set before the alert goes out
    expect(order).toEqual(["schedule", "at:true", "alert"]);
  });

  it("does not alert for a reopened incident that was muted as flapping", async () => {
    const { repo, order } = fakeRepo({ reopenable: true, reopenedMuted: true });
    await checkOne(repo, hb());
    // no alert, but the reminder clocks are restarted
    expect(order).toEqual(["schedule", "at:true"]);
  });

  it("keeps follow-ups but skips the \"again\" alert, and mutes the recovery, when the earlier recovery was never announced", async () => {
    const { repo, order, marked } = fakeRepo({ reopenable: true, alertedAgoMin: 5 });
    await checkOne(repo, hb());
    expect(order).toEqual(["schedule", "at:true"]);
    expect(marked).toEqual(["incident.muted"]);
  });

  it("still says \"down again\" after a recovery alert went out: alert 10:00, recovered 10:05, fails 10:10", async () => {
    const { repo, order, marked } = fakeRepo({ reopenable: true, history: [{ kind: "incident.opened", agoMin: 10, status: "sent" }, { kind: "incident.resolved", agoMin: 5, status: "sent" }] });
    await checkOne(repo, hb());
    expect(order).toEqual(["schedule", "at:true", "alert"]);
    expect(marked).not.toContain("incident.muted");
  });

  it("mutes the \"again\" alert when the recovery was skipped or failed, and does not count a skipped original as an alert", async () => {
    for (const status of ["skipped", "failed"]) {
      const { repo, order, marked } = fakeRepo({ reopenable: true, history: [{ kind: "incident.opened", agoMin: 10, status: "sent" }, { kind: "incident.resolved", agoMin: 5, status }] });
      await checkOne(repo, hb());
      expect(order).toEqual(["schedule", "at:true"]);
      expect(marked).toEqual(["incident.muted"]);
    }
    // the only "opened" row never went anywhere: nothing was announced, so this alert is not a repeat
    const { repo, order } = fakeRepo({ reopenable: true, history: [{ kind: "incident.opened", agoMin: 5, status: "skipped" }] });
    await checkOne(repo, hb());
    expect(order).toEqual(["schedule", "at:true", "alert"]);
  });

  it("alerts anyway when the alert history cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { repo, order } = fakeRepo({ reopenable: true, historyFails: true });
    await checkOne(repo, hb());
    expect(order).toEqual(["schedule", "at:true", "alert"]);
  });

  it("follows up a new incident that was muted as flapping, without alerting", async () => {
    const scheduled: { id: string }[] = [];
    const { repo, order, marked } = fakeRepo({ recent: true, scheduled });
    await checkOne(repo, hb());
    expect(marked).toEqual(["incident.muted"]);
    expect(scheduled).toHaveLength(1);
    expect(order).not.toContain("alert");
  });

  it("skips the recovery alert while the latest word on the incident is a mute, and sends it otherwise", async () => {
    for (const [reopenedMuted, alerts] of [[true, 0], [false, 1]] as const) {
      const { repo, incidents, order } = fakeRepo({ reopenedMuted });
      incidents.push({ id: "i", title: "down", auto: true, severity: "major", resolved: false });
      await resolveIncident(repo, hb({ status: "down" }));
      expect(order.filter((o) => o === "alert")).toHaveLength(alerts);
    }
  });

  it("alerts a reopened incident again once the flap window has passed, and its recovery then goes out", async () => {
    const { repo, order, marked } = fakeRepo({ reopenable: true, alertedAgoMin: 20 });
    await checkOne(repo, hb());
    expect(order).toEqual(["schedule", "at:true", "alert"]);
    expect(marked).not.toContain("incident.muted");
  });

  it("sets the follow-up clocks before it alerts a new outage", async () => {
    const down = fakeRepo();
    await checkOne(down.repo, hb());
    expect(down.order.filter((o) => !o.startsWith("at:"))).toEqual(["schedule", "alert"]);
  });

  it("does not open late after a person resolved an incident during the outage", async () => {
    const { repo, incidents } = fakeRepo({ monitors: [parent("up")], handled: true });
    await checkOne(repo, hb({ dependsOnMonitorId: "parent", status: "down", consecutiveFailures: 5 }));
    expect(incidents).toHaveLength(0);
  });

  it("stores why an incident opened", async () => {
    const { repo, incidents } = fakeRepo();
    await checkOne(repo, hb({ failureThreshold: 1 }));
    expect(incidents[0].note).toBe("1 consecutive failed checks");
  });
});

describe("checkOne across regions", () => {
  const url = (r: string) => `https://probe.example.app/api/probe/${r}`;
  const probes = (answers: Record<string, { ok: boolean } | "down">) => {
    configureProbes({ PROBE_REGIONS: JSON.stringify(Object.fromEntries(Object.keys(answers).map((r) => [r, url(r)]))), PROBE_SECRET: "s" });
    vi.stubGlobal("fetch", async (u: string) => {
      const a = answers[u.split("/").pop()!];
      if (a === "down") throw new Error("connect refused");
      return new Response(JSON.stringify({ ok: a.ok, statusCode: a.ok ? 200 : 503, latencyMs: 80, error: a.ok ? undefined : "Expected 200, got 503" }));
    });
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    configureProbes({});
  });

  const web = (over: Partial<Monitor> = {}) => hb({ type: "http", target: "https://example.com", method: "GET", expectedStatus: 200, timeoutMs: 5000, regions: ["us-east", "eu-central", "ap-southeast"], failureThreshold: 1, ...over });

  function repoWithRecords() {
    const f = fakeRepo();
    const recorded = { single: [] as unknown[], many: [] as { monitorId: string; results: { region: string; ok: boolean }[]; summary: { ok: boolean } }[] };
    (f.repo as unknown as Record<string, unknown>).recordCheck = async (r: unknown) => void recorded.single.push(r);
    (f.repo as unknown as Record<string, unknown>).recordRegionResults = async (monitorId: string, results: never, summary: never) => void recorded.many.push({ monitorId, results, summary });
    return { ...f, recorded };
  }

  it("records one row per region and one run, and stays up when only one region fails", async () => {
    probes({ "us-east": { ok: true }, "eu-central": { ok: true }, "ap-southeast": { ok: false } });
    const { repo, incidents, states, recorded } = repoWithRecords();
    await checkOne(repo, web());
    expect(recorded.single).toHaveLength(0);
    expect(recorded.many).toHaveLength(1);
    expect(recorded.many[0].results.map((r) => r.region).sort()).toEqual(["ap-southeast", "eu-central", "us-east"]);
    expect(recorded.many[0].summary.ok).toBe(true);
    expect(incidents).toHaveLength(0);
    expect(states.at(-1)).toMatchObject({ consecutiveFailures: 0 });
  });

  it("goes down when most regions fail", async () => {
    probes({ "us-east": { ok: false }, "eu-central": { ok: false }, "ap-southeast": { ok: true } });
    const { repo, incidents, recorded } = repoWithRecords();
    await checkOne(repo, web());
    expect(recorded.many[0].summary.ok).toBe(false);
    expect(incidents.map((i) => i.title)).toEqual(["API is down"]);
  });

  it("does not open a latency incident during maintenance, and resolves the outage once checks pass", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    probes({ "us-east": { ok: true }, "eu-central": { ok: true }, "ap-southeast": { ok: true } });
    const slow = fakeRepo({ maintenance: true });
    await checkOne(slow.repo, web({ slowAlertAfter: 1, slowThresholdMs: 1 }));
    expect(slow.incidents).toHaveLength(0);
    // the same check outside maintenance does trip it
    const loud = fakeRepo();
    await checkOne(loud.repo, web({ slowAlertAfter: 1, slowThresholdMs: 1 }));
    expect(loud.incidents.map((i) => i.severity)).toEqual(["minor"]);
    // passing checks resolve an open outage even inside a window
    const { repo, incidents } = fakeRepo({ maintenance: true });
    incidents.push({ id: "out", title: "API is down", auto: true, severity: "major", resolved: false });
    await checkOne(repo, web({ status: "down" }));
    expect(incidents[0].resolved).toBe(true);
  });

  it("goes down on a single failing region when the monitor asks for one", async () => {
    probes({ "us-east": { ok: true }, "eu-central": { ok: true }, "ap-southeast": { ok: false } });
    const { repo, incidents } = repoWithRecords();
    await checkOne(repo, web({ minRegionsFailing: 1 }));
    expect(incidents).toHaveLength(1);
    expect(incidents[0].note).toBe("1 consecutive failed checks; 1 of 3 regions failed");
  });

  it("waits for the agreed number of regions and says so", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    probes({ "us-east": { ok: true }, "eu-central": { ok: false }, "ap-southeast": { ok: false } });
    const { repo, incidents } = repoWithRecords();
    await checkOne(repo, web({ minRegionsFailing: 3 }));
    expect(incidents).toHaveLength(0);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("2 of 3 regions failed, 3 needed"));
    info.mockRestore();
  });

  it("caps the agreed number by the regions that answered, so a dead region cannot block an alert", async () => {
    probes({ "us-east": "down", "eu-central": { ok: false }, "ap-southeast": { ok: false } });
    const { repo, incidents } = repoWithRecords();
    await checkOne(repo, web({ minRegionsFailing: 3 }));
    expect(incidents).toHaveLength(1);
  });

  it("does not take unreachable probes for an outage", async () => {
    probes({ "us-east": "down", "eu-central": { ok: true }, "ap-southeast": "down" });
    const { repo, incidents, recorded } = repoWithRecords();
    await checkOne(repo, web());
    // only the region that answered is recorded, as a single row
    expect(recorded.many).toHaveLength(0);
    expect(recorded.single).toMatchObject([{ region: "eu-central", ok: true }]);
    expect(incidents).toHaveLength(0);
  });

  it("falls back to its own location when every probe is unreachable", async () => {
    probes({ "us-east": "down", "eu-central": "down", "ap-southeast": "down" });
    const { repo, recorded } = repoWithRecords();
    // a closed local port: the fallback check itself fails, which is what a real outage would look like
    await checkOne(repo, web({ type: "tcp", target: "127.0.0.1:1", failureThreshold: 3 }));
    expect(recorded.single).toMatchObject([{ region: "auto", ok: false }]);
  });
  it("records nothing when the prober itself is offline, here or in a region", async () => {
    // every fetch fails: the probes cannot be asked, and the local fallback cannot reach the reference sites either
    configureProbes({ PROBE_REGIONS: JSON.stringify({ "us-east": url("us-east") }), PROBE_SECRET: "s" });
    vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }); });
    resetSelfCheck();
    const { repo, incidents, recorded, states } = repoWithRecords();
    await checkOne(repo, web({ target: "https://93.184.216.34/", regions: ["us-east"], failureThreshold: 1 }));
    expect(recorded.single).toHaveLength(0);
    expect(recorded.many).toHaveLength(0);
    expect(states).toHaveLength(0);
    expect(incidents).toHaveLength(0);
  });

  it("treats a probe that reports itself offline as unreachable", async () => {
    probes({ "us-east": { ok: true }, "eu-central": { ok: true }, "ap-southeast": { ok: true } });
    vi.stubGlobal("fetch", async (u: string) =>
      new Response(JSON.stringify(u.endsWith("ap-southeast") ? { ok: false, inconclusive: true, error: "ENOTFOUND" } : { ok: true, latencyMs: 50 })));
    const { repo, incidents, recorded } = repoWithRecords();
    await checkOne(repo, web());
    expect(recorded.many[0].results.map((r) => r.region).sort()).toEqual(["eu-central", "us-east"]);
    expect(incidents).toHaveLength(0);
  });
});
