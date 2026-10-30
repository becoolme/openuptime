import type { McpAlertEvent, NewMcpAlertTask, Repo } from "@openuptime/repo";
import { deliverMcpAlertTask, dispatchAlert, mcpSubscriberRecipient, Skipped, type PushedDevices } from "./alerts";
import { unmetered, type Entitlements } from "./entitlements";

/** Runs inside the monitor-result transaction. All destinations exist durably before that transaction commits. */
export async function enqueueMcpAlert(repo: Repo, orgId: string, event: Parameters<typeof dispatchAlert>[2], channelIds: string[], observationId: string) {
  if (!event.monitor.id) throw new Error("MCP event needs a monitor");
  // Explicit projection is deliberate: the scheduler's Monitor also carries credentials and tool arguments.
  const safe: McpAlertEvent = {
    kind: event.kind,
    incident: { id: event.incident.id, title: event.incident.title, startedAt: event.incident.startedAt?.toISOString(), resolvedAt: event.incident.resolvedAt?.toISOString() ?? null },
    monitor: { id: event.monitor.id, projectId: event.monitor.projectId ?? null, name: event.monitor.name, target: event.monitor.target, type: "mcp" },
    ...(event.reason ? { reason: event.reason.slice(0, 2000) } : {}), ...(event.slow ? { slow: true } : {}), ...(event.schemaDrift ? { schemaDrift: true } : {}), ...(event.reopened ? { reopened: true } : {}),
  };
  const base = { eventKey: `${event.monitor.id}:${observationId}:${event.kind}:${event.incident.id}`, organizationId: orgId, monitorId: event.monitor.id, event: safe };
  const channels = await repo.channelsToAlert(orgId, { channelIds, projectId: event.monitor.projectId, withDisabled: true });
  const tasks: NewMcpAlertTask[] = channels.map(channel => ({ ...base, recipient: `channel:${channel.id}`, channelId: channel.id }));
  for (const subscriber of await repo.subscribersFor(orgId, event.monitor.id)) tasks.push({ ...base, recipient: await mcpSubscriberRecipient(subscriber.token), channelId: null });
  await repo.enqueueMcpAlerts(tasks);
}

/** At-least-once provider delivery: lease/CAS prevents simultaneous workers from completing the same task. */
export async function drainMcpAlerts(repo: Repo, entitlements: Entitlements = unmetered, limit = 10, monitorId?: string) {
  let count = 0;
  const pushedBy = new Map<string, PushedDevices>();
  while (count < limit) {
    // Do not lease a long queue then leave its tail idle while earlier provider requests run.
    const tasks = await repo.claimMcpAlerts(Math.min(5, limit - count), monitorId);
    if (!tasks.length) break;
    count += tasks.length;
    const completed = await Promise.allSettled(tasks.map(async task => {
      if (!pushedBy.has(task.eventKey)) pushedBy.set(task.eventKey, new Map());
      try {
        await deliverMcpAlertTask(repo, task, entitlements, pushedBy.get(task.eventKey));
        await repo.finishMcpAlert(task.id, task.leaseToken, { status: "sent" });
      } catch (error) {
        const skipped = error instanceof Skipped;
        // Provider errors may include credentials or payloads: persist only a fixed error category.
        await repo.finishMcpAlert(task.id, task.leaseToken, { status: skipped ? "skipped" : "retry",
          error: skipped ? error.message : "MCP alert delivery unavailable", retryInSec: Math.min(3600, 60 * 2 ** Math.min(task.attempts, 6)) });
      }
    }));
    if (completed.some(result => result.status === "rejected")) throw new Error("MCP outbox could not persist delivery state");
  }
  return count;
}
