import { openDatabase } from "@openuptime/db-pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueMcpAlert, drainMcpAlerts } from "./mcp-outbox";
import { MAX_ATTEMPTS, retryDeliveries, sweepDeliveries } from "./alerts";
import { guardedFetch } from "./netguard";
import { monitorCreateSchema } from "./routes/monitors";
import { unmetered } from "./entitlements";
vi.mock("./netguard", async original => ({ ...await original<typeof import("./netguard")>(), guardedFetch: vi.fn() }));
const url = process.env.TEST_DATABASE_URL;
afterEach(() => vi.resetAllMocks());

const respond = (status: number) => vi.mocked(guardedFetch).mockImplementation(async target => ({ url: target, res: new Response(null, { status }) }));

async function setup() {
  const db = openDatabase(url!, { max: 3 }); await db.migrate();
  const org = `mcp-retry-${crypto.randomUUID()}`;
  await db.query("insert into organization (id,name,slug,created_at) values ($1,'MCP',$1,now())", [org]);
  const project = await db.repo.createProject(org, "MCP");
  const m = await db.repo.createMonitor(org, project.id, monitorCreateSchema.parse({ name: "MCP", type: "mcp", target: "https://1.1.1.1/mcp" }));
  const channel = await db.repo.createChannel(org, project.id, { name: "Webhook", type: "webhook", enabled: true, config: { url: "https://1.1.1.1/alerts" } });
  const incident = await db.repo.openAutoIncident({ organizationId: org, monitorId: m.id, title: "MCP down", auto: true }, { status: "investigating", body: "MCP failed" });
  const enqueue = (observation: string) => enqueueMcpAlert(db.repo, org, { kind: "incident.opened", incident: incident!, monitor: m }, [channel.id], observation);
  const due = () => db.query("update mcp_alert_outbox set next_attempt_at=now()-interval '1 second' where monitor_id=$1 and status='pending'", [m.id]);
  const outbox = () => db.query<{ id: string; status: string; attempts: number }>("select id,status,attempts from mcp_alert_outbox where monitor_id=$1 order by sequence", [m.id]);
  const deliveries = () => db.query<{ status: string; attempts: number; status_message: string | null }>(
    "select d.status,d.attempts,d.status_message from alert_delivery d join mcp_alert_outbox q on q.delivery_id=d.id where q.monitor_id=$1 order by q.sequence", [m.id]);
  const cleanup = async () => { await db.query("delete from organization where id=$1", [org]); await db.close(); };
  return { db, org, m, enqueue, due, outbox, deliveries, cleanup };
}

describe.skipIf(!url)("MCP outbox retries", () => {
  it("is not resent by the generic delivery sweep and retry worker", async () => {
    const t = await setup();
    try {
      await t.enqueue("dup");
      respond(500);
      expect(await drainMcpAlerts(t.db.repo, unmetered, 10, t.m.id)).toBe(1);
      expect(guardedFetch).toHaveBeenCalledTimes(1);
      // Old enough for the sweep to take the pending row for an orphan.
      await t.db.query("update alert_delivery set created_at=now()-interval '10 minutes' where id in (select delivery_id from mcp_alert_outbox where monitor_id=$1)", [t.m.id]);
      await sweepDeliveries(t.db.repo);
      await retryDeliveries(t.db.repo, 100);
      // Even a row a previous version already scheduled is left to the outbox.
      await t.db.query("update alert_delivery set next_attempt_at=now()-interval '1 second' where id in (select delivery_id from mcp_alert_outbox where monitor_id=$1)", [t.m.id]);
      await retryDeliveries(t.db.repo, 100);
      expect(guardedFetch).toHaveBeenCalledTimes(1);
      expect(await t.deliveries()).toEqual([{ status: "pending", attempts: 1, status_message: "failed: queued for retry" }]);
      respond(200);
      await t.due();
      expect(await drainMcpAlerts(t.db.repo, unmetered, 10, t.m.id)).toBe(1);
      expect(guardedFetch).toHaveBeenCalledTimes(2);
      expect(await t.outbox()).toMatchObject([{ status: "sent", attempts: 2 }]);
      expect(await t.deliveries()).toMatchObject([{ status: "sent", attempts: 2 }]);
    } finally { await t.cleanup(); }
  });

  it("fails for good after the attempt budget and stops blocking later alerts", async () => {
    const t = await setup();
    try {
      await t.enqueue("broken");
      respond(500);
      for (let i = 0; i < MAX_ATTEMPTS; i++) { await t.due(); expect(await drainMcpAlerts(t.db.repo, unmetered, 10, t.m.id)).toBe(1); }
      expect(await t.outbox()).toMatchObject([{ status: "failed", attempts: MAX_ATTEMPTS }]);
      expect(await t.deliveries()).toEqual([{ status: "failed", attempts: MAX_ATTEMPTS, status_message: `failed: gave up after ${MAX_ATTEMPTS} attempts` }]);
      await t.due();
      expect(await drainMcpAlerts(t.db.repo, unmetered, 10, t.m.id)).toBe(0);
      expect(guardedFetch).toHaveBeenCalledTimes(MAX_ATTEMPTS);
      respond(200);
      await t.enqueue("later");
      expect(await drainMcpAlerts(t.db.repo, unmetered, 10, t.m.id)).toBe(1);
      expect((await t.outbox()).map(row => row.status)).toEqual(["failed", "sent"]);
    } finally { await t.cleanup(); }
  });

  it("counts an expired lease as an attempt", async () => {
    const t = await setup();
    try {
      await t.enqueue("crash");
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const [task] = await t.db.repo.claimMcpAlerts(1, t.m.id, { maxAttempts: MAX_ATTEMPTS });
        expect(task.attempts).toBe(i);
        await t.db.query("update mcp_alert_outbox set lease_until=now()-interval '1 second' where id=$1", [task.id]);
      }
      expect(await t.db.repo.claimMcpAlerts(1, t.m.id, { maxAttempts: MAX_ATTEMPTS })).toEqual([]);
      expect(await t.outbox()).toMatchObject([{ status: "failed", attempts: MAX_ATTEMPTS }]);
      expect(await t.deliveries()).toMatchObject([{ status: "failed", attempts: MAX_ATTEMPTS }]);
    } finally { await t.cleanup(); }
  });

  it("lets failed tasks age out under the alert log retention while pending ones stay", async () => {
    const t = await setup();
    try {
      await t.enqueue("old-failed");
      await t.enqueue("old-pending");
      const [failed, pending] = await t.outbox();
      await t.db.query("update mcp_alert_outbox set status='failed' where id=$1", [failed.id]);
      await t.db.query("update alert_delivery set status='failed', created_at=now()-interval '400 days' where id in ($1,$2)", [failed.id, pending.id]);
      await t.db.repo.purgeExpired();
      expect((await t.outbox()).map(row => row.id)).toEqual([pending.id]);
    } finally { await t.cleanup(); }
  });

  it("ignores a malformed incident id when skipping obsolete tasks", async () => {
    const t = await setup();
    try {
      await t.enqueue("malformed");
      await t.db.query("update mcp_alert_outbox set event=jsonb_set(event,'{incident,id}','\"not-a-uuid\"') where monitor_id=$1", [t.m.id]);
      expect(await t.db.repo.claimMcpAlerts(1, t.m.id)).toHaveLength(1);
    } finally { await t.cleanup(); }
  });
});
