import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "./env";
import { publicStatus } from "./routes/status";
import { unmetered } from "./entitlements";
import { sharedCache, useEdgeCache } from "./sharedcache";
import { dispatchAlert, notifyIncidentUpdate } from "./alerts";

const page = { id: "p1", organizationId: "o1", slug: "acme", title: "Private title", mcpEnabled: true };
function setup(allowed: boolean | "throw") {
  const policy = vi.fn(async (_page: unknown, _request: Request) => { if (allowed === "throw") throw new Error("policy unavailable: secret token"); return { allowed }; });
  const board = vi.fn(async () => ({ components: [], incidents: [], bucket: "day" }));
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("repo", { statusPageBySlug: async () => page, statusBoard: board } as never);
    c.set("entitlements", { ...unmetered, statusPageAccess: policy });
    await next();
  });
  app.route("/api/public/status", publicStatus);
  return { app, policy, board };
}

describe("status access boundary", () => {
  it.each(["true", 1, {}])("rejects malformed page approvals %j", async (value) => {
    const { app } = setup(value as never);
    expect((await app.request("/api/public/status/acme/summary")).status).toBe(404);
  });
  it.each(["", "/summary", "/badge.svg", "/incidents", "/rss", "/rss.xml", "/maintenance", "/maintenance.ics", "/llms.txt", "?via=mcp"])("denies %s before loading content", async (suffix) => {
    const { app, policy, board } = setup(false);
    const res = await app.request(`/api/public/status/acme${suffix}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.text()).not.toContain("Private title");
    expect(policy).toHaveBeenCalled();
    expect(board).not.toHaveBeenCalled();
  });
  it("checks subscriptions before processing the email", async () => {
    const { app } = setup(false);
    const res = await app.request("/api/public/status/acme/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.com" }) });
    expect(res.status).toBe(404);
  });
  it("checks each request, passes cookies, and overrides public feed cache headers", async () => {
    const { app, policy, board } = setup(true);
    const res = await app.request("/api/public/status/acme/summary", { headers: { cookie: "session=visitor" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(policy.mock.calls[0][1].headers.get("cookie")).toBe("session=visitor");
    expect(board).toHaveBeenCalledOnce();
  });
  it("does not serve content after a policy exception", async () => {
    const { app, board } = setup("throw");
    app.onError((_e, c) => c.json({ error: "Unavailable" }, 503));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await app.request("/api/public/status/acme/summary");
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(board).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("status page access policy unavailable");
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret token");
    } finally { log.mockRestore(); }
  });
  it("bypasses both warmed memory and shared caches without writing private content", async () => {
    const edge = { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) };
    useEdgeCache(edge);
    try {
      const cache = sharedCache<string>("policy-test", 60_000);
      await cache.cached("page", async () => "public");
      edge.get.mockClear(); edge.put.mockClear();
      expect(await cache.cached("page", async () => "private", undefined, { bypass: true })).toBe("private");
      expect(edge.get).not.toHaveBeenCalled(); expect(edge.put).not.toHaveBeenCalled();
      expect(await cache.cached("page", async () => "new")).toBe("public");
    } finally { useEdgeCache(undefined); }
  });
  it("filters notifications before quota and fails closed if policy fails", async () => {
    const spend = vi.fn(async (_org: string, count: number) => count);
    const repo = { subscribersFor: async () => [{ email: "a@example.com", slug: "acme" }] } as never;
    const inc = { organizationId: "o", monitorId: "m", title: "Private incident" };
    const update = { status: "investigating", body: "Detail" };
    await notifyIncidentUpdate(repo, inc, update, { ...unmetered, spendEmails: spend, canNotifySubscriber: async () => false });
    expect(spend).not.toHaveBeenCalled();
    const fetch = vi.spyOn(globalThis, "fetch");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(notifyIncidentUpdate(repo, inc, update, { ...unmetered, spendEmails: spend, canNotifySubscriber: async () => { throw new Error("Policy unavailable: secret"); } })).resolves.toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("incident update subscriber policy unavailable");
    } finally {
      fetch.mockRestore(); log.mockRestore();
    }
    expect(spend).not.toHaveBeenCalled();
  });
});

describe("subscriber policy failure reporting", () => {
  const ev = { kind: "incident.opened" as const, incident: { id: "i", title: "Incident" }, monitor: { id: "m", name: "API", target: "https://example.com" } };
  function setupSubscribers(count = 1) {
    const logged: unknown[] = [];
    const subs = Array.from({ length: count }, (_, index) => ({ email: `s${index}@example.com`, slug: "acme" }));
    const repo = { listProjects: async () => [], channelsToAlert: async () => [], logDeliveries: async (rows: unknown[]) => { logged.push(...rows); }, queueDeliveries: async () => [], subscribersFor: async () => subs } as never;
    return { repo, logged };
  }
  it("records sanitized policy failures without sending or spending", async () => {
    const { repo, logged } = setupSubscribers(); const spend = vi.fn(async () => 1);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      await dispatchAlert(repo, "o", ev, [], { ...unmetered, spendEmails: spend, canNotifySubscriber: async () => { throw new Error("secret token and email"); } });
      expect(spend).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
      expect(JSON.stringify([logged, log.mock.calls])).not.toContain("secret token");
      expect(logged).toContainEqual(expect.objectContaining({ status: "failed", error: "1/1 failed: subscriber policy unavailable" }));
    } finally { log.mockRestore(); fetch.mockRestore(); }
  });
  it.each([{ allowed: false }, "true", 1, null, undefined])("records malformed subscriber approval %j as skipped", async (value) => {
    const { repo, logged } = setupSubscribers(); const spend = vi.fn(async () => 1);
    await dispatchAlert(repo, "o", ev, [], { ...unmetered, spendEmails: spend, canNotifySubscriber: async () => value as never });
    expect(spend).not.toHaveBeenCalled();
    expect(logged).toContainEqual(expect.objectContaining({ status: "skipped", error: expect.stringContaining("subscriber access policy") }));
  });
  it("bounds policy concurrency while avoiding serial evaluation of large lists", async () => {
    const { repo, logged } = setupSubscribers(25);
    let active = 0, max = 0, calls = 0;
    await dispatchAlert(repo, "o", ev, [], { ...unmetered, canNotifySubscriber: async () => {
      active++; calls++; max = Math.max(max, active);
      await new Promise(resolve => setTimeout(resolve, 1)); active--; return false;
    } });
    expect(calls).toBe(25); expect(max).toBe(8); expect(active).toBe(0);
    expect(logged).toContainEqual(expect.objectContaining({ status: "skipped" }));
  });
});
