import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { notifyIncidentUpdate } from "../alerts";
import type { AppEnv } from "../env";
import { uuidParams } from "../middleware";

export const incidents = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await c.get("repo").listIncidents(c.get("orgId"), c.get("projectId"))))
  .post(
    "/",
    zValidator("json", z.object({ title: z.string().min(1).max(200), body: z.string().max(4000).optional(), severity: z.enum(["minor", "major"]).default("major"), monitorId: z.string().uuid().nullish() })),
    async (c) => {
      const repo = c.get("repo");
      const v = c.req.valid("json");
      if (v.monitorId && !(await repo.getMonitor(c.get("orgId"), v.monitorId, c.get("projectScope")))) return c.json({ error: "Monitor not found" }, 404);
      const inc = await repo.createIncident(
        { organizationId: c.get("orgId"), monitorId: v.monitorId ?? null, title: v.title, severity: v.severity, auto: false, assigneeId: c.get("userId") },
        v.body ? { status: "investigating", body: v.body, authorId: c.get("userId") } : undefined,
      );
      return c.json(inc, 201);
    },
  )
  .get("/:id", uuidParams, async (c) => {
    const repo = c.get("repo");
    const id = c.req.param("id");
    // a project-limited key only sees incidents of its own monitors (or ones not tied to a monitor)
    if (!(await repo.incidentVisible(c.get("orgId"), id, c.get("projectScope")))) return c.json({ error: "Not found" }, 404);
    const d = await repo.incidentDetail(c.get("orgId"), id);
    if (!d) return c.json({ error: "Not found" }, 404);
    return c.json({ ...d.incident, updates: d.updates, monitor: d.monitor, assignee: d.assignee, checks: d.checks });
  })
  .post(
    "/:id/updates",
    uuidParams,
    zValidator("json", z.object({ status: z.enum(["investigating", "identified", "monitoring", "resolved"]), body: z.string().min(1).max(4000) })),
    async (c) => {
      const repo = c.get("repo");
      const v = c.req.valid("json");
      const id = c.req.param("id");
      if (!(await repo.incidentVisible(c.get("orgId"), id, c.get("projectScope")))) return c.json({ error: "Not found" }, 404);
      const r = await repo.postIncidentUpdate(c.get("orgId"), id, { ...v, authorId: c.get("userId") });
      if (!r) return c.json({ error: "Not found" }, 404);
      await notifyIncidentUpdate(repo, r.incident, v, c.get("entitlements"));
      return c.json(r.update, 201);
    },
  )
  .post("/:id/ack", uuidParams, async (c) => {
    const repo = c.get("repo");
    const id = c.req.param("id");
    if (!(await repo.incidentVisible(c.get("orgId"), id, c.get("projectScope")))) return c.json({ error: "Not found" }, 404);
    const inc = await repo.acknowledgeIncident(c.get("orgId"), id, c.get("userId"));
    return inc ? c.json(inc) : c.json({ error: "Not found" }, 404);
  });
