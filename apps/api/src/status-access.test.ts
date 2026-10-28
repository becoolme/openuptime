import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "./env";
import { publicStatus } from "./routes/status";
import { unmetered } from "./entitlements";
import { sharedCache, useEdgeCache } from "./sharedcache";
import { notifyIncidentUpdate } from "./alerts";

const page = { id: "p1", organizationId: "o1", slug: "acme", title: "Private title", mcpEnabled: true };
function setup(allowed: boolean | "throw") {
  const policy = vi.fn(async (_page: unknown, _request: Request) => { if (allowed === "throw") throw new Error("policy unavailable"); return { allowed }; });
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
    const res = await app.request("/api/public/status/acme/summary");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(board).not.toHaveBeenCalled();
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
