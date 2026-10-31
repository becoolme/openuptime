import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpConfig, McpObservation } from "@openuptime/repo";
import { createDb, createRepo, eq, schema } from "./index";

const url = process.env.DATABASE_URL;
const db = url ? createDb(url, { max: 4 }) : undefined!;
const repo = url ? createRepo(db) : undefined!;
const orgId = `mcp-storage-${crypto.randomUUID()}`;
const config: McpConfig = { requiredTools: ["search"], schemaCheck: true, toolCall: null, oauth: null };
const observation: McpObservation = { stage: "complete", timings: { initialize: 10, "tools/list": 20 },
  tools: [{ name: "search", inputSchema: { type: "object", properties: { q: { type: "string" } } } }], changes: [] };

describe.skipIf(!url)("MCP observation persistence", () => {
  beforeAll(async () => {
    await db.insert(schema.organization).values({ id: orgId, name: "MCP storage", slug: orgId, createdAt: new Date() });
  });
  afterAll(async () => {
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await db.$client.end();
  });
  async function monitor(extra: Partial<typeof schema.monitor.$inferInsert> = {}) {
    const [m] = await db.insert(schema.monitor).values({ organizationId: orgId, name: "MCP", type: "mcp",
      target: "https://mcp.example.com/mcp", nextCheckAt: new Date("2100-01-01T00:00:00Z"), mcpConfig: config, ...extra }).returning();
    return m;
  }
  const reviewed = (m: { mcpObservation: McpObservation | null }) => ({ observationId: m.mcpObservation!.id!, schemaHash: m.mcpObservation!.schemaHash! });
  async function load(id: string) {
    const [m] = await db.select().from(schema.monitor).where(eq(schema.monitor.id, id));
    return m;
  }

  it("establishes a baseline once and keeps it across subsequent discoveries", async () => {
    const m = await monitor();
    expect(await repo.acceptMcpObservation(m, observation, { ok: true })).toBe(true);
    const first = await load(m.id);
    expect(first.mcpBaseline).toEqual(observation.tools);
    const changed = { ...observation, stage: "schema" as const, tools: [], changes: ["Tool removed: search"] };
    expect(await repo.acceptMcpObservation(first, changed, { ok: false })).toBe(true);
    const second = await load(m.id);
    expect(second.mcpBaseline).toEqual(observation.tools);
    expect(second.mcpObservation).toMatchObject(changed);
  });

  it("never baselines failed or incomplete checks, or checks with schema monitoring disabled", async () => {
    const m = await monitor();
    expect(await repo.acceptMcpObservation(m, observation, { ok: false })).toBe(true);
    expect((await load(m.id)).mcpBaseline).toBeNull();
    expect(await repo.acceptMcpObservation(await load(m.id), { ...observation, stage: "tools/list" }, { ok: true })).toBe(true);
    expect((await load(m.id)).mcpBaseline).toBeNull();
    const off = await monitor({ mcpConfig: { ...config, schemaCheck: false } });
    expect(await repo.acceptMcpObservation(off, observation, { ok: true })).toBe(true);
    expect((await load(off.id)).mcpBaseline).toBeNull();
  });

  it("preserves baseline on no-op edits and invalidates stale observations after real configuration changes", async () => {
    const m = await monitor();
    await repo.acceptMcpObservation(m, observation, { ok: true });
    const first = await load(m.id);
    const noOp = await repo.updateMonitor(orgId, m.id, null, { target: m.target, mcpConfig: { ...config } });
    expect(noOp?.coverageRevision).toBe(first.coverageRevision);
    expect(noOp?.mcpBaseline).toEqual(observation.tools);
    const updated = await repo.updateMonitor(orgId, m.id, null, { mcpConfig: { ...config, requiredTools: ["lookup"] } });
    expect(updated?.mcpBaseline).toEqual(observation.tools);
    expect(updated?.mcpObservation).toBeNull();
    expect(updated?.coverageRevision).toBe(first.coverageRevision + 1);
    expect(await repo.acceptMcpObservation(first, observation, { ok: true })).toBe(false);
  });

  it("treats required-tool ordering and JSON object-key ordering as no-op edits", async () => {
    const original: McpConfig = { ...config, requiredTools: ["search", "lookup"], toolCall: {
      enabled: true, name: "search", arguments: { a: 1, nested: { b: 2, c: 3 } }, assertions: [],
    } };
    const m = await monitor({ mcpConfig: original });
    await repo.acceptMcpObservation(m, observation, { ok: true });
    const updated = await repo.updateMonitor(orgId, m.id, null, { mcpConfig: {
      ...original, requiredTools: ["lookup", "search"], toolCall: { ...original.toolCall!, arguments: { nested: { c: 3, b: 2 }, a: 1 } },
    } });
    expect(updated?.mcpBaseline).toEqual(observation.tools);
    expect(updated?.coverageRevision).toBe(m.coverageRevision);
  });

  it("preserves approved schemas across tool arguments, assertions and schema-check toggles", async () => {
    const m = await monitor();
    await repo.acceptMcpObservation(m, observation, { ok: true });
    let current = await load(m.id);
    const changes: McpConfig[] = [
      { ...config, toolCall: { enabled: true, name: "search", arguments: { q: "first" }, assertions: [] } },
      { ...config, toolCall: { enabled: true, name: "search", arguments: { q: "second" }, assertions: [] } },
      { ...config, toolCall: { enabled: true, name: "search", arguments: { q: "second" }, assertions: [{ path: "/content/0/text", operator: "contains", value: "ok" }] } },
      { ...config, schemaCheck: false },
      { ...config, schemaCheck: true },
      { ...config, toolCall: { enabled: false, name: "search", arguments: { q: "saved" }, assertions: [] } },
      // Saving a form whose optional tool call is disabled normalizes the saved config to null.
      { ...config, toolCall: null },
    ];
    for (const nextConfig of changes) {
      const updated = await repo.updateMonitor(orgId, m.id, null, { mcpConfig: nextConfig });
      expect(updated?.mcpBaseline).toEqual(observation.tools);
      expect(updated?.mcpObservation).toBeNull();
      if (updated?.coverageRevision !== current.coverageRevision) expect(await repo.acceptMcpObservation(current, observation, { ok: true })).toBe(false);
      current = await load(m.id);
    }
    const breaking = { ...observation, stage: "schema" as const, tools: [], changes: ["Tool removed: search"] };
    expect(await repo.acceptMcpObservation(current, breaking, { ok: false })).toBe(true);
    expect((await load(m.id)).mcpBaseline).toEqual(observation.tools);
  });

  it("preserves diagnostics when UI defaults or disabled drafts normalize without changing the check", async () => {
    const original = { ...config, toolCall: { enabled: false, name: "draft", arguments: { saved: true }, assertions: [] } };
    const m = await monitor({ mcpConfig: original });
    await repo.acceptMcpObservation(m, observation, { ok: true });
    const before = await load(m.id);
    const updated = await repo.updateMonitor(orgId, m.id, null, { mcpConfig: { ...config, transport: "auto", listPrompts: false, listResources: false, driftPolicy: "down" } });
    expect(updated?.coverageRevision).toBe(before.coverageRevision);
    expect(updated?.mcpObservation).toEqual(before.mcpObservation);
    expect(updated?.mcpBaseline).toEqual(before.mcpBaseline);
  });

  it("invalidates baselines when credentials or endpoint change", async () => {
    const m = await monitor();
    await repo.acceptMcpObservation(m, observation, { ok: true });
    const updated = await repo.updateMonitor(orgId, m.id, null, { headers: { Authorization: "Bearer test-only" } });
    expect(updated?.mcpBaseline).toBeNull();
    await repo.acceptMcpObservation(updated!, observation, { ok: true });
    const target = await repo.updateMonitor(orgId, m.id, null, { target: "https://other.example.com/mcp" });
    expect(target?.mcpBaseline).toBeNull();
  });

  it("accepts only the exact reviewed complete snapshot under project scope", async () => {
    const [project] = await db.insert(schema.project).values({ organizationId: orgId, name: "MCP" }).returning();
    const m = await monitor({ projectId: project.id });
    await repo.acceptMcpObservation(m, observation, { ok: true });
    const first = await load(m.id);
    const changed = { ...observation, stage: "schema" as const, tools: [], changes: ["Tool removed: search"] };
    await repo.acceptMcpObservation(first, changed, { ok: false });
    const candidate = await load(m.id);
    expect(await repo.acceptMcpBaseline("other-org", m.id, null, reviewed(candidate))).toEqual({ status: "not_found" });
    expect(await repo.acceptMcpBaseline(orgId, m.id, [], reviewed(candidate))).toEqual({ status: "not_found" });
    expect(await repo.acceptMcpBaseline(orgId, m.id, null, reviewed(first))).toEqual({ status: "stale" });
    expect(await repo.acceptMcpBaseline(orgId, m.id, null, { ...reviewed(candidate), schemaHash: "changed" })).toEqual({ status: "stale" });
    expect((await load(m.id)).mcpBaseline).toEqual(observation.tools);
    const accepted = await repo.acceptMcpBaseline(orgId, m.id, [project.id], reviewed(candidate));
    expect(accepted.status).toBe("accepted");
    const current = await load(m.id);
    expect(current.mcpBaseline).toEqual([]);
    expect(current.coverageRevision).toBe(candidate.coverageRevision + 1);
    expect(await repo.acceptMcpObservation(candidate, observation, { ok: true })).toBe(false);
    await repo.acceptMcpObservation(current, { ...observation, stage: "tools/list", tools: [] }, { ok: false });
    expect(await repo.acceptMcpBaseline(orgId, m.id, null, reviewed(await load(m.id)))).toEqual({ status: "incomplete" });
  });

  it("rejects duplicate, older completed and unclaimed scheduled runs", async () => {
    const m = await monitor({ runGeneration: 3 });
    expect(await repo.acceptMcpObservation(m, observation, { generation: 4, ok: false })).toBe(false);
    expect(await repo.acceptMcpObservation(m, observation, { generation: 2, ok: false })).toBe(true);
    expect(await repo.acceptMcpObservation(m, observation, { generation: 1, ok: false })).toBe(false);
    expect(await repo.acceptMcpObservation(m, observation, { generation: 2, ok: false })).toBe(false);
    expect(await repo.acceptMcpObservation(m, observation, { generation: 3, ok: false })).toBe(true);
  });

  it("prevents a manual result replacing a run claimed or completed after it started", async () => {
    const m = await monitor();
    await db.update(schema.monitor).set({ runGeneration: 1 }).where(eq(schema.monitor.id, m.id));
    expect(await repo.acceptMcpObservation(m, observation, { ok: false })).toBe(false);
    const claimed = await load(m.id);
    expect(await repo.acceptMcpObservation(claimed, observation, { generation: 1, ok: false })).toBe(true);
    expect(await repo.acceptMcpObservation(claimed, observation, { ok: false })).toBe(false);
  });

  it("serializes simultaneous first baselines and rejects checks evaluated without the winner's baseline", async () => {
    const m = await monitor();
    const results = await Promise.all([
      repo.acceptMcpObservation(m, observation, { ok: true }),
      repo.acceptMcpObservation(m, { ...observation, tools: [] }, { ok: true }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("serializes complete result application and supplies the latest committed state", async () => {
    const m = await monitor({ status: "up", mcpConfig: { ...config, schemaCheck: false } });
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = repo.withMcpResult(m, async (transactionRepo, current) => {
      expect(current.status).toBe("up");
      await transactionRepo.setMonitorState(m.id, { status: "down", consecutiveFailures: 1 });
      started();
      await gate;
      return "first";
    });
    await entered;
    // Other connections cannot observe half-applied state before the complete result commits.
    expect((await load(m.id)).status).toBe("up");
    const second = repo.withMcpResult(m, async (transactionRepo, current) => {
      expect(current.status).toBe("down");
      expect(current.consecutiveFailures).toBe(1);
      await transactionRepo.setMonitorState(m.id, { consecutiveFailures: current.consecutiveFailures + 1 });
      return "second";
    });
    release();
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
    expect((await load(m.id)).consecutiveFailures).toBe(2);
  });

  it("rolls back diagnostics, baseline, coverage and state together if result application fails", async () => {
    const m = await monitor({ status: "up" });
    await expect(repo.withMcpResult(m, async (transactionRepo) => {
      expect(await transactionRepo.acceptMcpObservation(m, observation, { ok: true })).toBe(true);
      expect(await transactionRepo.recordObservation(m, { ok: true, latencyMs: 10 })).toBe(true);
      await transactionRepo.setMonitorState(m.id, { status: "down" });
      throw new Error("fixture apply failed");
    })).rejects.toThrow("fixture apply failed");
    expect(await load(m.id)).toMatchObject({ status: "up", mcpBaseline: null, mcpObservation: null });
    expect(await db.select().from(schema.monitorObservation).where(eq(schema.monitorObservation.monitorId, m.id))).toHaveLength(0);
  });

  it("rejects application after a new claim, config edit or baseline reset", async () => {
    const m = await monitor();
    const apply = async () => { throw new Error("stale result must not be applied"); };
    await db.update(schema.monitor).set({ runGeneration: 1 }).where(eq(schema.monitor.id, m.id));
    expect(await repo.withMcpResult(m, apply)).toBeNull();
    const claimed = await load(m.id);
    await repo.updateMonitor(orgId, m.id, null, { target: "https://changed.example.com/mcp" });
    expect(await repo.withMcpResult(claimed, apply)).toBeNull();
    const changed = await load(m.id);
    await repo.acceptMcpObservation(changed, observation, { ok: true });
    const seen = await load(m.id);
    await repo.acceptMcpBaseline(orgId, m.id, null, reviewed(seen));
    expect(await repo.withMcpResult(changed, apply)).toBeNull();
  });

  it("rotates OAuth tokens atomically and preserves rotated secrets during unrelated edits", async () => {
    const oauth = { mode: "refresh_token" as const, issuer: "https://issuer.example", clientId: "fixture", refreshToken: "old" };
    const m = await monitor({ mcpConfig: { ...config, oauth } });
    expect(await repo.withMcpOAuth(m, async (tx, current) => tx.rotateMcpRefreshToken(current, "old", "new"))).toBe(true);
    const rotated = await load(m.id);
    expect(rotated.coverageRevision).toBe(m.coverageRevision);
    const { oauth: _oauth, ...withoutOAuth } = config;
    const edited = await repo.updateMonitor(orgId, m.id, null, { mcpConfig: { ...withoutOAuth, requiredTools: ["other"] } });
    expect(edited?.mcpConfig?.oauth?.refreshToken).toBe("new");
    expect(await repo.rotateMcpRefreshToken(m, "old", "stale")).toBe(false);
    const cleared = await repo.updateMonitor(orgId, m.id, null, { mcpConfig: { ...config, oauth: null } });
    expect(cleared?.mcpConfig?.oauth).toBeNull();
  });

  it("refuses concurrent OAuth refresh rather than waiting to reuse a rotating token", async () => {
    const m = await monitor();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const first = repo.withMcpOAuth(m, async () => { entered(); await gate; return "first"; });
    await ready;
    expect(await repo.withMcpOAuth(m, async () => "second")).toBeNull();
    release();
    expect(await first).toBe("first");
  });

  it("keeps the stored rotated refresh token when an edit omits it", async () => {
    const oauth = { mode: "refresh_token" as const, issuer: "https://issuer.example", clientId: "fixture", refreshToken: "r1" };
    const m = await monitor({ mcpConfig: { ...config, oauth } });
    // A scheduled check rotates r1 to r2 while an edit form is open.
    expect(await repo.rotateMcpRefreshToken(m, "r1", "r2")).toBe(true);
    const { refreshToken: _r1, ...formOAuth } = oauth;
    const edited = await repo.updateMonitor(orgId, m.id, null, { mcpConfig: { ...config, oauth: { ...formOAuth, scopes: ["read"] } } });
    expect(edited?.mcpConfig?.oauth).toMatchObject({ refreshToken: "r2", scopes: ["read"] });
    const replaced = await repo.updateMonitor(orgId, m.id, null, { mcpConfig: { ...config, oauth: { ...formOAuth, refreshToken: "typed" } } });
    expect(replaced?.mcpConfig?.oauth?.refreshToken).toBe("typed");
  });

  it("holds no transaction or row lock during the OAuth token request", async () => {
    const oauth = { mode: "refresh_token" as const, issuer: "https://issuer.example", clientId: "fixture", refreshToken: "old" };
    const m = await monitor({ mcpConfig: { ...config, oauth } });
    const result = await repo.withMcpOAuth(m, async (storage, current) => {
      // Under the former FOR UPDATE lock this edit of the same row would wait for the token request.
      const edit = repo.updateMonitor(orgId, m.id, null, { name: "Edited during refresh" });
      const settled = await Promise.race([edit.then(() => "edited"), new Promise(resolve => setTimeout(() => resolve("blocked"), 2000))]);
      // Many concurrent statements on a small pool still progress while the refresh is pending.
      await Promise.all(Array.from({ length: 8 }, () => repo.getMonitor(orgId, m.id, null)));
      return { settled, rotated: await storage.rotateMcpRefreshToken(current, "old", "new") };
    });
    expect(result).toEqual({ settled: "edited", rotated: true });
    expect((await load(m.id)).mcpConfig?.oauth?.refreshToken).toBe("new");
    expect(await db.select().from(schema.mcpOAuthLease).where(eq(schema.mcpOAuthLease.monitorId, m.id))).toHaveLength(0);
  });

  it("releases the OAuth lease after a failure and takes over an expired one", async () => {
    const m = await monitor();
    await expect(repo.withMcpOAuth(m, async () => { throw new Error("token endpoint failed"); })).rejects.toThrow("token endpoint failed");
    expect(await repo.withMcpOAuth(m, async () => "after failure")).toBe("after failure");
    // A holder that died leaves its row behind; it blocks until it expires, then the next check proceeds.
    await db.insert(schema.mcpOAuthLease).values({ monitorId: m.id, leaseToken: crypto.randomUUID(), leaseUntil: new Date(Date.now() + 60_000) });
    expect(await repo.withMcpOAuth(m, async () => "blocked")).toBeNull();
    await db.update(schema.mcpOAuthLease).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(schema.mcpOAuthLease.monitorId, m.id));
    expect(await repo.withMcpOAuth(m, async () => "taken over")).toBe("taken over");
  });

  it("stores bounded history, stage percentiles, and a scoped drift timeline", async () => {
    const m = await monitor();
    for (const latencyMs of [10, 20, 30]) await repo.recordCheck({ monitorId: m.id, ok: true, latencyMs, mcp: {
      stage: "complete", timings: { initialize: latencyMs / 2 }, changes: latencyMs === 30 ? ["search changed"] : [],
    } });
    const history = await repo.mcpHistory(orgId, m.id, null, { days: 7 });
    expect(history?.results).toHaveLength(3);
    expect(history?.metrics).toMatchObject({ samples: 3, p50: 20, p95: 29, stages: { initialize: { p50: 10, p95: 14.5 } } });
    expect(history?.changes).toHaveLength(1);
    expect(history?.changes[0]).toMatchObject({ severity: "breaking", changes: ["search changed"] });
    expect(await repo.mcpHistory("other-org", m.id, null)).toBeNull();
  });

  it("commits recipient tasks atomically, deduplicates, and recovers leases in recipient order", async () => {
    const m = await monitor();
    const event = { kind: "incident.opened" as const, incident: { id: crypto.randomUUID(), title: "MCP changed" },
      monitor: { id: m.id, projectId: null, name: m.name, target: m.target, type: "mcp" as const } };
    const task = { eventKey: "one-" + m.id, organizationId: orgId, monitorId: m.id, recipient: "channel:" + crypto.randomUUID(), channelId: null, event };
    await expect(repo.withMcpResult(m, async tx => { await tx.enqueueMcpAlerts([task]); throw new Error("rollback"); })).rejects.toThrow("rollback");
    expect(await repo.claimMcpAlerts(10, m.id)).toEqual([]);
    await Promise.all([repo.enqueueMcpAlerts([task]), repo.enqueueMcpAlerts([task])]);
    await repo.enqueueMcpAlerts([{ ...task, eventKey: "two-" + m.id, event: { ...event, kind: "incident.resolved" } }]);
    const [first] = await repo.claimMcpAlerts(10, m.id);
    expect(first.eventKey).toBe(task.eventKey);
    expect(await repo.claimMcpAlerts(10, m.id)).toEqual([]);
    await db.update(schema.mcpAlertOutbox).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(schema.mcpAlertOutbox.id, first.id));
    const [reclaimed] = await repo.claimMcpAlerts(10, m.id);
    expect(reclaimed.id).toBe(first.id);
    expect(reclaimed.leaseToken).not.toBe(first.leaseToken);
    expect(await repo.finishMcpAlert(first.id, first.leaseToken, { status: "sent" })).toBe(false);
    expect(await repo.finishMcpAlert(reclaimed.id, reclaimed.leaseToken, { status: "sent" })).toBe(true);
    const [second] = await repo.claimMcpAlerts(10, m.id);
    expect(second.event.kind).toBe("incident.resolved");
    expect(second.event).not.toHaveProperty("monitor.headers");
    expect(await repo.finishMcpAlert(second.id, second.leaseToken, { status: "retry", error: "temporary" })).toBe(true);
    expect(await repo.claimMcpAlerts(10, m.id)).toEqual([]);
    await db.update(schema.mcpAlertOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(schema.mcpAlertOutbox.id, second.id));
    expect((await repo.claimMcpAlerts(10, m.id))[0].attempts).toBe(1);
  });

  it("does not let an obsolete delayed down retry block its recovery", async () => {
    const m = await monitor();
    const incident = await repo.openAutoIncident({ organizationId: orgId, monitorId: m.id, title: "MCP down", auto: true }, { status: "investigating", body: "failed" });
    const event = { kind: "incident.opened" as const, incident: { id: incident!.id, title: "MCP down" }, monitor: { id: m.id, projectId: null, name: m.name, target: m.target, type: "mcp" as const } };
    const task = { eventKey: "down-" + m.id, organizationId: orgId, monitorId: m.id, recipient: "subscriber:fixture", channelId: null, event };
    await repo.enqueueMcpAlerts([task]);
    const [down] = await repo.claimMcpAlerts(1, m.id);
    await repo.finishMcpAlert(down.id, down.leaseToken, { status: "retry", retryInSec: 3600 });
    await repo.resolveIncident(incident!.id, "recovered");
    await repo.enqueueMcpAlerts([{ ...task, eventKey: "up-" + m.id, event: { ...event, kind: "incident.resolved" } }]);
    const ready = await repo.claimMcpAlerts(2, m.id);
    expect(ready).toHaveLength(1);
    expect(ready[0].event.kind).toBe("incident.resolved");
    const [old] = await db.select().from(schema.mcpAlertOutbox).where(eq(schema.mcpAlertOutbox.id, down.id));
    expect(old.status).toBe("skipped");
  });

  it("does not accept MCP observations or reset on other monitor types, paused or deleted monitors", async () => {
    const other = await monitor({ type: "http" });
    expect(await repo.acceptMcpObservation(other, observation, { ok: true })).toBe(false);
    expect(await repo.resetMcpBaseline(orgId, other.id, null, { observationId: "none", schemaHash: "none" })).toBeNull();
    const paused = await monitor({ paused: true });
    expect(await repo.acceptMcpObservation(paused, observation, { ok: true })).toBe(false);
    await db.delete(schema.monitor).where(eq(schema.monitor.id, paused.id));
    expect(await repo.acceptMcpObservation(paused, observation, { ok: true })).toBe(false);
  });
});
