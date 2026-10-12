import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireManager, uuidParams } from "../middleware";

const body = z
  .object({
    name: z.string().min(1).max(120),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    monitorIds: z.array(z.string().uuid()).max(500).default([]),
  })
  .refine((v) => v.endsAt > v.startsAt, { message: "End must be after start", path: ["endsAt"] });

export const maintenance = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await c.get("repo").listMaintenance(c.get("orgId"), c.get("projectId"))))
  .post("/", zValidator("json", body), async (c) => c.json(await c.get("repo").createMaintenance(c.get("orgId"), c.get("projectId"), c.req.valid("json")), 201))
  .delete("/:id", uuidParams, requireManager, async (c) => {
    await c.get("repo").deleteMaintenance(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    return c.body(null, 204);
  });
