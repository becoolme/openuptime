import { zValidator } from "@hono/zod-validator";
import type { IncidentUpdate, IncidentWithUpdates } from "@openuptime/repo";
import { Hono } from "hono";
import { z } from "zod";
import { actionEmail, appUrl, sendEmail } from "../email";
import { langFromHeader, tr } from "../mail-i18n";
import type { AppEnv } from "../env";
import { requireManager, uuidParams } from "../middleware";
import { clientIp } from "../ratelimit";

// optional link to the owner's own website; "" clears it
const externalUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => v === "" || /^https?:\/\//i.test(v) && URL.canParse(v), "Must be an http(s) URL")
  .transform((v) => v || null)
  .nullable()
  .optional();
const pageBody = z.object({
  title: z.string().min(1).max(120),
  theme: z.enum(["light", "dark", "auto"]).optional(),
  showLatency: z.boolean().optional(),
  externalUrl,
  monitorIds: z.array(z.string().uuid()).optional(),
  // ordered, optionally grouped; takes precedence over monitorIds
  components: z.array(z.object({ monitorId: z.string().uuid(), groupName: z.string().trim().min(1).max(60).optional() })).max(200).optional(),
});
const toComponents = (v: { monitorIds?: string[]; components?: { monitorId: string; groupName?: string }[] }) =>
  v.components ?? (v.monitorIds ?? []).map((monitorId) => ({ monitorId }));

/** Management API for status pages (authenticated). */
export const statusPages = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await c.get("repo").listStatusPages(c.get("orgId"), c.get("projectId"))))
  .post(
    "/",
    zValidator("json", z.object({ slug: z.string().regex(/^[a-z0-9-]{3,40}$/) }).and(pageBody.partial({ title: true }).required({ title: true }))),
    async (c) => {
      const repo = c.get("repo");
      const { monitorIds, components, ...v } = c.req.valid("json");
      if (await repo.slugTaken(v.slug)) return c.json({ error: "That slug is already taken" }, 409);
      const page = await repo.createStatusPage(c.get("orgId"), c.get("projectId"), v);
      await repo.setPageComponents(page.id, c.get("orgId"), toComponents({ monitorIds, components }), c.get("projectScope"));
      return c.json(page, 201);
    },
  )
  .get("/:id", uuidParams, async (c) => {
    const repo = c.get("repo");
    const page = await repo.getStatusPage(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!page) return c.json({ error: "Not found" }, 404);
    const comps = await repo.pageComponents(page.id);
    return c.json({ ...page, monitorIds: comps.map((x) => x.monitorId), components: comps });
  })
  .patch("/:id", uuidParams, requireManager, zValidator("json", pageBody.partial()), async (c) => {
    const repo = c.get("repo");
    const page = await repo.getStatusPage(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!page) return c.json({ error: "Not found" }, 404);
    const { monitorIds, components, ...v } = c.req.valid("json");
    await repo.updateStatusPage(page.id, v);
    if (monitorIds || components) await repo.setPageComponents(page.id, c.get("orgId"), toComponents({ monitorIds, components }), c.get("projectScope"));
    return c.json({ ok: true });
  })
  .get("/:id/subscribers", uuidParams, async (c) => {
    const repo = c.get("repo");
    const page = await repo.getStatusPage(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!page) return c.json({ error: "Not found" }, 404);
    return c.json(await repo.listSubscribers(page.id));
  })
  .delete("/:id/subscribers/:sid", uuidParams, requireManager, async (c) => {
    const repo = c.get("repo");
    const page = await repo.getStatusPage(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!page) return c.json({ error: "Not found" }, 404);
    await repo.deleteSubscriber(page.id, c.req.param("sid"));
    return c.body(null, 204);
  })
  .delete("/:id", uuidParams, requireManager, async (c) => {
    const repo = c.get("repo");
    const page = await repo.getStatusPage(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (page) await repo.deleteStatusPage(page.id);
    return c.body(null, 204);
  });

/**
 * Automatic (authorless) "investigating" updates carry raw check errors and thresholds — hostnames, IPs, ports,
 * response snippets. Those are for the owner's dashboard and alerts only; public pages and RSS get a generic line.
 */
export function publicBody(u: IncidentUpdate) {
  return u.authorId == null && u.status === "investigating" ? "Automated checks detected a problem. We are investigating." : u.body;
}

/** Public shape of an incident: no assignee, no organization, sanitised update bodies. */
const toPublic = (i: IncidentWithUpdates) => ({
  id: i.id, title: i.title, status: i.status, severity: i.severity, startedAt: i.startedAt, resolvedAt: i.resolvedAt,
  updates: i.updates.map((u) => ({ id: u.id, body: publicBody(u), status: u.status, createdAt: u.createdAt })),
});

const emailSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
const MAX_SUBSCRIBERS = 5000;
const HISTORY_PAGE = 15;

type Overall = "operational" | "degraded" | "outage";
const LABELS: Record<Overall, { en: string; zh: string }> = {
  operational: { en: "All systems operational", zh: "所有系统运行正常" },
  degraded: { en: "Partial degradation", zh: "部分服务降级" },
  outage: { en: "Major outage", zh: "服务中断" },
};
const COLORS: Record<Overall, string> = { operational: "#16a34a", degraded: "#d97706", outage: "#dc2626" };
const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Rough text width for the badge: CJK glyphs are about twice as wide as latin ones. */
const textWidth = (v: string) => [...v].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 12 : 6.4), 0);
const overallOf = (statuses: string[]): Overall => (statuses.includes("down") ? "outage" : statuses.includes("degraded") ? "degraded" : "operational");
const langOf = (c: { req: { query(k: string): string | undefined; header(k: string): string | undefined } }): "en" | "zh" => {
  const q = c.req.query("lang") ?? c.req.header("accept-language") ?? "";
  return /^zh/i.test(q) ? "zh" : "en";
};

export const publicStatus = new Hono<AppEnv>()
  // one-line state for embeds; small and cacheable
  .get("/:slug/summary", async (c) => {
    const repo = c.get("repo");
    const page = await repo.statusPageBySlug(c.req.param("slug"));
    if (!page) return c.json({ error: "Not found" }, 404, { "cache-control": "public, max-age=60" });
    const board = await repo.statusBoard(page);
    const overall = overallOf(board.components.map((x) => x.status));
    return c.json(
      { slug: page.slug, title: page.title, overall, label: LABELS[overall][langOf(c)], url: `${appUrl()}/status/${page.slug}`, updatedAt: new Date().toISOString() },
      200,
      { "cache-control": "public, max-age=30" },
    );
  })
  // shields-style SVG for READMEs and <img> tags
  .get("/:slug/badge.svg", async (c) => {
    const repo = c.get("repo");
    const lang = langOf(c);
    const page = await repo.statusPageBySlug(c.req.param("slug"));
    const overall: Overall | null = page ? overallOf((await repo.statusBoard(page)).components.map((x) => x.status)) : null;
    const left = lang === "zh" ? "状态" : "status";
    const right = overall ? LABELS[overall][lang] : lang === "zh" ? "未知" : "unknown";
    const color = overall ? COLORS[overall] : "#9ca3af";
    const lw = Math.round(textWidth(left) + 20);
    const rw = Math.round(textWidth(right) + 20);
    const w = lw + rw;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="22" role="img" aria-label="${esc(left)}: ${esc(right)}"><title>${esc(left)}: ${esc(right)}</title><clipPath id="r"><rect width="${w}" height="22" rx="4"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="22" fill="#555"/><rect x="${lw}" width="${rw}" height="22" fill="${color}"/></g><g fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif,PingFang SC,Microsoft YaHei" font-size="11" text-anchor="middle"><text x="${lw / 2}" y="15">${esc(left)}</text><text x="${lw + rw / 2}" y="15">${esc(right)}</text></g></svg>`;
    return c.body(svg, 200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=60" });
  })
  // incident history, newest first, cursor = startedAt of the last item of the previous page
  .get("/:slug/incidents", async (c) => {
    const repo = c.get("repo");
    const page = await repo.statusPageBySlug(c.req.param("slug"));
    if (!page) return c.json({ error: "Not found" }, 404);
    const before = c.req.query("before");
    const cursor = before && !Number.isNaN(Date.parse(before)) ? new Date(before) : undefined;
    const rows = await repo.pageIncidents(page, { limit: HISTORY_PAGE + 1, before: cursor });
    const more = rows.length > HISTORY_PAGE;
    const items = rows.slice(0, HISTORY_PAGE).map(toPublic);
    return c.json({ items, next: more ? items[items.length - 1].startedAt : null });
  })
  .get("/:slug/rss", async (c) => {
    const repo = c.get("repo");
    const page = await repo.statusPageBySlug(c.req.param("slug"));
    if (!page) return c.json({ error: "Not found" }, 404);
    const items = (await repo.pageIncidents(page, { limit: 30 })).map(toPublic);
    const origin = appUrl() || new URL(c.req.url).origin;
    const link = `${origin}/status/${page.slug}`;
    const x = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${x(page.title)} status</title><link>${x(link)}</link><description>Incidents for ${x(page.title)}</description>
${items
  .map((i) => {
    const latest = i.updates[0];
    return `<item><title>${x(`${i.title} — ${i.status}`)}</title><link>${x(link)}</link><guid isPermaLink="false">${i.id}</guid><pubDate>${new Date(i.startedAt).toUTCString()}</pubDate><description>${x(i.updates.map((u) => `[${u.status}] ${u.body}`).join("\n") || latest?.body || i.title)}</description></item>`;
  })
  .join("\n")}
</channel></rss>`;
    return c.body(xml, 200, { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=60" });
  })
  .post("/:slug/subscribe", zValidator("json", emailSchema), async (c) => {
    const repo = c.get("repo");
    const page = await repo.statusPageBySlug(c.req.param("slug"));
    if (!page) return c.json({ error: "Not found" }, 404);
    const { email } = c.req.valid("json");
    // Each request can trigger an outbound email, so cap per client, per address and per page.
    const ip = clientIp(c);
    const ok =
      (!ip || (await repo.withinLimit(`sub:ip:${ip}`, 10, 3600))) &&
      (await repo.withinLimit(`sub:mail:${page.id}:${email}`, 3, 3600)) &&
      (await repo.withinLimit(`sub:page:${page.id}`, 200, 3600));
    if (!ok) return c.json({ error: "Too many requests, try again later" }, 429);
    if ((await repo.subscriberCount(page.id)) >= MAX_SUBSCRIBERS) return c.json({ error: "Subscriber limit reached" }, 409);
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const row = await repo.addSubscriber({ pageId: page.id, email, token, locale: langFromHeader(c.req.header("accept-language")) });
    // already subscribed (or pending): answer the same way so the endpoint does not reveal who is subscribed
    if (row) {
      const lang = row.locale === "zh-CN" ? "zh-CN" : "en";
      const mail = actionEmail({
        title: tr(lang, "Confirm your subscription to {title}", { title: page.title }),
        body: tr(lang, "You will get an email when an incident is opened, updated or resolved. If this wasn’t you, ignore this message and you won’t be subscribed."),
        footer: tr(lang, "Status updates from {title}. Powered by OpenUptime.", { title: page.title }),
        cta: tr(lang, "Confirm subscription"),
        url: `${appUrl()}/api/public/status/_/confirm?token=${token}`,
        lang,
      });
      await sendEmail({ to: email, subject: tr(lang, "Confirm your subscription to {title}", { title: page.title }), fromName: "OpenUptime", ...mail }).catch((e) => console.error("confirm email failed", e));
    }
    return c.json({ ok: true });
  })
  .get("/_/confirm", async (c) => {
    const slug = await c.get("repo").confirmSubscriber(c.req.query("token") ?? "");
    return c.redirect(slug ? `${appUrl()}/status/${slug}?subscribed=1` : `${appUrl()}/`);
  })
  .get("/_/unsubscribe", async (c) => {
    const slug = await c.get("repo").removeSubscriber(c.req.query("token") ?? "");
    return c.redirect(slug ? `${appUrl()}/status/${slug}?unsubscribed=1` : `${appUrl()}/`);
  })
  .get("/:slug", async (c) => {
    const repo = c.get("repo");
    const page = await repo.statusPageBySlug(c.req.param("slug"));
    if (!page) return c.json({ error: "Not found" }, 404);
    const board = await repo.statusBoard(page);
    const overall = overallOf(board.components.map((x) => x.status));
    return c.json({
      page: { slug: page.slug, title: page.title, theme: page.theme, showLatency: page.showLatency, externalUrl: page.externalUrl },
      overall,
      bucket: board.bucket,
      components: board.components,
      incidents: board.incidents.map(toPublic),
    });
  });
