import { zValidator } from "@hono/zod-validator";
import type { IncidentUpdate, IncidentWithUpdates } from "@openuptime/repo";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { actionEmail, appUrl, sendEmail } from "../email";
import { langFromHeader, tr } from "../mail-i18n";
import type { AppEnv } from "../env";
import type { Plan } from "../entitlements";
import { requireManager, uuidParams } from "../middleware";
import { clientIp } from "../ratelimit";
import { sharedCache, waitUntilOf } from "../sharedcache";
import { buildIcs, buildLlmsTxt, buildRss, FEED_LIMIT, ICS_LIMIT } from "../status-feeds";

// optional link to the owner's own website; "" clears it
const externalUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => v === "" || /^https?:\/\//i.test(v) && URL.canParse(v), "Must be an http(s) URL")
  .transform((v) => v || null)
  .nullable()
  .optional();
/** Whether the plan lets a status page hide OpenUptime's branding. Editions without plans (null) allow it. */
const brandingAllowed = (plan: Plan | null) => plan?.hideBranding !== false;
const pageBody = z.object({
  title: z.string().min(1).max(120),
  theme: z.enum(["light", "dark", "auto"]).optional(),
  showLatency: z.boolean().optional(),
  externalUrl,
  hideBranding: z.boolean().optional(),
  // uptime bars: green from `uptimeOkPct`, amber from `uptimeWarnPct`, red below
  uptimeOkPct: z.number().min(1).max(100).optional(),
  uptimeWarnPct: z.number().min(1).max(100).optional(),
  // public MCP tools may serve this page
  mcpEnabled: z.boolean().optional(),
  // hours before maintenance starts that subscribers are reminded; 0 = never
  maintenanceReminderHours: z.number().int().min(0).max(168).optional(),
  monitorIds: z.array(z.string().uuid()).optional(),
  // ordered, optionally grouped; takes precedence over monitorIds
  components: z.array(z.object({ monitorId: z.string().uuid(), groupName: z.string().trim().min(1).max(60).optional() })).max(200).optional(),
});
/** The two uptime thresholds must leave room for amber between them; checked against what the page will hold afterwards. */
const thresholdsProblem = (c: Context<AppEnv>, ok: number, warn: number) =>
  warn < ok ? null : c.json({ error: "The amber threshold must be below the green one" }, 400);
const toComponents = (v: { monitorIds?: string[]; components?: { monitorId: string; groupName?: string }[] }) =>
  v.components ?? (v.monitorIds ?? []).map((monitorId) => ({ monitorId }));

/** The stored flag counts only while the plan allows it: after a downgrade the page shows OpenUptime again, and the flag is kept. */
async function brandingHidden(c: Context<AppEnv>, page: { hideBranding: boolean; organizationId: string }) {
  if (!page.hideBranding) return false;
  return brandingAllowed(await c.get("entitlements").plan(page.organizationId));
}

/** 402 when the request turns branding off on a plan that does not include that; null otherwise (turning it back on is always fine). */
async function brandingProblem(c: Context<AppEnv>, hide: boolean | undefined) {
  if (!hide) return null;
  const plan = await c.get("entitlements").plan(c.get("orgId"));
  if (brandingAllowed(plan)) return null;
  return c.json({ error: `The ${plan!.name} plan cannot hide the OpenUptime branding`, code: "branding_not_allowed", plan: plan!.id, upgradeUrl: plan!.upgradeUrl }, 402);
}

/** Management API for status pages (authenticated). */
export const statusPages = new Hono<AppEnv>()
  // an edit made through the API shows on the public page at once (on this instance; others catch up within the TTL)
  .use("*", async (c, next) => {
    await next();
    if (c.req.method !== "GET" && c.res.ok) {
      purgePublicStatus();
    }
  })
  .get("/", async (c) => c.json(await c.get("repo").listStatusPages(c.get("orgId"), c.get("projectId"))))
  .post(
    "/",
    zValidator("json", z.object({ slug: z.string().regex(/^[a-z0-9-]{3,40}$/) }).and(pageBody.partial({ title: true }).required({ title: true }))),
    async (c) => {
      const repo = c.get("repo");
      const { monitorIds, components, ...v } = c.req.valid("json");
      const denied = await brandingProblem(c, v.hideBranding);
      if (denied) return denied;
      const bad = thresholdsProblem(c, v.uptimeOkPct ?? 99.9, v.uptimeWarnPct ?? 98);
      if (bad) return bad;
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
    const plan = await c.get("entitlements").plan(c.get("orgId"));
    // what the editor needs to know about the plan: may this page hide the brand, and where to upgrade if not
    const branding = { allowed: brandingAllowed(plan), upgradeUrl: brandingAllowed(plan) ? undefined : plan?.upgradeUrl };
    return c.json({ ...page, monitorIds: comps.map((x) => x.monitorId), components: comps, branding });
  })
  .patch("/:id", uuidParams, requireManager, zValidator("json", pageBody.partial()), async (c) => {
    const repo = c.get("repo");
    const page = await repo.getStatusPage(c.get("orgId"), c.req.param("id"), c.get("projectScope"));
    if (!page) return c.json({ error: "Not found" }, 404);
    const { monitorIds, components, ...v } = c.req.valid("json");
    // a page that already hides the brand can still be edited after a downgrade; only turning it on is refused
    const denied = await brandingProblem(c, v.hideBranding && !page.hideBranding ? true : undefined);
    if (denied) return denied;
    const bad = thresholdsProblem(c, v.uptimeOkPct ?? page.uptimeOkPct, v.uptimeWarnPct ?? page.uptimeWarnPct);
    if (bad) return bad;
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

/**
 * Public shape of an incident: no assignee, no organization, sanitised update bodies. Internal updates are dropped here
 * as well as in the query, so no new read path can leak one. The root cause and postmortem are shown only once the incident
 * is resolved and a person has published them; resolving alone (automatic recovery included) never makes them public.
 */
export const toPublic = (i: IncidentWithUpdates) => ({
  id: i.id, number: i.number, title: i.title, status: i.status, severity: i.severity, startedAt: i.startedAt, resolvedAt: i.resolvedAt,
  ...(i.resolvedAt && i.postmortemPublishedAt ? { rootCause: i.rootCause, postmortem: i.postmortem } : {}),
  updates: i.updates.filter((u) => u.visibility === "public").map((u) => ({ id: u.id, body: publicBody(u), status: u.status, createdAt: u.createdAt })),
});

const emailSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
const MAX_SUBSCRIBERS = 5000;
const HISTORY_PAGE = 15;
// Public pages are read far more often than they change, and each read aggregates 90 days of rollups: serve a short-lived copy.
// A page edit or an incident update shows up within this long (the data centre's copy is not cleared by an edit). Only found pages are kept.
// Tests read a page right after changing it, so they run without the cache.
const PUBLIC_TTL_MS = typeof process !== "undefined" && process.env?.VITEST ? 0 : 30_000;
const boardCache = sharedCache<unknown>("status-board", PUBLIC_TTL_MS);
const historyCache = sharedCache<unknown>("status-history", PUBLIC_TTL_MS);

/**
 * Drops this instance's copies of the public board and history, so a change made through the API (an incident update, a
 * postmortem published or taken down) shows on the next read here. Other instances and the data centre's shared copy
 * catch up within PUBLIC_TTL_MS; the responses themselves carry no shared-cache lifetime beyond that.
 */
export function purgePublicStatus() {
  boardCache.clear();
  historyCache.clear();
}

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

/** The public MCP tools add `via=mcp`; a page whose owner turned that off refuses them (the page itself stays public). */
async function mcpDenied(c: Context<AppEnv>, slug: string) {
  if (c.req.query("via") !== "mcp") return null;
  const page = await c.get("repo").statusPageBySlug(slug);
  return page && !page.mcpEnabled ? c.json({ error: "The owner of this status page turned off MCP access" }, 403) : null;
}

async function rssFeed(c: Context<AppEnv>) {
  const repo = c.get("repo");
  const page = await repo.statusPageBySlug(c.req.param("slug")!);
  if (!page) return c.json({ error: "Not found" }, 404);
  const [incidents, maintenance] = await Promise.all([repo.pageIncidents(page, { limit: FEED_LIMIT }), repo.pageMaintenance(page, { limit: FEED_LIMIT })]);
  const origin = appUrl() || new URL(c.req.url).origin;
  const xml = buildRss({ title: page.title, link: `${origin}/status/${page.slug}`, incidents: incidents.map(toPublic), maintenance });
  return c.body(xml, 200, { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=60" });
}

/** All slug routes, including subscriptions and machine-readable feeds, share this boundary. */
async function statusAccess(c: Context<AppEnv>, next: () => Promise<void>) {
  const policy = c.get("entitlements").statusPageAccess;
  const slug = c.req.param("slug");
  if (!policy || !slug || slug === "_") return next();
  // No shared response is safe while a deployment uses an access policy, including not-found/errors.
  c.set("statusResponsePrivate", true);
  c.header("cache-control", "private, no-store");
  const page = await c.get("repo").statusPageBySlug(slug);
  if (!page) return c.json({ error: "Not found" }, 404);
  let access: Awaited<ReturnType<typeof policy>>;
  try { access = await policy(page, c.req.raw); }
  catch {
    console.error("status page access policy unavailable");
    return c.json({ error: "Unavailable" }, 503);
  }
  if (access?.allowed !== true) return c.json({ error: "Not found" }, 404);
  // Always bypass external caches for policy-enabled deployments: a formerly public page may change access.
  await next();
  c.header("cache-control", "private, no-store");
  c.header("vary", "Cookie, Authorization");
}

export const publicStatus = new Hono<AppEnv>()
  .use("/:slug", statusAccess)
  .use("/:slug/*", statusAccess)
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
    const before = c.req.query("before");
    const cursor = before && !Number.isNaN(Date.parse(before)) ? new Date(before) : undefined;
    const slug = c.req.param("slug");
    const refused = await mcpDenied(c, slug);
    if (refused) return refused;
    const body = await historyCache.cached(
      `${slug}|${cursor?.toISOString() ?? ""}`,
      async () => {
        const repo = c.get("repo");
        const page = await repo.statusPageBySlug(slug);
        if (!page) return undefined;
        const rows = await repo.pageIncidents(page, { limit: HISTORY_PAGE + 1, before: cursor });
        const items = rows.slice(0, HISTORY_PAGE).map(toPublic);
        return { items, next: rows.length > HISTORY_PAGE ? items[items.length - 1].startedAt : null };
      },
      waitUntilOf(c),
      { bypass: c.get("statusResponsePrivate") },
    );
    return body ? c.json(body) : c.json({ error: "Not found" }, 404);
  })
  // incidents and maintenance together, newest first; /rss stays as the original address of the same feed
  .get("/:slug/rss.xml", (c) => rssFeed(c))
  .get("/:slug/rss", (c) => rssFeed(c))
  // scheduled maintenance as a calendar subscription
  .get("/:slug/maintenance.ics", async (c) => {
    const repo = c.get("repo");
    const page = await repo.statusPageBySlug(c.req.param("slug"));
    if (!page) return c.json({ error: "Not found" }, 404);
    const windows = await repo.pageMaintenance(page, { since: new Date(Date.now() - 30 * 864e5), limit: ICS_LIMIT });
    const origin = appUrl() || new URL(c.req.url).origin;
    const body = buildIcs({ title: page.title, link: `${origin}/status/${page.slug}`, host: new URL(origin).host, windows });
    return c.body(body, 200, { "content-type": "text/calendar; charset=utf-8", "cache-control": "public, max-age=300" });
  })
  // short, factual page summary for language models and other crawlers
  .get("/:slug/llms.txt", async (c) => {
    const repo = c.get("repo");
    const page = await repo.statusPageBySlug(c.req.param("slug"));
    if (!page) return c.json({ error: "Not found" }, 404);
    const [board, windows] = await Promise.all([repo.statusBoard(page), repo.pageMaintenance(page, { since: new Date(), limit: 10 })]);
    const origin = appUrl() || new URL(c.req.url).origin;
    const body = buildLlmsTxt({
      title: page.title,
      link: `${origin}/status/${page.slug}`,
      api: `${origin}/api/public/status/${page.slug}`,
      overall: LABELS[overallOf(board.components.map((x) => x.status))].en,
      components: board.components,
      incidents: board.incidents,
      maintenance: [...windows].reverse(),
      mcp: page.mcpEnabled ? `${origin}/api/mcp/public` : null,
    });
    return c.body(body, 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" });
  })
  // upcoming and recent maintenance as JSON (the public MCP tools read this)
  .get("/:slug/maintenance", async (c) => {
    const slug = c.req.param("slug");
    const refused = await mcpDenied(c, slug);
    if (refused) return refused;
    const repo = c.get("repo");
    const page = await repo.statusPageBySlug(slug);
    if (!page) return c.json({ error: "Not found" }, 404);
    const now = Date.now();
    const rows = await repo.pageMaintenance(page, { since: new Date(now - 7 * 864e5), limit: 50 });
    const items = rows.reverse().map((w) => ({
      id: w.id,
      name: w.name,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      state: w.startsAt.getTime() > now ? "scheduled" : w.endsAt.getTime() >= now ? "active" : "completed",
    }));
    return c.json({ slug: page.slug, items }, 200, { "cache-control": "public, max-age=60" });
  })
  .post("/:slug/subscribe", zValidator("json", emailSchema.extend({ monitorIds: z.array(z.string().uuid()).max(200).optional() })), async (c) => {
    const repo = c.get("repo");
    const page = await repo.statusPageBySlug(c.req.param("slug"));
    if (!page) return c.json({ error: "Not found" }, 404);
    const { email, monitorIds } = c.req.valid("json");
    // Each request can trigger an outbound email, so cap per client, per address and per page.
    const ip = clientIp(c);
    const ok =
      (!ip || (await repo.withinLimit(`sub:ip:${ip}`, 10, 3600))) &&
      (await repo.withinLimit(`sub:mail:${page.id}:${email}`, 3, 3600)) &&
      // one address across all pages, so many pages cannot be used to mail it
      (await repo.withinLimit(`sub:mail:${email}`, 5, 3600)) &&
      (await repo.withinLimit(`sub:page:${page.id}`, 200, 3600));
    if (!ok) return c.json({ error: "Too many requests, try again later" }, 429);
    if ((await repo.subscriberCount(page.id)) >= MAX_SUBSCRIBERS) return c.json({ error: "Subscriber limit reached" }, 409);
    // only components that are on the page can be chosen
    const shown = new Set((await repo.pageComponents(page.id)).map((x) => x.monitorId));
    const chosen = [...new Set(monitorIds ?? [])].filter((id) => shown.has(id));
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const row = await repo.addSubscriber({ pageId: page.id, email, token, locale: langFromHeader(c.req.header("accept-language")), monitorIds: chosen });
    // Always the same answer, so the endpoint does not reveal who is subscribed. A pending address gets its confirmation
    // again (the first link may be lost); a confirmed one gets nothing, so the form cannot be used to mail a stranger.
    if (row.confirmed) return c.json({ ok: true });
    const lang = row.locale === "zh-CN" ? "zh-CN" : "en";
    const white = await brandingHidden(c, page);
    const footer = tr(lang, white ? "Status updates from {title}." : "Status updates from {title}. Powered by OpenUptime.", { title: page.title });
    const mail = actionEmail({
      title: tr(lang, "Confirm your subscription to {title}", { title: page.title }),
      body: tr(lang, "You will get an email when an incident is opened, updated or resolved. If this wasn’t you, ignore this message and you won’t be subscribed."),
      footer,
      cta: tr(lang, "Confirm subscription"),
      url: `${appUrl()}/api/public/status/_/confirm?token=${row.token}`,
      lang,
      brand: white ? page.title : undefined,
    });
    const subject = tr(lang, "Confirm your subscription to {title}", { title: page.title });
    await sendEmail({ to: email, subject, fromName: white ? page.title : "OpenUptime", ...mail }).catch((e) => console.error("subscription email failed", e));
    return c.json({ ok: true });
  })
  // Confirming stays a GET so the link in the mail works in one click; it only ever sets a flag, so repeating it (or a mail
  // scanner opening it) changes nothing further. Unsubscribing is different: GET shows a page, and only a POST acts.
  .get("/_/confirm", async (c) => {
    const slug = await c.get("repo").confirmSubscriber(c.req.query("token") ?? "");
    return c.redirect(slug ? `${appUrl()}/status/${slug}?subscribed=1` : `${appUrl()}/`);
  })
  .get("/_/unsubscribe", (c) => {
    const token = c.req.query("token") ?? "";
    const zh = langOf(c) === "zh";
    const t = zh
      ? { title: "取消订阅", text: "确认不再收到此状态页的邮件通知？", button: "取消订阅" }
      : { title: "Unsubscribe", text: "Stop receiving email updates from this status page?", button: "Unsubscribe" };
    const html = `<!doctype html><html lang="${zh ? "zh-CN" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${t.title}</title><style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f7f7f4;color:#0e1411}main{max-width:360px;padding:24px;text-align:center}button{font:inherit;font-weight:600;padding:10px 20px;border:0;border-radius:8px;background:#0e1411;color:#fff;cursor:pointer}</style></head><body><main><h1 style="font-size:20px">${t.title}</h1><p>${t.text}</p><form method="post" action="?token=${encodeURIComponent(token)}"><button type="submit">${t.button}</button></form></main></body></html>`;
    return c.html(html, 200, { "cache-control": "no-store", "x-robots-tag": "noindex" });
  })
  // POST acts: from the page's button (answered with a redirect) and from a mail client's one-click unsubscribe (RFC 8058, answered with 200)
  .post("/_/unsubscribe", async (c) => {
    const slug = await c.get("repo").removeSubscriber(c.req.query("token") ?? "");
    const oneClick = (await c.req.text().catch(() => "")).includes("List-Unsubscribe=One-Click");
    if (oneClick) return c.text("OK");
    return c.redirect(slug ? `${appUrl()}/status/${slug}?unsubscribed=1` : `${appUrl()}/`, 303);
  })
  .get("/:slug", async (c) => {
    const slug = c.req.param("slug");
    const refused = await mcpDenied(c, slug);
    if (refused) return refused;
    const body = await boardCache.cached(
      slug,
      async () => {
        const repo = c.get("repo");
        const page = await repo.statusPageBySlug(slug);
        if (!page) return undefined;
        const board = await repo.statusBoard(page);
        return {
          page: { slug: page.slug, title: page.title, theme: page.theme, showLatency: page.showLatency, externalUrl: page.externalUrl, hideBranding: await brandingHidden(c, page), uptimeOkPct: page.uptimeOkPct, uptimeWarnPct: page.uptimeWarnPct },
          overall: overallOf(board.components.map((x) => x.status)),
          bucket: board.bucket,
          components: board.components,
          incidents: board.incidents.map(toPublic),
        };
      },
      waitUntilOf(c),
      { bypass: c.get("statusResponsePrivate") },
    );
    return body ? c.json(body) : c.json({ error: "Not found" }, 404);
  });
