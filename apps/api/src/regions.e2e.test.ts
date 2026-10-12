import { openDatabase } from "@openuptime/db-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { configureProbes } from "./probes";
import type { Edition } from "./edition";
import { unmetered } from "./entitlements";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const PROBES = {
  "us-east": "https://probe.test/api/probe/us-east",
  "eu-central": "https://probe.test/api/probe/eu-central",
  "ap-southeast": "https://probe.test/api/probe/ap-southeast",
};
const env = {
  DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron",
  PROBE_SECRET: "probe-secret", PROBE_REGIONS: JSON.stringify(PROBES),
};

/** A plan that allows two regions per monitor. */
const edition: Edition = {
  entitlements: () => ({
    ...unmetered,
    plan: async () => ({ id: "two", name: "Two", maxActiveMonitors: 50, minIntervalSec: 60, maxRegions: 2, upgradeUrl: "https://example.com/upgrade" }),
  }),
};

describe.skipIf(!url)("regions", () => {
  const app = createApp(openDatabase, { edition });
  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  // what each probe answers; a probe not listed is down
  const answers: Record<string, { ok: boolean; statusCode?: number; latencyMs?: number; error?: string } | "down"> = {};

  beforeAll(() => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input instanceof Request ? input.url : input);
      if (!u.startsWith("https://probe.test/")) return realFetch(input, init);
      const id = u.split("/").pop()!;
      asked.push(id);
      const a = answers[id] ?? "down";
      if (a === "down") throw new Error("connect ECONNREFUSED");
      return new Response(JSON.stringify(a), { headers: { "content-type": "application/json" } });
    });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    configureProbes({});
  });

  async function signedIn(send: (path: string, init?: RequestInit) => Response | Promise<Response> = raw) {
    await send("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const su = await send("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `regions-${Date.now()}@example.com`, password: "correct horse battery", name: "Ada" }),
    });
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return async (method: string, path: string, body?: unknown) => {
      const r = await send(`/api${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };
  }
  const web = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: "http", target: "https://example.com", intervalSec: 60, ...extra });

  it("lists the regions of this deployment with the plan's cap", async () => {
    const call = await signedIn();
    const r = await call("GET", "/regions");
    expect(r.status).toBe(200);
    expect(r.body.regions.map((x: { id: string }) => x.id)).toEqual(["auto", "us-east", "eu-central", "ap-southeast"]);
    expect(r.body).toMatchObject({ types: ["http", "tcp"], maxPerMonitor: 2 });
  });

  it("puts no limit on the regions of one monitor in the community edition", async () => {
    const community = createApp(openDatabase);
    const call = await signedIn((path, init = {}) => community.fetch(new Request(`${ORIGIN}${path}`, init), env as never));
    const r = await call("GET", "/regions");
    expect(r.body.maxPerMonitor).toBeNull();
    // the plan above stops at two; with none, every configured region is allowed, and a repeated one counts once
    const all = await call("POST", "/monitors", web("Everywhere", { regions: ["us-east", "eu-central", "ap-southeast", "us-east"] }));
    expect(all.status).toBe(201);
    expect(all.body.regions).toEqual(["us-east", "eu-central", "ap-southeast"]);
  });

  it("runs from auto unless regions are asked for, and validates the ones that are", async () => {
    const call = await signedIn();
    const plain = await call("POST", "/monitors", web("Plain"));
    expect(plain.status).toBe(201);
    expect(plain.body.regions).toEqual(["auto"]);

    const two = await call("POST", "/monitors", web("Two", { regions: ["eu-central", "us-east"] }));
    expect(two.status).toBe(201);
    expect(two.body.regions).toEqual(["eu-central", "us-east"]);

    const three = await call("POST", "/monitors", web("Three", { regions: ["eu-central", "us-east", "ap-southeast"] }));
    expect(three.status).toBe(402);
    expect(three.body).toMatchObject({ code: "regions_not_allowed", limit: 2 });

    const nowhere = await call("POST", "/monitors", web("Nowhere", { regions: ["sa-east"] }));
    expect(nowhere.status).toBe(400);
    expect(nowhere.body).toMatchObject({ code: "unknown_region", regions: ["sa-east"] });

    const dns = await call("POST", "/monitors", { name: "DNS", type: "dns", target: "example.com", regions: ["us-east"] });
    expect(dns.status).toBe(400);
    expect(dns.body.code).toBe("regions_not_supported");

    expect((await call("POST", "/monitors", web("Bad id", { regions: ["Not An Id"] }))).status).toBe(400);
    expect((await call("POST", "/monitors", web("Empty", { regions: [] }))).status).toBe(400);

    // changing regions goes through the same checks
    expect((await call("PATCH", `/monitors/${plain.body.id}`, { regions: ["ap-southeast"] })).body.regions).toEqual(["ap-southeast"]);
    expect((await call("PATCH", `/monitors/${plain.body.id}`, { regions: ["a-b-c"] })).status).toBe(400);
    expect((await call("PATCH", `/monitors/${plain.body.id}`, { regions: ["us-east", "eu-central", "ap-southeast"] })).status).toBe(402);
  });

  it("runs a check from every region of the monitor and shows each region's result", async () => {
    const call = await signedIn();
    const m = (await call("POST", "/monitors", web("Both", { regions: ["us-east", "eu-central"] }))).body;
    answers["us-east"] = { ok: true, statusCode: 200, latencyMs: 40 };
    answers["eu-central"] = { ok: false, statusCode: 503, latencyMs: 90, error: "Expected 200, got 503" };
    asked.length = 0;
    expect((await call("POST", `/monitors/${m.id}/check`)).body).toEqual({ ok: true });
    expect(asked.sort()).toEqual(["eu-central", "us-east"]);

    const detail = (await call("GET", `/monitors/${m.id}`)).body;
    const regions = Object.fromEntries(detail.regionStats.map((r: { region: string }) => [r.region, r]));
    expect(Object.keys(regions).sort()).toEqual(["eu-central", "us-east"]);
    expect(regions["us-east"]).toMatchObject({ checks24h: 1, uptime24h: 100, avgLatency24h: 40, last: { ok: true, statusCode: 200 } });
    expect(regions["eu-central"]).toMatchObject({ checks24h: 1, uptime24h: 0, last: { ok: false, error: "Expected 200, got 503" } });
    expect(detail.results.map((c: { region: string }) => c.region).sort()).toEqual(["eu-central", "us-east"]);
    // one region failing out of two is not a majority: the monitor is not down
    expect(detail.status).not.toBe("down");
  });

  it("sends a single manual request from the named region without recording it", async () => {
    const call = await signedIn();
    const m = (await call("POST", "/monitors", web("Spot", { regions: ["us-east"] }))).body;
    answers["ap-southeast"] = { ok: true, statusCode: 200, latencyMs: 210 };
    asked.length = 0;
    const r = await call("POST", `/monitors/${m.id}/check`, { region: "ap-southeast" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, region: "ap-southeast", result: { ok: true, statusCode: 200, latencyMs: 210 } });
    expect(asked).toEqual(["ap-southeast"]);
    expect((await call("GET", `/monitors/${m.id}`)).body.regionStats).toEqual([]);

    delete answers["ap-southeast"];
    const down = await call("POST", `/monitors/${m.id}/check`, { region: "ap-southeast" });
    expect(down.status).toBe(502);
    expect(down.body).toMatchObject({ code: "probe_unreachable", region: "ap-southeast" });
    expect((await call("POST", `/monitors/${m.id}/check`, { region: "sa-east" })).status).toBe(400);
  });

  it("keeps imports working across deployments: unknown regions fall back to auto, extras are trimmed to the plan", async () => {
    const call = await signedIn();
    const r = await call("POST", "/monitors/import", [
      web("Elsewhere", { regions: ["sa-east"] }),
      web("Many", { regions: ["us-east", "eu-central", "ap-southeast"] }),
      web("Known", { regions: ["eu-central"] }),
    ]);
    expect(r.status).toBe(201);
    const list = (await call("GET", "/monitors")).body as { name: string; regions: string[] }[];
    const by = Object.fromEntries(list.map((m) => [m.name, m.regions]));
    expect(by).toMatchObject({ Elsewhere: ["auto"], Many: ["us-east", "eu-central"], Known: ["eu-central"] });
  });
});
