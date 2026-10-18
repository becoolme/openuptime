import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { notifyIncidentUpdate } from "../alerts";
import type { AppEnv } from "../env";
import { uuidParams } from "../middleware";

const visibility = z.enum(["public", "internal"]);
/** Limits for the write-up fields: a short cause and a longer postmortem. */
export const ROOT_CAUSE_MAX = 500;
export const POSTMORTEM_MAX = 20000;

/** Matches "INC-12", "inc12" or "12" against the incident number. */
const asNumber = (q: string) => {
  const m = /^(?:inc-?)?(\d{1,9})$/i.exec(q.trim());
  return m ? Number(m[1]) : null;
};

export const incidents = new Hono<AppEnv>()
  // ?q= filters by incident number (INC-12 or 12) or by a word in the title
  .get("/", async (c) => {
    const list = await c.get("repo").listIncidents(c.get("orgId"), c.get("projectId"));
    const q = c.req.query("q")?.trim();
    if (!q) return c.json(list);
    const n = asNumber(q);
    const needle = q.toLowerCase();
    return c.json(list.filter((i) => (n != null && i.number === n) || i.title.toLowerCase().includes(needle)));
  })
  .post(
    "/",
    zValidator("json", z.object({ title: z.string().min(1).max(200), body: z.string().max(4000).optional(), severity: z.enum(["minor", "major"]).default("major"), monitorId: z.string().uuid().nullish(), visibility: visibility.default("public") })),
    async (c) => {
      const repo = c.get("repo");
      const v = c.req.valid("json");
      if (v.monitorId && !(await repo.getMonitor(c.get("orgId"), v.monitorId, c.get("projectScope")))) return c.json({ error: "Monitor not found" }, 404);
      const inc = await repo.createIncident(
        { organizationId: c.get("orgId"), monitorId: v.monitorId ?? null, projectId: c.get("projectId"), title: v.title, severity: v.severity, auto: false, assigneeId: c.get("userId") },
        v.body ? { status: "investigating", body: v.body, authorId: c.get("userId"), visibility: v.visibility } : undefined,
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
    const deliveries = await repo.incidentDeliveries(c.get("orgId"), id);
    return c.json({ ...d.incident, updates: d.updates, monitor: d.monitor, assignee: d.assignee, checks: d.checks, deliveries });
  })
  .patch(
    "/:id",
    uuidParams,
    zValidator("json", z.object({ rootCause: z.string().trim().max(ROOT_CAUSE_MAX).nullable().optional(), postmortem: z.string().max(POSTMORTEM_MAX).nullable().optional() })),
    async (c) => {
      const repo = c.get("repo");
      const id = c.req.param("id");
      const v = c.req.valid("json");
      if (!(await repo.incidentVisible(c.get("orgId"), id, c.get("projectScope")))) return c.json({ error: "Not found" }, 404);
      // an empty string clears the field, like null
      const blank = (x: string | null | undefined) => (x === undefined ? undefined : x?.trim() ? x : null);
      const inc = await repo.updateIncidentWriteUp(c.get("orgId"), id, { rootCause: blank(v.rootCause), postmortem: blank(v.postmortem) });
      return inc ? c.json(inc) : c.json({ error: "Not found" }, 404);
    },
  )
  .post(
    "/:id/updates",
    uuidParams,
    zValidator("json", z.object({ status: z.enum(["investigating", "identified", "monitoring", "resolved"]), body: z.string().min(1).max(4000), visibility: visibility.default("public") })),
    async (c) => {
      const repo = c.get("repo");
      const v = c.req.valid("json");
      const id = c.req.param("id");
      if (!(await repo.incidentVisible(c.get("orgId"), id, c.get("projectScope")))) return c.json({ error: "Not found" }, 404);
      const r = await repo.postIncidentUpdate(c.get("orgId"), id, { ...v, authorId: c.get("userId") });
      if (!r) return c.json({ error: "Not found" }, 404);
      // internal updates stay inside the team: no subscriber email
      if (r.update.visibility === "public") await notifyIncidentUpdate(repo, r.incident, v, c.get("entitlements"));
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
