import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it, vi } from "vitest";
import { enqueueMcpAlert, drainMcpAlerts } from "./mcp-outbox";
import { guardedFetch } from "./netguard";
import { monitorCreateSchema } from "./routes/monitors";
import { sendEmail } from "./email";
import { unmetered } from "./entitlements";
vi.mock("./netguard", async original => ({ ...await original<typeof import("./netguard")>(), guardedFetch: vi.fn() }));
vi.mock("./email", async original => ({ ...await original<typeof import("./email")>(), sendEmail: vi.fn() }));
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("MCP outbox real dispatch authorization", () => {
  it("rechecks routing and incident state before sending the frozen recipient task", async () => {
    const db = openDatabase(url!, { max: 3 }); await db.migrate();
    const org = `mcp-delivery-${crypto.randomUUID()}`;
    try {
      await db.query("insert into organization (id,name,slug,created_at) values ($1,'MCP',$1,now())", [org]);
      const project = await db.repo.createProject(org, "MCP");
      const m = await db.repo.createMonitor(org, project.id, monitorCreateSchema.parse({ name: "MCP", type: "mcp", target: "https://1.1.1.1/mcp" }));
      const channel = await db.repo.createChannel(org, project.id, { name: "Webhook", type: "webhook", enabled: true, config: { url: "https://1.1.1.1/alerts" } });
      const incident = await db.repo.openAutoIncident({ organizationId: org, monitorId: m.id, title: "MCP down", auto: true }, { status: "investigating", body: "MCP failed" });
      const event = { kind: "incident.opened" as const, incident: incident!, monitor: m };
      await enqueueMcpAlert(db.repo, org, event, [channel.id], "denied");
      expect(await drainMcpAlerts(db.repo, { ...unmetered, allowAlertChannel: async () => false }, 10, m.id)).toBe(1);
      expect(guardedFetch).not.toHaveBeenCalled();
      await enqueueMcpAlert(db.repo, org, event, [channel.id], "allowed");
      vi.mocked(guardedFetch).mockImplementation(async target => ({ url: target, res: new Response(null, { status: 200 }) }));
      expect(await drainMcpAlerts(db.repo, { ...unmetered, allowAlertChannel: async () => true }, 10, m.id)).toBe(1);
      expect(guardedFetch).toHaveBeenCalledTimes(1);
      await enqueueMcpAlert(db.repo, org, event, [channel.id], "stale");
      await db.repo.resolveIncident(incident!.id, "Recovered before dispatch");
      expect(await drainMcpAlerts(db.repo, unmetered, 10, m.id)).toBe(0);
      expect(guardedFetch).toHaveBeenCalledTimes(1);
      const statuses = await db.query<{ status: string }>("select status from mcp_alert_outbox where monitor_id=$1 order by sequence", [m.id]);
      expect(statuses.map(row => row.status)).toEqual(["skipped", "sent", "skipped"]);
    } finally { vi.resetAllMocks(); await db.query("delete from organization where id=$1", [org]); await db.close(); }
  });
  it("never treats a quota attempt or persisted denial as permission after a crash", async () => {
    const db = openDatabase(url!, { max: 3 }); await db.migrate();
    const org = `mcp-quota-${crypto.randomUUID()}`;
    try {
      await db.query("insert into organization (id,name,slug,created_at) values ($1,'MCP',$1,now())", [org]);
      const project = await db.repo.createProject(org, "MCP");
      const m = await db.repo.createMonitor(org, project.id, monitorCreateSchema.parse({ name: "MCP", type: "mcp", target: "https://1.1.1.1/mcp" }));
      const channel = await db.repo.createChannel(org, project.id, { name: "Email", type: "email", enabled: true, config: { to: "fixture@example.com" } });
      const incident = await db.repo.openAutoIncident({ organizationId: org, monitorId: m.id, title: "MCP down", auto: true }, { status: "investigating", body: "failed" });
      const event = { kind: "incident.opened" as const, incident: incident!, monitor: m };
      await enqueueMcpAlert(db.repo, org, event, [channel.id], "denied-before-crash");
      const spendEmails = vi.fn(async () => 0);
      const crashing = { ...db.repo, finishMcpAlert: async () => { throw new Error("process stopped before finish"); } };
      await expect(drainMcpAlerts(crashing, { ...unmetered, spendEmails }, 10, m.id)).rejects.toThrow("persist delivery state");
      const [decision] = await db.query<{ quota_decision: string }>("select quota_decision from mcp_alert_outbox where monitor_id=$1", [m.id]);
      expect(decision.quota_decision).toBe("denied");
      await db.query("update mcp_alert_outbox set lease_until=now()-interval '1 second' where monitor_id=$1", [m.id]);
      const laterAllowance = vi.fn(async () => 1);
      await drainMcpAlerts(db.repo, { ...unmetered, spendEmails: laterAllowance }, 10, m.id);
      expect(laterAllowance).not.toHaveBeenCalled();
      expect(sendEmail).not.toHaveBeenCalled();
      await enqueueMcpAlert(db.repo, org, event, [channel.id], "attempt-only");
      const [unknown] = await db.repo.claimMcpAlerts(1, m.id);
      await db.repo.markMcpAlertQuota(unknown.id, unknown.leaseToken);
      await db.query("update mcp_alert_outbox set lease_until=now()-interval '1 second' where id=$1", [unknown.id]);
      await drainMcpAlerts(db.repo, { ...unmetered, spendEmails }, 10, m.id);
      expect(spendEmails).toHaveBeenCalledTimes(2);
      expect(sendEmail).not.toHaveBeenCalled();
    } finally { vi.resetAllMocks(); await db.query("delete from organization where id=$1", [org]); await db.close(); }
  });

});
