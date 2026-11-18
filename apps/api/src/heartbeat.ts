import type { Monitor, Repo } from "@openuptime/repo";
import type { Entitlements } from "./entitlements";
import { completeRecovery } from "./scheduler";

/**
 * Counts a ping of a heartbeat monitor: moves its deadline, records a passing check and, once enough pings came in,
 * resolves the outage. False when the monitor is paused and the ping changes nothing.
 */
export async function acceptHeartbeat(repo: Repo, m: Monitor, entitlements: Entitlements): Promise<boolean> {
  if (m.status === "paused") return false;
  const accepted = await repo.recordHeartbeatObservation(m);
  if (!accepted) return false;
  await repo.recordCheck({ monitorId: m.id, ok: true });
  const wasDown = accepted.status === "down";
  const ready = (accepted.consecutiveSuccesses ?? 0) >= (accepted.recoveryThreshold ?? 1);
  // the status stays "down" until the incident is resolved, so a failed resolve is retried by the next ping
  if (wasDown && ready) await completeRecovery(repo, accepted, "up", 0, entitlements);
  return true;
}
