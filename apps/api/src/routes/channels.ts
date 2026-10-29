import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { deliver } from "../alerts";
import { apnsConfigured } from "../apns";
import type { AppEnv } from "../env";
import { isManager, requireManager, uuidParams } from "../middleware";
import { urlProblem } from "../netguard";
import { maskConfig, restoreConfig, sameJson } from "../secrets";

const TYPES = ["email", "slack", "telegram", "webhook", "pagerduty", "lark", "push", "discord", "teams"] as const;
type ChannelType = (typeof TYPES)[number];

const url = z.string().trim().max(2000).url().refine((u) => /^https?:\/\//i.test(u), "Must be an http(s) URL");
/** What each channel type needs; anything else in `config` is dropped. */
const CONFIG: Record<ChannelType, z.ZodType<Record<string, unknown>>> = {
  email: z.object({ to: z.string().trim().max(254).email() }),
  slack: z.object({ url }),
  discord: z.object({ url }),
  teams: z.object({ url }),
  webhook: z.object({ url }),
  lark: z.object({ url, secret: z.string().max(200).optional() }),
  telegram: z.object({ botToken: z.string().trim().min(1).max(200), chatId: z.string().trim().min(1).max(100) }),
  pagerduty: z.object({ routingKey: z.string().trim().min(1).max(200) }),
  /** every member's registered phones; nothing to configure */
  push: z.object({}),
};
const parseConfig = (type: ChannelType, config: unknown) => CONFIG[type].safeParse(config);
const configError = (e: z.ZodError) => `Invalid channel settings: ${e.issues.map((i) => `${i.path.join(".") || "config"} ${i.message}`).join("; ")}`;

/** A webhook-style URL must point at a public address (see netguard.ts). */
async function configProblem(config: Record<string, unknown>): Promise<string | null> {
  return typeof config.url === "string" ? urlProblem(config.url) : null;
}

const body = z.object({
  type: z.enum(TYPES),
  name: z.string().min(1).max(80),
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
  /** New monitors of this project start out alerting this channel. */
  autoEnable: z.boolean().default(false),
  /** "workspace" (default): shared by every project. "project": only the active project. */
  scope: z.enum(["workspace", "project"]).default("workspace"),
});

/** Credentials in the settings are shown to owners and admins only. */
const shown = async <T extends { config: unknown }>(c: Parameters<typeof isManager>[0], rows: T[]) =>
  (await isManager(c)) ? rows : rows.map((r) => ({ ...r, config: maskConfig(r.config as Record<string, unknown>) }));

export const channels = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await shown(c, await c.get("repo").listChannels(c.get("orgId"), c.get("projectId")))))
  .post("/", zValidator("json", body), async (c) => {
    const v = c.req.valid("json");
    if (v.type === "push" && !apnsConfigured()) return c.json({ error: "Push notifications are not set up on this server. Configure APNs first (see the self-hosting docs).", code: "push_not_configured" }, 400);
    const cfg = parseConfig(v.type, v.config);
    if (!cfg.success) return c.json({ error: configError(cfg.error) }, 400);
    const refused = await configProblem(cfg.data);
    if (refused) return c.json({ error: refused, code: "target_not_allowed" }, 400);
    // a key limited to some projects cannot create what other projects would share
    const projectId = v.scope === "project" || c.get("projectScope") ? c.get("projectId") : null;
    const { scope: _scope, ...channel } = v;
    return c.json((await shown(c, [await c.get("repo").createChannel(c.get("orgId"), projectId, { ...channel, config: cfg.data })]))[0], 201);
  })
  .patch("/:id", uuidParams, zValidator("json", z.object({ name: z.string().min(1).max(80).optional(), enabled: z.boolean().optional(), autoEnable: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional() })), async (c) => {
    const repo = c.get("repo");
    const patch = c.req.valid("json");
    if (patch.config) {
      // the settings are checked against the channel's own type
      const current = await repo.getChannel(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
      if (!current) return c.json({ error: "Not found" }, 404);
      // placeholders stand for the stored credential; settings that end up identical are not a change
      const next = restoreConfig(patch.config, current.config as Record<string, unknown>);
      if (sameJson(next, current.config)) delete patch.config;
      else {
        // where alerts go (and the credentials used) is a manager's call; a member may still rename or toggle
        if (!(await isManager(c))) return c.json({ error: "Only workspace owners and admins can change a channel's destination" }, 403);
        const cfg = parseConfig(current.type as ChannelType, next);
        if (!cfg.success) return c.json({ error: configError(cfg.error) }, 400);
        const refused = await configProblem(cfg.data);
        if (refused) return c.json({ error: refused, code: "target_not_allowed" }, 400);
        patch.config = cfg.data;
      }
    }
    const row = await repo.updateChannel(c.get("orgId"), c.req.param("id"), c.get("projectScope"), patch);
    return row ? c.json((await shown(c, [row]))[0]) : c.json({ error: "Not found" }, 404);
  })
  // sends a harmless test message so people can verify the destination before an outage
  .post("/:id/test", uuidParams, async (c) => {
    const repo = c.get("repo");
    // each call makes an outbound request to a destination of the caller's choosing
    if (!(await repo.withinLimit(`chtest:${c.get("userId")}`, 20, 600))) return c.json({ error: "Too many test messages, try again in a few minutes" }, 429);
    const ch = await repo.getChannel(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!ch) return c.json({ error: "Not found" }, 404);
    const log = (error: string | null) =>
      repo.logDeliveries([{ organizationId: ch.organizationId, projectId: ch.projectId, channelId: ch.id, channelName: ch.name, channelType: ch.type, kind: "test", ok: !error, error, statusMessage: error && (error.startsWith("skipped:") ? error : `failed: ${error}`), status: !error ? "sent" : error.startsWith("skipped:") ? "skipped" : "failed" }]);
    try {
      await deliver(ch, { kind: "incident.resolved", incident: { id: crypto.randomUUID(), title: "Test alert" }, monitor: { name: "OpenUptime test", target: "" }, test: true }, "🔔 Test alert from OpenUptime — this channel is connected.", "en", repo);
      await log(null);
      return c.json({ ok: true });
    } catch (e) {
      await log((e as Error).message.slice(0, 500));
      return c.json({ error: (e as Error).message }, 502);
    }
  })
  .delete("/:id", uuidParams, requireManager, async (c) => {
    const repo = c.get("repo");
    const id = c.req.param("id");
    // a channel some monitors still alert through is only removed once they have let go of it
    const using = await repo.monitorsUsingChannel(c.get("orgId"), id);
    if (using.length) {
      const names = using.slice(0, 5).map((m) => m.name).join(", ") + (using.length > 5 ? ", …" : "");
      return c.json({ error: `This channel is used by ${using.length} monitor${using.length === 1 ? "" : "s"} (${names}). Turn it off on ${using.length === 1 ? "that monitor" : "those monitors"} before removing it.`, code: "channel_in_use", monitors: using }, 409);
    }
    await repo.deleteChannel(c.get("orgId"), id, c.get("projectScope"));
    return c.body(null, 204);
  });
