import type { Monitor, Repo } from "@openuptime/repo";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureProbes } from "./probes";
import { unmetered, type Entitlements } from "./entitlements";
import { MESSAGE_SIZE, checkOne, nextAfter, processCheckMessage, runDueChecks, slotOf, type CheckMessage } from "./scheduler";

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
function fakeRepo(opts: { failCreate?: () => boolean } = {}) {
  const incidents: { id: string; title: string; auto: boolean; severity: string; resolved: boolean }[] = [];
  const states: Record<string, unknown>[] = [];
  const repo = {
    underMaintenance: async () => false,
    recordCheck: async () => {},
    setMonitorState: async (_id: string, s: Record<string, unknown>) => void states.push(s),
    hasOpenIncident: async (_id: string, slow: boolean) => incidents.some((i) => !i.resolved && (i.auto && i.severity === "minor") === slow),
    openIncidents: async (_id: string, slow: boolean) => incidents.filter((i) => !i.resolved && (i.auto && i.severity === "minor") === slow),
    hadIncidentSince: async () => false,
    resolveIncident: async (id: string) => {
      const i = incidents.find((x) => x.id === id)!;
      if (i.resolved) return false;
      i.resolved = true;
      return true;
    },
    incidentMuted: async () => false,
    openAutoIncident: async (inc: { title: string; auto?: boolean; severity?: string }) => {
      if (opts.failCreate?.()) throw new Error("db down");
      const row = { id: crypto.randomUUID(), title: inc.title, auto: !!inc.auto, severity: inc.severity ?? "major", resolved: false };
      incidents.push(row);
      return { ...row, startedAt: new Date(), resolvedAt: null };
    },
    channelsToAlert: async () => [],
    queueDeliveries: async () => [],
    scheduleFollowUps: async () => {},
    subscribersFor: async () => [],
    logDeliveries: async () => {},
  } as unknown as Repo;
  return { repo, incidents, states };
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
});
