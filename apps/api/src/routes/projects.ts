import { forgetProjects, requireManager, uuidParams } from "../middleware";
import { zValidator } from "@hono/zod-validator";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { REMINDER_INTERVALS } from "@openuptime/repo";
import type { AppEnv } from "../env";

const body = z.object({ name: z.string().trim().min(1).max(60) });

const alerting = z.object({
  /** minutes between repeats of an unacknowledged alert; null = no repeats */
  reminderIntervalMin: z.union([z.literal(null), ...REMINDER_INTERVALS.map((n) => z.literal(n))]),
  reminderEmail: z.boolean(),
  /** ordered levels; each notifies its channels when the incident is still unacknowledged that many minutes after it started */
  escalation: z.array(z.object({ channelIds: z.array(z.string().uuid()).min(1).max(5), escalateAfterMin: z.number().int().min(1).max(1440) })).max(3),
});

/** Creating, renaming and deleting projects is for sessions and unlimited keys, not project-limited ones. */
const unlimited: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("projectScope")) return c.json({ error: "This API key or authorization is limited to specific projects" }, 403);
  await next();
};

export const projects = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await c.get("repo").listProjects(c.get("orgId"), c.get("projectScope"))))
  // the "All projects" strip: per project, how many monitors, how many are down and how many incidents are open
  .get("/overview", async (c) => c.json(await c.get("repo").projectOverview(c.get("orgId"), c.get("projectScope"))))
  .post("/", unlimited, zValidator("json", body), async (c) => c.json(await c.get("repo").createProject(c.get("orgId"), c.req.valid("json").name), 201))
  .patch("/:id", uuidParams, unlimited, requireManager, zValidator("json", body), async (c) => {
    const row = await c.get("repo").renameProject(c.get("orgId"), c.req.param("id"), c.req.valid("json").name);
    return row ? c.json(row) : c.json({ error: "Not found" }, 404);
  })
  .get("/:id/alerting", uuidParams, async (c) => {
    const scope = c.get("projectScope");
    if (scope && !scope.includes(c.req.param("id"))) return c.json({ error: "Not found" }, 404);
    const row = await c.get("repo").getProjectAlerting(c.get("orgId"), c.req.param("id"));
    return row ? c.json(row) : c.json({ error: "Not found" }, 404);
  })
  .put("/:id/alerting", uuidParams, requireManager, zValidator("json", alerting), async (c) => {
    const scope = c.get("projectScope");
    const id = c.req.param("id");
    if (scope && !scope.includes(id)) return c.json({ error: "Not found" }, 404);
    const v = c.req.valid("json");
    if (v.escalation.some((s, i) => i > 0 && s.escalateAfterMin <= v.escalation[i - 1].escalateAfterMin)) return c.json({ error: "Each escalation level must come later than the one before" }, 400);
    const repo = c.get("repo");
    const ids = [...new Set(v.escalation.flatMap((s) => s.channelIds))];
    if (ids.length) {
      const found = await repo.channelsByIds(c.get("orgId"), ids);
      if (found.length !== ids.length) return c.json({ error: "An escalation level names a channel that does not exist" }, 400);
      // workspace-wide channels (no project) and this project's own are fine; another project's are not
      if (found.some((ch) => ch.projectId && ch.projectId !== id)) return c.json({ error: "An escalation level names a channel that belongs to another project" }, 400);
    }
    const row = await repo.saveProjectAlerting(c.get("orgId"), id, v);
    return row ? c.json(row) : c.json({ error: "Not found" }, 404);
  })
  .delete("/:id", uuidParams, unlimited, requireManager, async (c) => {
    const repo = c.get("repo");
    const orgId = c.get("orgId");
    if ((await repo.countProjects(orgId)) <= 1) return c.json({ error: "A workspace needs at least one project" }, 400);
    await repo.deleteProject(orgId, c.req.param("id"));
    forgetProjects(orgId);
    return c.body(null, 204);
  });
