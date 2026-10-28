import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireManager, uuidParams } from "../middleware";

const timeZone = z.string().max(100).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return value === "UTC" || value.includes("/"); } catch { return false; }
}, "Use an IANA time zone such as America/Toronto or UTC");

export const maintenanceCreateSchema = z.object({
  name: z.string().min(1).max(120),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  monitorIds: z.array(z.string().uuid()).max(500).default([]),
  recurrence: z.object({ frequency: z.enum(["daily", "weekly"]), timeZone, until: z.string().datetime({ offset: true }) }).nullable().optional(),
}).superRefine((v, ctx) => {
  if (v.endsAt <= v.startsAt) ctx.addIssue({ code: "custom", message: "End must be after start", path: ["endsAt"] });
  if (v.recurrence) {
    const until = new Date(v.recurrence.until).getTime();
    if (until < +v.startsAt || until - +v.startsAt > 366 * 86400_000) ctx.addIssue({ code: "custom", message: "Repeat until must be within 366 days after the first start", path: ["recurrence", "until"] });
    if (+v.endsAt - +v.startsAt > 86400_000) ctx.addIssue({ code: "custom", message: "A recurring window may last at most 24 hours", path: ["endsAt"] });
  }
});

export const maintenance = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await c.get("repo").listMaintenance(c.get("orgId"), c.get("projectId"))))
  .post("/", zValidator("json", maintenanceCreateSchema), async (c) => {
    const v = c.req.valid("json");
    // Never attach monitors from another workspace/project to a generated series.
    if (v.monitorIds.length) {
      const owned = await c.get("repo").ownedMonitorIds(c.get("orgId"), v.monitorIds, [c.get("projectId")]);
      if (new Set(v.monitorIds).size !== owned.length) return c.json({ error: "Monitors must belong to this project" }, 400);
    }
    return c.json(await c.get("repo").createMaintenance(c.get("orgId"), c.get("projectId"), v), 201);
  })
  .post("/:id/end", uuidParams, requireManager, async (c) => {
    await c.get("repo").endMaintenance(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    return c.json({ ok: true });
  })
  .delete("/series/:id", uuidParams, requireManager, async (c) => {
    await c.get("repo").cancelMaintenanceSeries(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    return c.body(null, 204);
  })
  .delete("/:id", uuidParams, requireManager, async (c) => {
    await c.get("repo").deleteMaintenance(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    return c.body(null, 204);
  });
