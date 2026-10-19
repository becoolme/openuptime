import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "./env";
import { rejectInAllProjects, requireManager, uuidParams } from "./middleware";

const call = async (role: string | null) => {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("repo", { memberRole: async () => role } as never);
    c.set("userId", "u");
    c.set("orgId", "o");
    await next();
  });
  app.delete("/x", requireManager, (c) => c.body(null, 204));
  app.onError((e, c) => c.json({ error: e.message }, (e as { status?: 403 }).status ?? 500));
  return (await app.request("/x", { method: "DELETE" })).status;
};

describe("requireManager", () => {
  it("lets owners and admins through, not members or outsiders", async () => {
    expect(await call("owner")).toBe(204);
    expect(await call("admin")).toBe(204);
    expect(await call("member")).toBe(403);
    expect(await call(null)).toBe(403);
  });
});

describe("uuidParams", () => {
  const app = new Hono<AppEnv>()
    .get("/m/:id", uuidParams, (c) => c.json({ id: c.req.param("id") }))
    .get("/p/:id/s/:sid", uuidParams, (c) => c.json({ ok: true }));
  const id = "7f1d2c4e-0b6a-4d5e-9a3f-1c2b3d4e5f60";

  it("answers 404 for ids that are not uuids instead of reaching the database", async () => {
    expect((await app.request(`/m/${id}`)).status).toBe(200);
    expect((await app.request("/m/not-a-uuid")).status).toBe(404);
    expect((await app.request("/m/1")).status).toBe(404);
    expect((await app.request(`/p/${id}/s/${id}`)).status).toBe(200);
    expect((await app.request(`/p/${id}/s/x`)).status).toBe(404);
  });
});

describe("rejectInAllProjects", () => {
  const run = async (all: boolean, method: string) => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("allProjects", all);
      await next();
    });
    app.use("/x/*", rejectInAllProjects);
    app.all("/x/y", (c) => c.body(null, 204));
    app.onError((e, c) => c.json({ error: e.message }, (e as { status?: 400 }).status ?? 500));
    const res = await app.request("/x/y", { method });
    return [res.status, (await res.json().catch(() => null))?.error];
  };
  it("refuses writes in the all view and lets reads and single-project writes through", async () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(await run(true, m)).toEqual([400, "Choose a project"]);
    expect((await run(true, "GET"))[0]).toBe(204);
    for (const m of ["GET", "POST", "PATCH", "DELETE"]) expect((await run(false, m))[0]).toBe(204);
  });
});
