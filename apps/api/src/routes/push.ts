import { zValidator } from "@hono/zod-validator";
import type { PushDevice } from "@openuptime/repo";
import { Hono } from "hono";
import { z } from "zod";
import { apnsConfigured } from "../apns";
import type { AppEnv } from "../env";

const hex = z.string().trim().regex(/^[0-9a-fA-F]{32,200}$/, "Must be a hex device token of 32 to 200 characters").transform((t) => t.toLowerCase());

const body = z.object({
  token: hex,
  platform: z.literal("ios"),
  environment: z.enum(["sandbox", "production"]),
  locale: z.enum(["en", "zh-CN"]).optional(),
  name: z.string().trim().max(80).optional(),
  critical: z.boolean().optional(),
});

const shape = (d: PushDevice) => ({ id: d.id, token: d.token, platform: d.platform, environment: d.environment, locale: d.locale, name: d.name, critical: d.critical });

/** Registrations of phones for push alerts. They belong to the signed-in person (session or API key), not to a workspace. */
export const push = new Hono<AppEnv>()
  .get("/devices", async (c) => c.json((await c.get("repo").listPushDevices(c.get("userId"))).map(shape)))
  .put("/devices", zValidator("json", body), async (c) => {
    const repo = c.get("repo");
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "This credential is not tied to a user, so it cannot register a device" }, 403);
    if (!(await repo.withinLimit(`push:${userId}`, 60, 600))) return c.json({ error: "Too many requests, try again in a few minutes" }, 429);
    const v = c.req.valid("json");
    const device = await repo.upsertPushDevice(userId, { token: v.token, platform: v.platform, environment: v.environment, locale: v.locale ?? null, name: v.name ?? null, critical: v.critical });

    // the first phone makes alerts reach phones: give each workspace the person manages a "Mobile app" channel, once
    if (apnsConfigured()) {
      const granted = c.get("workspaceGrant");
      // a key limited to some projects must not create workspace-wide channels (see POST /channels); neither may one reach past its workspaces
      if (!c.get("projectScope")) {
        for (const orgId of await repo.managedOrgsWithoutPushChannel(userId)) {
          if (granted instanceof Map && !granted.has(orgId)) continue;
          await repo.createChannel(orgId, null, { type: "push", name: "Mobile app", config: {}, enabled: true, autoEnable: true }).catch((e) => console.error("could not create the push channel", (e as Error).message));
        }
      }
    }
    return c.json(shape(device));
  })
  .delete("/devices/:token", async (c) => {
    const repo = c.get("repo");
    const userId = c.get("userId");
    if (!(await repo.withinLimit(`push:${userId}`, 60, 600))) return c.json({ error: "Too many requests, try again in a few minutes" }, 429);
    await repo.deletePushDevice(userId, c.req.param("token").toLowerCase());
    return c.body(null, 204);
  });
