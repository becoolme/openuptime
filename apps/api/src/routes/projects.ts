import { forgetProjects } from "../middleware";
import { zValidator } from "@hono/zod-validator";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";

const body = z.object({ name: z.string().trim().min(1).max(60) });

/** Creating, renaming and deleting projects is for sessions and unlimited keys, not project-limited ones. */
const unlimited: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("projectScope")) return c.json({ error: "This API key or authorization is limited to specific projects" }, 403);
  await next();
};

export const projects = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await c.get("repo").listProjects(c.get("orgId"), c.get("projectScope"))))
  .post("/", unlimited, zValidator("json", body), async (c) => c.json(await c.get("repo").createProject(c.get("orgId"), c.req.valid("json").name), 201))
  .patch("/:id", unlimited, zValidator("json", body), async (c) => {
    const row = await c.get("repo").renameProject(c.get("orgId"), c.req.param("id"), c.req.valid("json").name);
    return row ? c.json(row) : c.json({ error: "Not found" }, 404);
  })
  .delete("/:id", unlimited, async (c) => {
    const repo = c.get("repo");
    const orgId = c.get("orgId");
    if ((await repo.countProjects(orgId)) <= 1) return c.json({ error: "A workspace needs at least one project" }, 400);
    await repo.deleteProject(orgId, c.req.param("id"));
    forgetProjects(orgId);
    return c.body(null, 204);
  });
