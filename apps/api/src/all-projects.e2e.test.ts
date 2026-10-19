import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };

describe.skipIf(!url)("All projects view", () => {
  const app = createApp(openDatabase);
  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);
  const signUp = async (tag: string) => {
    await raw("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const su = await raw("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: "correct horse battery", name: "Ada" }),
    });
    expect(su.status).toBe(200);
    return su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  };
  const make = (cookie: string, extra: Record<string, string> = {}) => async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await raw(`/api${path}`, { method, headers: { cookie, "content-type": "application/json", ...extra, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const mon = (name: string) => ({ name, type: "http", target: "https://example.com" });
  const ALL = { "x-project-id": "all" };

  async function workspace(tag: string) {
    const cookie = await signUp(tag);
    const call = make(cookie);
    const first = (await call("GET", "/projects")).body[0].id as string;
    const second = (await call("POST", "/projects", { name: "Second" })).body.id as string;
    return { cookie, call, first, second };
  }

  it("lists monitors and incidents of every project, with their project", async () => {
    const { call, first, second } = await workspace("allp");
    const ma = (await call("POST", "/monitors", mon("in-first"), { "x-project-id": first })).body;
    const mb = (await call("POST", "/monitors", mon("in-second"), { "x-project-id": second })).body;
    await call("POST", "/incidents", { title: "inc-first", monitorId: ma.id }, { "x-project-id": first });
    await call("POST", "/incidents", { title: "inc-second", monitorId: mb.id }, { "x-project-id": second });

    expect((await call("GET", "/monitors", undefined, { "x-project-id": first })).body.map((m: any) => m.name)).toEqual(["in-first"]);
    const all = await call("GET", "/monitors", undefined, ALL);
    expect(all.status).toBe(200);
    expect(all.body.map((m: any) => [m.name, m.projectId]).sort()).toEqual([["in-first", first], ["in-second", second]]);
    const incs = (await call("GET", "/incidents", undefined, ALL)).body;
    expect(incs.map((i: any) => i.title).sort()).toEqual(["inc-first", "inc-second"]);
    expect(incs.every((i: any) => i.projectId)).toBe(true);

    expect((await call("GET", "/counts", undefined, ALL)).body).toMatchObject({ monitors: 2, incidents: 2 });
    expect((await call("GET", "/counts", undefined, { "x-project-id": first })).body).toMatchObject({ monitors: 1, incidents: 1 });
    const overview = (await call("GET", "/projects/overview", undefined, ALL)).body;
    expect(overview.map((p: any) => [p.id, p.monitors, p.openIncidents])).toEqual([[first, 1, 1], [second, 1, 1]]);

    // the detail of an item of another project opens whatever the current view
    expect((await call("GET", `/monitors/${mb.id}`, undefined, ALL)).status).toBe(200);
    expect((await call("GET", `/monitors/${mb.id}`, undefined, { "x-project-id": first })).status).toBe(200);
  });

  it("accepts the all cookie and still resolves a real project for everything else", async () => {
    const cookie = await signUp("allc");
    const withCookie = make(`${cookie}; ou_project=all`);
    const me = await withCookie("GET", "/me");
    expect(me.status).toBe(200);
    expect(me.body.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await withCookie("GET", "/projects")).status).toBe(200);
    expect((await withCookie("GET", "/monitors")).status).toBe(200);
  });

  it("refuses writes to project-scoped routes in the all view, and only those", async () => {
    const { cookie, call, first } = await workspace("allw");
    const m = (await call("POST", "/monitors", mon("keep"), { "x-project-id": first })).body;
    for (const [method, path, body] of [
      ["POST", "/monitors", mon("nope")],
      ["PATCH", `/monitors/${m.id}`, { name: "x" }],
      ["DELETE", `/monitors/${m.id}`, undefined],
      ["POST", `/monitors/${m.id}/check`, undefined],
      ["POST", "/incidents", { title: "nope" }],
      ["POST", "/channels", { type: "email", name: "c", config: { to: "a@example.com" } }],
      ["POST", "/maintenance", {}],
      ["POST", "/status-pages", {}],
    ] as const) {
      const r = await call(method, path, body, ALL);
      expect([method, path, r.status, r.body?.error]).toEqual([method, path, 400, "Choose a project"]);
    }
    expect((await call("GET", "/monitors", undefined, { "x-project-id": first })).body.map((x: any) => x.name)).toEqual(["keep"]);
    // the same writes work with a project chosen
    expect((await call("PATCH", `/monitors/${m.id}`, { name: "renamed" }, { "x-project-id": first })).status).toBe(200);

    // workspace-level and project-management routes are not affected, also through the cookie
    const viaCookie = make(`${cookie}; ou_project=all`);
    expect((await viaCookie("POST", "/projects", { name: "Third" })).status).toBe(201);
    expect((await viaCookie("PATCH", `/projects/${first}`, { name: "Renamed" })).status).toBe(200);
    expect((await viaCookie("PATCH", "/settings", { monthlyReport: true })).status).toBe(200);
    expect((await viaCookie("PATCH", "/me/locale", { locale: "en" })).status).toBe(200);
    expect((await viaCookie("POST", "/workspaces", { name: "Another" })).status).toBe(201);
  });

  it("never shows another workspace's rows", async () => {
    const mine = await workspace("isoa");
    const theirs = await workspace("isob");
    await theirs.call("POST", "/monitors", mon("secret"), { "x-project-id": theirs.first });
    await theirs.call("POST", "/incidents", { title: "secret-inc" }, { "x-project-id": theirs.first });
    await mine.call("POST", "/monitors", mon("mine"), { "x-project-id": mine.first });
    // asking for the other workspace's project ids while in the all view changes nothing
    const r = await mine.call("GET", "/monitors", undefined, ALL);
    expect(r.body.map((m: any) => m.name)).toEqual(["mine"]);
    expect((await mine.call("GET", "/incidents", undefined, ALL)).body).toEqual([]);
    const o = (await mine.call("GET", "/projects/overview", undefined, ALL)).body;
    expect(o.map((p: any) => p.id)).toEqual([mine.first, mine.second]);
    expect((await mine.call("GET", "/monitors", undefined, { "x-project-id": theirs.first })).body.map((m: any) => m.name)).toEqual(["mine"]);
  });

  it("limits a project-scoped key to its projects in the all view", async () => {
    const { call, first, second } = await workspace("alls");
    const org = (await call("GET", "/me")).body.organization.id as string;
    await call("POST", "/monitors", mon("in-first"), { "x-project-id": first });
    const mb = (await call("POST", "/monitors", mon("in-second"), { "x-project-id": second })).body;
    await call("POST", "/incidents", { title: "inc-first" }, { "x-project-id": first });
    await call("POST", "/incidents", { title: "inc-second", monitorId: mb.id }, { "x-project-id": second });
    // create keys through the signed-in session
    const create = async (projectIds?: string[]) => {
      const r = await call("POST", "/auth/api-key/create", { name: "k", metadata: { organizationId: org, ...(projectIds ? { projectIds } : {}) } });
      return r.body.key as string;
    };
    const limited = await create([second]);
    const open = await create();
    const k = (key: string) => async (path: string) => {
      const r = await raw(`/api${path}`, { headers: { "x-api-key": key, "x-project-id": "all" } });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };
    const viaLimited = k(limited);
    expect((await viaLimited("/monitors")).body.map((m: any) => m.name)).toEqual(["in-second"]);
    expect((await viaLimited("/incidents")).body.map((i: any) => i.title)).toEqual(["inc-second"]);
    expect((await viaLimited("/projects/overview")).body.map((p: any) => p.id)).toEqual([second]);
    expect((await k(open)("/monitors")).body.map((m: any) => m.name).sort()).toEqual(["in-first", "in-second"]);
    // the guard applies to keys as well
    const w = await raw("/api/monitors", { method: "POST", headers: { "x-api-key": limited, "x-project-id": "all", "content-type": "application/json" }, body: JSON.stringify(mon("x")) });
    expect(w.status).toBe(400);
  });
});
