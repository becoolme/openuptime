import { openDatabase } from "@openuptime/db-pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueMcpAlert, drainMcpAlerts } from "./mcp-outbox";
import { deliverMcpAlertTask } from "./alerts";
import { monitorCreateSchema } from "./routes/monitors";
import { unmetered } from "./entitlements";
vi.mock("./alerts", async importOriginal => ({ ...await importOriginal<typeof import("./alerts")>(), deliverMcpAlertTask: vi.fn() }));
const url = process.env.TEST_DATABASE_URL;
afterEach(() => vi.resetAllMocks());

describe.skipIf(!url)("MCP durable alert outbox", () => {
  it("survives a failed dispatch and a new process without recreating tasks or storing credentials", async () => {
    const first = openDatabase(url!, { max: 3 }); await first.migrate();
    const org = `mcp-outbox-${crypto.randomUUID()}`;
    let monitorId = "";
    try {
      await first.query("insert into organization (id,name,slug,created_at) values ($1,'MCP',$1,now())", [org]);
      const project = await first.repo.createProject(org, "MCP");
      const monitor = await first.repo.createMonitor(org, project.id, monitorCreateSchema.parse({ name: "MCP", type: "mcp", target: "https://1.1.1.1/mcp",
        headers: { Authorization: "Bearer fixture-secret" }, mcpConfig: { requiredTools: [], schemaCheck: false, toolCall: { enabled: true, name: "lookup", arguments: { secret: "fixture-argument" }, assertions: [] } } }));
      monitorId = monitor.id;
      const channel = await first.repo.createChannel(org, project.id, { name: "Webhook", type: "webhook", enabled: true, config: { url: "https://1.1.1.1/alerts" } });
      const incident = await first.repo.openAutoIncident({ organizationId: org, monitorId, title: "MCP down", auto: true }, { status: "investigating", body: "MCP failed" });
      const event = { kind: "incident.opened" as const, incident: incident!, monitor };
      await first.repo.withMcpResult(monitor, async tx => {
        await tx.setMonitorState(monitorId, { status: "down" });
        await enqueueMcpAlert(tx, org, event, [channel.id], "observation-one");
      });
      await enqueueMcpAlert(first.repo, org, event, [channel.id], "observation-one");
      const rows = await first.query<{ event: unknown; n: number }>("select event from mcp_alert_outbox where monitor_id=$1", [monitorId]);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain("fixture-secret");
      expect(JSON.stringify(rows)).not.toContain("fixture-argument");
      vi.mocked(deliverMcpAlertTask).mockRejectedValueOnce(new Error("provider failed with secret payload"));
      expect(await drainMcpAlerts(first.repo, unmetered, 10, monitorId)).toBe(1);
      const [pending] = await first.query<{ status: string; error: string; attempts: number }>("select status,error,attempts from mcp_alert_outbox where monitor_id=$1", [monitorId]);
      expect(pending).toEqual({ status: "pending", error: "MCP alert delivery unavailable", attempts: 1 });
    } finally { await first.close(); }
    const restarted = openDatabase(url!, { max: 3 });
    try {
      await restarted.query("update mcp_alert_outbox set next_attempt_at=now()-interval '1 second' where monitor_id=$1", [monitorId]);
      vi.mocked(deliverMcpAlertTask).mockResolvedValue(undefined);
      const counts = await Promise.all([drainMcpAlerts(restarted.repo, unmetered, 10, monitorId), drainMcpAlerts(restarted.repo, unmetered, 10, monitorId)]);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
      expect(deliverMcpAlertTask).toHaveBeenCalledTimes(2);
      const [sent] = await restarted.query<{ status: string; attempts: number }>("select status,attempts from mcp_alert_outbox where monitor_id=$1", [monitorId]);
      expect(sent).toEqual({ status: "sent", attempts: 2 });
      expect(await drainMcpAlerts(restarted.repo, unmetered, 10, monitorId)).toBe(0);
    } finally { await restarted.query("delete from organization where id=$1", [org]); await restarted.close(); }
  });
});
