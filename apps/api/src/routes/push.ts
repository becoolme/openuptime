import { zValidator } from "@hono/zod-validator";
import type { PushDevice } from "@openuptime/repo";
import { Hono } from "hono";
import { z } from "zod";
import { apnsConfigured } from "../apns";
import { fromB64url, webPushConfigured } from "../webpush";
import type { AppEnv } from "../env";

const hex = z.string().trim().regex(/^[0-9a-fA-F]{32,200}$/, "Must be a hex device token of 32 to 200 characters").transform((t) => t.toLowerCase());

const common = {
  locale: z.enum(["en", "zh-CN"]).optional(),
  name: z.string().trim().max(80).optional(),
};

const phone = z.object({
  ...common,
  token: hex,
  platform: z.literal("ios"),
  environment: z.enum(["sandbox", "production"]),
  critical: z.boolean().optional(),
});

/** base64url that decodes to exactly `bytes` bytes (an uncompressed P-256 point is 65, the auth secret 16). */
const b64 = (bytes: number) =>
  z.string().trim().regex(/^[A-Za-z0-9_-]+={0,2}$/, "Must be base64url").refine((v) => {
    try { return fromB64url(v).length === bytes; } catch { return false; }
  }, `Must decode to ${bytes} bytes`);

/** What `PushSubscription.toJSON()` gives, plus the language the alerts should be in. */
const browser = z.object({
  ...common,
  platform: z.literal("web"),
  endpoint: z.string().trim().max(2048).url().refine((u) => u.startsWith("https://"), "The push endpoint must be https"),
  keys: z.object({ p256dh: b64(65), auth: b64(16) }),
});

const body = z.discriminatedUnion("platform", [phone, browser]);

const shape = (d: PushDevice) => ({ id: d.id, token: d.token, platform: d.platform, environment: d.environment, locale: d.locale, name: d.name, critical: d.critical });

const unsubscribe = z.object({ endpoint: z.string().trim().max(2048) });

/** Registrations of phones for push alerts. They belong to the signed-in person (session or API key), not to a workspace. */
export const push = new Hono<AppEnv>()
  .get("/devices", async (c) => c.json((await c.get("repo").listPushDevices(c.get("userId"))).map(shape)))
  .put("/devices", zValidator("json", body), async (c) => {
    const repo = c.get("repo");
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "This credential is not tied to a user, so it cannot register a device" }, 403);
    if (!(await repo.withinLimit(`push:${userId}`, 60, 600))) return c.json({ error: "Too many requests, try again in a few minutes" }, 429);
    const v = c.req.valid("json");
    const device = await repo.upsertPushDevice(
      userId,
      v.platform === "web"
        ? { token: v.endpoint, platform: "web", environment: "production", locale: v.locale ?? null, name: v.name ?? null, p256dh: v.keys.p256dh, auth: v.keys.auth }
        : { token: v.token, platform: v.platform, environment: v.environment, locale: v.locale ?? null, name: v.name ?? null, critical: v.critical },
    );

    // the first phone or browser makes alerts reach devices: give each workspace the person manages a push channel, once
    if (v.platform === "web" ? webPushConfigured() : apnsConfigured()) {
      const granted = c.get("workspaceGrant");
      // a key limited to some projects must not create workspace-wide channels (see POST /channels); neither may one reach past its workspaces
      if (!c.get("projectScope")) {
        for (const orgId of await repo.managedOrgsWithoutPushChannel(userId)) {
          if (granted instanceof Map && !granted.has(orgId)) continue;
          await repo.createChannel(orgId, null, { type: "push", name: v.platform === "web" ? "Push notifications" : "Mobile app", config: {}, enabled: true, autoEnable: true }).catch((e) => console.error("could not create the push channel", (e as Error).message));
        }
      }
    }
    return c.json(shape(device));
  })
  // a browser's endpoint is a URL, so it travels in a body rather than in the path
  .post("/devices/unsubscribe", zValidator("json", unsubscribe), async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "This credential is not tied to a user" }, 403);
    if (!(await c.get("repo").withinLimit(`push:${userId}`, 60, 600))) return c.json({ error: "Too many requests, try again in a few minutes" }, 429);
    await c.get("repo").deletePushDevice(userId, c.req.valid("json").endpoint);
    return c.body(null, 204);
  })
  .delete("/devices/:token", async (c) => {
    const repo = c.get("repo");
    const userId = c.get("userId");
    if (!(await repo.withinLimit(`push:${userId}`, 60, 600))) return c.json({ error: "Too many requests, try again in a few minutes" }, 429);
    await repo.deletePushDevice(userId, c.req.param("token").toLowerCase());
    return c.body(null, 204);
  });
