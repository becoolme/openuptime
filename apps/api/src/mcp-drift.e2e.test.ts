import { openDatabase } from "@openuptime/db-pg";
import type { McpObservation } from "@openuptime/repo";
import { describe, expect, it, vi } from "vitest";
import { checkOne } from "./scheduler";
import { mcpCheck } from "./mcp-monitor";
import { deliverMcpAlertTask } from "./alerts";
import { monitorCreateSchema } from "./routes/monitors";
vi.mock("./mcp-monitor", () => ({ mcpCheck: vi.fn() }));
vi.mock("./alerts", async importOriginal => ({ ...await importOriginal<typeof import("./alerts")>(), deliverMcpAlertTask: vi.fn() }));
const url = process.env.TEST_DATABASE_URL;
const discovery: McpObservation = { stage: "complete", toolsComplete: true, timings: { initialize: 2, "tools/list": 3 }, tools: [{ name: "lookup", inputSchema: { type: "object" } }], changes: [] };

describe.skipIf(!url)("MCP degraded drift and historical diagnostics", () => {
  it("commits a degraded schema incident, queues its notification, and records per-stage history", async () => {
    const db = openDatabase(url!, { max: 3 }); await db.migrate();
    const org = `mcp-drift-${crypto.randomUUID()}`;
    try {
      await db.query("insert into organization (id,name,slug,created_at) values ($1,'MCP',$1,now())", [org]);
      const project = await db.repo.createProject(org, "MCP");
      const channel = await db.repo.createChannel(org, project.id, { name: "Webhook", type: "webhook", enabled: true, config: { url: "https://1.1.1.1/alerts" } });
      const m = await db.repo.createMonitor(org, project.id, monitorCreateSchema.parse({ name: "MCP", type: "mcp", target: "https://1.1.1.1/mcp",
        mcpConfig: { requiredTools: [], schemaCheck: true, toolCall: null, driftPolicy: "degraded" }, channelIds: [channel.id] }));
      vi.mocked(mcpCheck).mockResolvedValue({ ok: true, latencyMs: 10, mcp: discovery });
      await checkOne(db.repo, m);
      let current = (await db.repo.getMonitor(org, m.id, null))!;
      vi.mocked(deliverMcpAlertTask).mockImplementation(async (_repo, task) => {
        expect(task.event.schemaDrift).toBe(true);
        expect((await db.repo.getMonitor(org, m.id, null))?.status).toBe("degraded");
      });
      vi.mocked(mcpCheck).mockResolvedValue({ ok: true, degraded: true, latencyMs: 20,
        mcp: { ...discovery, tools: [], changes: ["lookup: tool removed"], drift: [{ severity: "breaking", kind: "removed", tool: "lookup", message: "Tool removed" }] } });
      await checkOne(db.repo, current);
      current = (await db.repo.getMonitor(org, m.id, null))!;
      expect(current.status).toBe("degraded");
      expect(current.mcpBaseline).toEqual(discovery.tools);
      const detail = await db.repo.monitorDetail(m.id);
      expect(detail.incidents).toEqual(expect.arrayContaining([expect.objectContaining({ title: "MCP: tool schema changed", severity: "minor", evaluationNote: "mcp-schema-drift" })]));
      expect(deliverMcpAlertTask).toHaveBeenCalledTimes(1);
      const history = await db.repo.mcpHistory(org, m.id, null, { days: 7 });
      expect(history?.results).toHaveLength(2);
      expect(history?.metrics).toMatchObject({ samples: 2, p50: 15, p95: 19.5 });
      expect(history?.changes[0]).toMatchObject({ severity: "breaking", changes: ["lookup: tool removed"] });
      expect(JSON.stringify(history)).not.toContain("inputSchema");
      vi.mocked(deliverMcpAlertTask).mockResolvedValue(undefined);
      vi.mocked(mcpCheck).mockResolvedValue({ ok: true, latencyMs: 10, mcp: discovery });
      await checkOne(db.repo, current);
      expect((await db.repo.getMonitor(org, m.id, null))?.status).toBe("up");
      expect((await db.repo.monitorDetail(m.id)).incidents.every(incident => incident.status === "resolved")).toBe(true);
      expect(deliverMcpAlertTask).toHaveBeenCalledTimes(2);
    } finally { vi.resetAllMocks(); await db.query("delete from organization where id=$1", [org]); await db.close(); }
  });
});
