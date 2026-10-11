import type { Monitor, Repo } from "@openuptime/repo";
import { dispatchAlert, retryDeliveries } from "./alerts";
import { runCheck } from "./checker";
import { creditCost, unmetered, type Entitlements } from "./entitlements";

const CONCURRENCY = 20;

/** Monitors per queue message. One message = 3 billable queue operations, so pack many. */
export const MESSAGE_SIZE = 25;
const CLAIM_LIMIT = 1000;
const MAX_ROUNDS = 10;
/** Without a queue the checks run inside the cron invocation; stay under the Free plan's 50 subrequests. */
const INLINE_LIMIT = 40;

/** Checks of one cron tick are spread over this many delay slots so they don't all hit the network in the same second. */
const SLOTS = 6;
const SLOT_SECONDS = 8;
/** Stable per-monitor slot: a monitor keeps the same second-offset within the minute on every run. */
export function slotOf(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % SLOTS;
}

/**
 * `at` holds, in the order of `ids`, the due time each monitor's claim assigned: it names the run, so a redelivered
 * message is recognised. Messages queued before it existed have none and run without that check.
 */
export type CheckMessage = { ids: string[]; at?: string[] };
export type CheckQueue = { sendBatch(messages: { body: CheckMessage; delaySeconds?: number }[]): Promise<unknown> };

/**
 * Cron entry point. Leases every due monitor and either fans the work out to the queue
 * (production) or runs the checks inline (local dev / no queue bound). Returns how many were due.
 */
export async function runDueChecks(repo: Repo, queue?: CheckQueue, entitlements: Entitlements = unmetered) {
  let total = 0;
  const limit = queue ? CLAIM_LIMIT : INLINE_LIMIT;
  for (let round = 0; round < (queue ? MAX_ROUNDS : 1); round++) {
    const due = await repo.claimDue(limit);
    total += due.length;
    if (queue) {
      const claimed = new Map(due.map((m) => [m.id, m.nextCheckAt] as const));
      const messages: { body: CheckMessage; delaySeconds: number }[] = [];
      for (let slot = 0; slot < SLOTS; slot++) {
        const ids = due.filter((m) => slotOf(m.id) === slot).map((m) => m.id);
        for (let i = 0; i < ids.length; i += MESSAGE_SIZE) {
          const part = ids.slice(i, i + MESSAGE_SIZE);
          const times = part.map((id) => claimed.get(id));
          const body: CheckMessage = times.every(Boolean) ? { ids: part, at: times.map((t) => t!.toISOString()) } : { ids: part };
          messages.push({ body, delaySeconds: slot * SLOT_SECONDS });
        }
      }
      // sendBatch accepts at most 100 messages per call
      for (let i = 0; i < messages.length; i += 100) {
        const chunk = messages.slice(i, i + 100);
        try {
          await queue.sendBatch(chunk);
        } catch (e) {
          // Claimed but not queued: without this the monitors would sit idle until their next interval. Hand back everything
          // of this round that was not sent and stop; the next tick picks it up again.
          console.error("could not queue checks, releasing them", e);
          const unsent = messages.slice(i).flatMap((m) => m.body.ids.map((id) => ({ id, token: claimed.get(id)! }))).filter((r) => r.token);
          await repo.releaseClaims(unsent).catch((err) => console.error("could not release claims", err));
          total -= unsent.length;
          return housekeeping(repo, queue, total);
        }
      }
    } else {
      await checkMany(repo, due, entitlements);
    }
    if (due.length < limit) break;
  }
  return housekeeping(repo, queue, total);
}

async function housekeeping(repo: Repo, queue: CheckQueue | undefined, total = 0) {
  // failed incident alerts get another attempt (a few per tick; fewer when everything runs inline)
  await retryDeliveries(repo, queue ? 10 : 3).catch((e) => console.error("alert retry failed", e));
  // cheap housekeeping once an hour
  if (new Date().getMinutes() === 0) await repo.purgeExpired();
  return total;
}

/**
 * Queue consumer: run the checks for one message. Throws (so the message is retried) only if the monitors cannot be
 * loaded or the runs cannot be marked as started, which happens before anything is checked or billed.
 *
 * Queues deliver at least once. A run is therefore started at most once: it is marked first, then billed and checked, so a
 * redelivery is dropped instead of charging again. The price is that a worker dying in between loses that single check.
 */
export async function processCheckMessage(repo: Repo, msg: CheckMessage, entitlements: Entitlements = unmetered) {
  const monitors = await repo.monitorsByIds(msg.ids);
  const token = new Map(msg.at ? msg.ids.map((id, i) => [id, new Date(msg.at![i])] as const) : []);
  // a heartbeat that was pinged after it was claimed has a new due time and is not missing anything
  const pinged = (m: Monitor) => m.type === "heartbeat" && token.has(m.id) && m.nextCheckAt.getTime() !== token.get(m.id)!.getTime();
  const open = monitors.filter((m) => !m.paused && !pinged(m));
  const runs = open.filter((m) => token.has(m.id)).map((m) => ({ id: m.id, token: token.get(m.id)! }));
  const started = new Set(runs.length ? await repo.beginRuns(runs) : []);
  await checkMany(repo, open.filter((m) => !token.has(m.id) || started.has(m.id)), entitlements);
}

/**
 * The monitors a workspace's remaining credits cover, in the order given; the others are left out for this round.
 * They were already leased, so they come due again after their interval and run once credits are back.
 */
export async function withinCredits(monitors: Monitor[], entitlements: Entitlements): Promise<Monitor[]> {
  const byWorkspace = new Map<string, Monitor[]>();
  for (const m of monitors) byWorkspace.set(m.organizationId, [...(byWorkspace.get(m.organizationId) ?? []), m]);
  const allowed = new Set<string>();
  await Promise.all([...byWorkspace].map(async ([workspaceId, list]) => {
    const wanted = list.reduce((n, m) => n + creditCost(m), 0);
    // a failing ledger must not silence monitoring: the checks run and the gap is only logged
    const granted = wanted === 0 ? 0 : await entitlements.spendCredits(workspaceId, wanted).catch((e) => (console.error("credits unavailable", e), wanted));
    let left = granted;
    for (const m of list) {
      const cost = creditCost(m);
      if (cost <= left) {
        left -= cost;
        allowed.add(m.id);
      }
    }
  }));
  return monitors.filter((m) => allowed.has(m.id));
}

async function checkMany(repo: Repo, due: Monitor[], entitlements: Entitlements) {
  const monitors = await withinCredits(due, entitlements);
  if (monitors.length < due.length) console.warn(`credits exhausted: skipped ${due.length - monitors.length} of ${due.length} checks`);
  for (let i = 0; i < monitors.length; i += CONCURRENCY) {
    // one failing monitor must not take the rest of the batch down with it
    const batch = monitors.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((m) => checkOne(repo, m)));
    results.forEach((r, j) => r.status === "rejected" && console.error(`check failed for ${batch[j].id}`, r.reason));
  }
}

export async function checkOne(repo: Repo, m: Monitor) {
  // a due heartbeat monitor means no ping arrived in time
  const out = m.type === "heartbeat" ? { ok: false, error: "Heartbeat missed" } : await runCheck(m);
  const inMaintenance = await repo.underMaintenance(m);
  await repo.recordCheck({ monitorId: m.id, ok: out.ok, statusCode: out.statusCode, latencyMs: out.latencyMs, error: out.error });
  // Regular monitors keep the due time the lease gave them (a fixed cadence, whatever the check duration). A heartbeat is
  // due one interval plus grace after this moment.
  const next = m.type === "heartbeat" ? { nextCheckAt: nextAfter(m) } : {};
  // during maintenance keep recording results but leave status, failure count and incidents alone
  if (inMaintenance && !out.ok) {
    await repo.setMonitorState(m.id, { lastCheckedAt: new Date(), ...next });
    return;
  }
  const failures = out.ok ? 0 : m.consecutiveFailures + 1;
  const slow = out.ok && !!out.latencyMs && out.latencyMs > m.slowThresholdMs;
  // a failed check neither extends nor ends a slow streak
  const slowCount = !out.ok ? m.consecutiveSlow : slow ? m.consecutiveSlow + 1 : 0;
  const status = out.ok ? (slow ? "degraded" : "up") : failures >= m.failureThreshold ? "down" : m.status;
  const goingDown = status === "down" && m.status !== "down";
  const recovering = out.ok && m.status === "down";
  const slowTrips = slow && m.slowAlertAfter > 0 && slowCount === m.slowAlertAfter;
  const slowClears = out.ok && !slow && m.consecutiveSlow > 0;
  // An outage ends any latency incident, so the count starts over.
  const finalSlow = status === "down" ? 0 : slowCount;
  // A change that has to open or resolve an incident is committed only after that worked: if the incident step fails,
  // the stored state still reads as before and the next check takes the same transition again, instead of the outage
  // being recorded in the status but never alerted.
  const pending = goingDown || recovering || slowTrips || slowClears;
  await repo.setMonitorState(m.id, {
    consecutiveFailures: failures,
    ...(pending ? {} : { status, consecutiveSlow: finalSlow }),
    ...(m.type === "heartbeat" ? {} : { lastCheckedAt: new Date() }),
    ...next,
  });

  if (goingDown) await openIncident(repo, m, out.error ?? "Check failed");
  if (recovering) await resolveIncident(repo, m);
  if (slowTrips) await openSlowIncident(repo, m, out.latencyMs!);
  if (slowClears) await resolveIncident(repo, m, true);
  if (pending) await repo.setMonitorState(m.id, { status, consecutiveSlow: finalSlow });
}

async function openSlowIncident(repo: Repo, m: Monitor, latencyMs: number) {
  if (await repo.hasOpenIncident(m.id, true)) return;
  const reason = `${m.slowAlertAfter} consecutive checks slower than ${m.slowThresholdMs} ms (latest ${latencyMs} ms).`;
  const inc = await repo.createIncident(
    { organizationId: m.organizationId, monitorId: m.id, title: `${m.name} is responding slowly`, auto: true, severity: "minor" },
    { status: "investigating", body: reason },
  );
  await dispatchAlert(repo, m.organizationId, { kind: "incident.opened", incident: inc, monitor: m, reason, slow: true }, m.channelIds);
}

async function openIncident(repo: Repo, m: Monitor, reason: string) {
  // an outage is not blocked by a latency incident: that one is superseded (resolved without a recovery alert)
  for (const slow of await repo.openIncidents(m.id, true)) await repo.resolveIncident(slow.id, "Superseded: the monitor is down.");
  if (await repo.hasOpenIncident(m.id, false)) return;
  // a monitor that flaps (down, up, down…) gets one down alert per window, not one per flip
  const recent = await repo.hadIncidentSince(m.id, new Date(Date.now() - FLAP_WINDOW_MS));
  const inc = await repo.createIncident(
    { organizationId: m.organizationId, monitorId: m.id, title: `${m.name} is down`, auto: true },
    { status: "investigating", body: `${consecutive(m)} consecutive failed checks. ${reason}` },
  );
  if (recent) {
    // remember the incident was muted so its recovery mail is skipped too
    await repo.logDeliveries([{
      organizationId: m.organizationId, projectId: m.projectId ?? null, channelId: null, channelName: "Muted (flapping)", channelType: "none",
      kind: "incident.muted", incidentId: inc.id, monitorName: m.name, ok: true, error: "Another incident for this monitor started in the last 15 minutes",
    }]);
    return;
  }
  await dispatchAlert(repo, m.organizationId, { kind: "incident.opened", incident: inc, monitor: m, reason }, m.channelIds);
}

const FLAP_WINDOW_MS = 15 * 60_000;

const consecutive = (m: Monitor) => m.failureThreshold;

/** Resolve a monitor's open incidents: its outage ones, or with `slow` only the automatic latency ones. */
export async function resolveIncident(repo: Repo, m: Monitor, slow = false) {
  for (const inc of await repo.openIncidents(m.id, slow)) {
    await repo.resolveIncident(inc.id, slow ? "Response time is back under the threshold." : "Checks are passing again.");
    if (await repo.incidentMuted(inc.id)) continue;
    await dispatchAlert(repo, m.organizationId, { kind: "incident.resolved", incident: { ...inc, resolvedAt: new Date() }, monitor: m, ...(slow ? { slow: true as const } : {}) }, m.channelIds);
  }
}

/** Heartbeats are due again one interval plus the grace period after the last expected ping. */
export function nextAfter(m: Pick<Monitor, "intervalSec" | "graceSec" | "type">, from = Date.now()) {
  return new Date(from + (m.intervalSec + (m.type === "heartbeat" ? m.graceSec : 0)) * 1000);
}
