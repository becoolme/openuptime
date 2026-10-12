import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireManager } from "../middleware";

/** Alert delivery history for the current project, newest first. */
export const alertLog = new Hono<AppEnv>().get(
  "/",
  zValidator("query", z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.string().datetime().optional() })),
  async (c) => {
    const { limit, before } = c.req.valid("query");
    return c.json(await c.get("repo").listDeliveries(c.get("orgId"), c.get("projectId"), { limit, before: before ? new Date(before) : undefined }));
  },
);

/** Workspace preferences. */
export const settings = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await c.get("repo").getSettings(c.get("orgId"))))
  .patch(
    "/",
    requireManager,
    zValidator("json", z.object({ alertLogRetentionDays: z.number().int().min(1).max(365).optional(), checkRetentionDays: z.number().int().min(1).max(365).optional() })),
    async (c) => {
      if (c.get("projectScope")) return c.json({ error: "This API key is limited to specific projects" }, 403);
      const v = c.req.valid("json");
      if (v.alertLogRetentionDays === undefined && v.checkRetentionDays === undefined) return c.json({ error: "No changes" }, 400);
      return c.json(await c.get("repo").saveSettings(c.get("orgId"), v));
    },
  );
