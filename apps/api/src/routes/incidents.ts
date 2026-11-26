import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { notifyIncidentUpdate } from "../alerts";
import type { AppEnv } from "../env";
import { listedProjects, requireManager, uuidParams } from "../middleware";
import { purgePublicStatus } from "./status";

const visibility = z.enum(["public", "internal"]);
/** Limits for the write-up fields: a short cause and a longer postmortem. */
export const ROOT_CAUSE_MAX = 500;
export const POSTMORTEM_MAX = 20000;
export const FALSE_ALARM_REASON_MAX = 500;

/** The HTTP answer for each way marking (or un-marking) a false alarm can be refused. */
const falseAlarmError = {
  not_found: [404, "Not found"],
  open: [409, "Resolve the incident before marking it as a false alarm"],
  no_monitor: [409, "Only an incident tied to a monitor can be marked as a false alarm"],
  already: [409, "This incident is already marked as a false alarm"],
  not_marked: [409, "This incident is not marked as a false alarm"],
} as const;

/** Matches "INC-12", "inc12" or "12" against the incident number. */
const asNumber = (q: string) => {
  const m = /^(?:inc-?)?(\d{1,9})$/i.exec(q.trim());
  return m ? Number(m[1]) : null;
};

export const incidents = new Hono<AppEnv>()
  // ?q= filters by incident number (INC-12 or 12) or by a word in the title
  .get("/", async (c) => {
    const list = await c.get("repo").listIncidents(c.get("orgId"), await listedProjects(c));
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
      purgePublicStatus();
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
    zValidator("json", z.object({ rootCause: z.string().trim().max(ROOT_CAUSE_MAX).nullable().optional(), postmortem: z.string().max(POSTMORTEM_MAX).nullable().optional(), publishPostmortem: z.boolean().optional() })),
    async (c) => {
      const repo = c.get("repo");
      const id = c.req.param("id");
      const v = c.req.valid("json");
      if (!(await repo.incidentVisible(c.get("orgId"), id, c.get("projectScope")))) return c.json({ error: "Not found" }, 404);
      // an empty string clears the field, like null
      const blank = (x: string | null | undefined) => (x === undefined ? undefined : x?.trim() ? x : null);
      const inc = await repo.updateIncidentWriteUp(c.get("orgId"), id, { rootCause: blank(v.rootCause), postmortem: blank(v.postmortem), publish: v.publishPostmortem });
      // publishing or taking down a postmortem changes the public page at once
      purgePublicStatus();
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
      // the resolution is what subscribers are mailed about, so it cannot be kept internal
      if (v.status === "resolved" && v.visibility === "internal") return c.json({ error: "A resolved update must be public" }, 400);
      const r = await repo.postIncidentUpdate(c.get("orgId"), id, { ...v, authorId: c.get("userId") });
      if (!r) return c.json({ error: "Not found" }, 404);
      purgePublicStatus();
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
  })
  // Owners and admins only: it rewrites what the check history says. The incident, its updates and the failed checks'
  // errors stay; the failed runs of the incident count as healthy and the incident leaves the status page.
  .post(
    "/:id/false-alarm",
    uuidParams,
    requireManager,
    zValidator("json", z.object({ reason: z.string().trim().min(1).max(FALSE_ALARM_REASON_MAX) })),
    async (c) => {
      const repo = c.get("repo");
      const id = c.req.param("id");
      if (!(await repo.incidentVisible(c.get("orgId"), id, c.get("projectScope")))) return c.json({ error: "Not found" }, 404);
      const r = await repo.markIncidentFalseAlarm(c.get("orgId"), id, c.get("userId"), c.req.valid("json").reason);
      if (!r.ok) {
        const [status, error] = falseAlarmError[r.error];
        return c.json({ error }, status);
      }
      purgePublicStatus();
      return c.json({ ...r.incident, correctedChecks: r.checks });
    },
  )
  .delete("/:id/false-alarm", uuidParams, requireManager, async (c) => {
    const repo = c.get("repo");
    const id = c.req.param("id");
    if (!(await repo.incidentVisible(c.get("orgId"), id, c.get("projectScope")))) return c.json({ error: "Not found" }, 404);
    const r = await repo.clearIncidentFalseAlarm(c.get("orgId"), id);
    if (!r.ok) {
      const [status, error] = falseAlarmError[r.error];
      return c.json({ error }, status);
    }
    purgePublicStatus();
    return c.json({ ...r.incident, correctedChecks: r.checks });
  });
