import type { DeliveryRetry, NewDelivery, Repo, SubscriberTarget } from "@openuptime/repo";
import { actionEmail, appUrl, sendEmail } from "./email";
import { unmetered, type Entitlements } from "./entitlements";
import { isLang, orgLang, tr, userLang, type Lang } from "./mail-i18n";

type Event = {
  kind: "incident.opened" | "incident.resolved";
  incident: { id: string; title: string; startedAt?: Date; resolvedAt?: Date | null };
  /** Why the check failed, shown in the down email. */
  reason?: string;
  /** Channel test: rendered as a "connected" message instead of an incident. */
  test?: true;
  /** latency incident rather than an outage */
  slow?: true;
  monitor: { id?: string; projectId?: string | null; name: string; target: string };
};

const utc = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
const duration = (ms: number, lang: Lang = "en") => {
  const m = Math.max(1, Math.round(ms / 60000));
  const [h, min] = lang === "zh-CN" ? ["小时", "分钟"] : ["h", "min"];
  const sp = lang === "zh-CN" ? "" : " ";
  return m < 60 ? `${m}${sp}${min}` : `${Math.floor(m / 60)}${sp}${h}${m % 60 ? ` ${m % 60}${sp}${min}` : ""}`;
};

const reason = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 500);

/** A slow or hung provider must not hold the check run (or the whole queue message) hostage. */
const SEND_TIMEOUT_MS = 10_000;

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });

async function post(url: string, body: unknown) {
  const res = await fetch(url, json(body));
  if (!res.ok) throw new Error(`${url.split("?")[0]} responded ${res.status}`);
}

/**
 * Lark / Feishu custom bot. The hook answers 200 even when it refuses a message, so the body's `code` decides; an optional
 * signing secret is sent as `sign = base64(HMAC-SHA256(key = "<timestamp>\n<secret>", message = ""))`.
 */
async function postLark(url: string, text: string, secret?: string) {
  const body: Record<string, unknown> = { msg_type: "text", content: { text } };
  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${timestamp}\n${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array()));
    body.timestamp = timestamp;
    body.sign = btoa(String.fromCharCode(...mac));
  }
  const res = await fetch(url, json(body));
  const data = (await res.json().catch(() => null)) as { code?: number; StatusCode?: number; msg?: string; StatusMessage?: string } | null;
  const code = data?.code ?? data?.StatusCode ?? 0;
  if (!res.ok || code !== 0) throw new Error(`Lark responded ${res.status}${code ? ` (${code}: ${data?.msg ?? data?.StatusMessage ?? "rejected"})` : ""}`);
}

const alertText = (ev: Event) =>
  ev.kind === "incident.opened"
    ? `${ev.slow ? "🟡" : "🔴"} ${ev.monitor.name} ${ev.slow ? "is responding slowly" : "is down"} — ${ev.incident.title}`
    : `✅ ${ev.monitor.name} has recovered`;

/** An alert that was not sent because the workspace's allowance for the period is used up; logged, never retried. */
class Skipped extends Error {}
const SKIPPED = "skipped: email allowance used up for this period";

/** Take emails for `subs` from the allowance: who may be mailed and how many were left out. A failing ledger lets them all through. */
async function withinEmails<T>(entitlements: Entitlements, orgId: string, subs: T[]) {
  if (!subs.length) return { send: subs, skipped: 0 };
  const granted = await entitlements.spendEmails(orgId, subs.length).catch((e) => (console.error("email allowance unavailable", e), subs.length));
  return { send: subs.slice(0, granted), skipped: subs.length - granted };
}

/** Attempts per alert, the first one included. The first retry is queued a minute after the failure, the next five minutes later. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_SEC = 300;

/** Try failed incident alerts again. Each channel's own delivery row is updated; nothing here throws. */
export async function retryDeliveries(repo: Repo, limit = 10) {
  const due: DeliveryRetry[] = await repo.claimRetries(limit);
  for (const { delivery, incident, monitor, channel } of due) {
    const resolved = delivery.kind === "incident.resolved";
    const ev: Event = {
      kind: resolved ? "incident.resolved" : "incident.opened",
      incident: { id: incident.id, title: incident.title, startedAt: incident.startedAt, resolvedAt: incident.resolvedAt },
      monitor: { id: monitor.id, projectId: monitor.projectId, name: monitor.name, target: monitor.target },
      ...(incident.auto && incident.severity === "minor" ? { slow: true as const } : {}),
    };
    const to = (channel.config as { to?: string }).to;
    const lang = channel.type === "email" && to ? await userLang(repo, to, await orgLang(repo, channel.organizationId)) : "en";
    const attempts = delivery.attempts + 1;
    try {
      await deliver(channel, ev, alertText(ev), lang);
      await repo.finishRetry(delivery.id, { ok: true, error: null, retryInSec: null });
    } catch (e) {
      console.error(`alert retry via ${channel.name} failed`, e);
      await repo.finishRetry(delivery.id, { ok: false, error: reason(e), retryInSec: attempts >= MAX_ATTEMPTS ? null : RETRY_DELAY_SEC });
    }
  }
  return due.length;
}

/** Fan an event out to every enabled channel in the org. Failures are logged, never thrown. */
export async function dispatchAlert(repo: Repo, orgId: string, ev: Event, channelIds: string[] = [], entitlements: Entitlements = unmetered) {
  const channels = await repo.channelsToAlert(orgId, { channelIds, projectId: ev.monitor.projectId });
  const text = alertText(ev);

  const fallback = channels.some((c) => c.type === "email") ? await orgLang(repo, orgId) : "en";
  const results = await Promise.allSettled(
    channels.map(async (c) => {
      const to = (c.config as { to?: string }).to;
      // an address that is an account reads in that account's language; any other address in the workspace owner's
      const lang = c.type === "email" && to ? await userLang(repo, to, fallback) : fallback;
      if (c.type === "email" && (await withinEmails(entitlements, orgId, [c])).skipped) throw new Skipped(SKIPPED);
      return deliver(c, ev, text, lang);
    }),
  );
  results.forEach((r, i) => r.status === "rejected" && !(r.reason instanceof Skipped) && console.error(`alert via ${channels[i].name} failed`, r.reason));
  const base = { organizationId: orgId, projectId: ev.monitor.projectId ?? null, kind: ev.kind, incidentId: ev.incident.id, monitorName: ev.monitor.name };
  const rows: NewDelivery[] = channels.map((ch, i) => {
    const r = results[i];
    // no channel id for a skipped alert: a retry would only hit the same empty allowance
    if (r.status === "rejected" && r.reason instanceof Skipped) return { ...base, channelId: null, channelName: ch.name, channelType: ch.type, ok: false, error: SKIPPED };
    return { ...base, channelId: ch.id, channelName: ch.name, channelType: ch.type, ok: r.status === "fulfilled", error: r.status === "rejected" ? reason(r.reason) : null };
  });
  const subs = await notifySubscribers(repo, orgId, ev, entitlements).catch((e) => { console.error("subscriber notify failed", e); return null; });
  if (subs && subs.total > 0) {
    rows.push({ ...base, channelId: null, channelName: "Status page subscribers", channelType: "email", ok: subs.failed === 0 && subs.skipped === 0,
      error: subs.failed ? `${subs.failed}/${subs.total} failed: ${subs.error}` : subs.skipped ? `${SKIPPED} (${subs.skipped}/${subs.total} not sent)` : null });
  }
  await repo.logDeliveries(rows);
}


/** Send one alert to one channel; throws when the provider rejects it. */
export async function deliver(c: { type: string; name?: string; config: unknown }, ev: Event, text: string, lang: Lang = "en") {
  const L = (k: string, v?: Record<string, string>) => tr(lang, k, v);
  const opened = ev.kind === "incident.opened";
  const cfg = c.config as Record<string, string | undefined>;
  switch (c.type) {
    case "slack":
      if (cfg.url) await post(cfg.url, { text });
      break;
    case "lark":
      if (cfg.url) await postLark(cfg.url, text, cfg.secret || undefined);
      break;
    case "webhook":
      if (cfg.url) await post(cfg.url, { kind: ev.kind, incident: ev.incident, monitor: { name: ev.monitor.name, target: ev.monitor.target }, ...(ev.slow ? { slow: true } : {}) });
      break;
    case "telegram":
      if (cfg.botToken && cfg.chatId)
        await post(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, { chat_id: cfg.chatId, text });
      break;
    case "pagerduty":
      if (cfg.routingKey)
        await post("https://events.pagerduty.com/v2/enqueue", {
          routing_key: cfg.routingKey,
          event_action: opened ? "trigger" : "resolve",
          dedup_key: ev.incident.id,
          payload: { summary: text, source: ev.monitor.target || ev.monitor.name, severity: "critical" },
        });
      break;
    case "email":
      if (cfg.to) {
        if (ev.test) {
          const t = actionEmail({
            title: L("Your channel is connected"),
            body: L("This is a test alert from OpenUptime. When a monitor goes down or recovers, you'll get a message like this one at this address."),
            badge: { label: L("Test"), tone: "neutral" },
            cta: L("Open alerting"),
            url: `${appUrl()}/app/alerting`,
            lang,
          });
          await sendEmail({ to: cfg.to, subject: L("Test alert from OpenUptime"), fromName: "OpenUptime Alerts", ...t });
          break;
        }
        const started = ev.incident.startedAt;
        const rows: [string, string][] = [[L("Monitor"), ev.monitor.name]];
        if (ev.monitor.target) rows.push([L("Target"), ev.monitor.target]);
        if (started) rows.push([L("Started"), utc(started)]);
        if (opened && ev.reason) rows.push([L("Error"), ev.reason]);
        if (!opened && started && ev.incident.resolvedAt) {
          rows.push([L("Downtime"), duration(ev.incident.resolvedAt.getTime() - started.getTime(), lang)]);
          rows.push([L("Resolved"), utc(ev.incident.resolvedAt)]);
        }
        const mail = actionEmail({
          title: L(opened ? (ev.slow ? "{name} is responding slowly" : "{name} is down") : "{name} has recovered", { name: ev.monitor.name }),
          body: L(opened ? (ev.slow ? "The monitor responded slower than its threshold on several checks in a row, so an incident was opened." : "The monitor failed its consecutive checks, so an incident was opened.") : "Checks are passing again and the incident is resolved."),
          badge: opened ? (ev.slow ? { label: L("Slow"), tone: "warn" } : { label: L("Down"), tone: "down" }) : { label: L("Recovered"), tone: "up" },
          rows,
          cta: L("View incident"),
          url: `${appUrl()}/app/incidents/${ev.incident.id}`,
          footer: L("You get this because {name} is an alert channel in your workspace.", { name: c.name ?? L("this email") }),
          footerUrl: { text: L("Manage alerting"), url: `${appUrl()}/app/alerting` },
          lang,
        });
        await sendEmail({ to: cfg.to, subject: `${opened ? (ev.slow ? "🟡" : "🔴") : "✅"} ${L(opened ? (ev.slow ? "{name} is responding slowly" : "{name} is down") : "{name} has recovered", { name: ev.monitor.name })} · OpenUptime`, fromName: "OpenUptime Alerts", ...mail });
      }
      break;
  }
}

async function mailSubscribers(
  subs: SubscriberTarget[],
  o: { subject: (pageTitle: string, lang: Lang) => string; title: (lang: Lang) => string; body: (lang: Lang) => string; badge: (lang: Lang) => { label: string; tone: "down" | "up" | "warn" | "neutral" } },
) {
  const results = await Promise.allSettled(
    subs.map((s) => {
      const lang: Lang = isLang(s.locale) ? s.locale : "en";
      const mail = actionEmail({
        title: o.title(lang),
        body: `${s.title}\n\n${o.body(lang)}`,
        badge: o.badge(lang),
        cta: tr(lang, "View status page"),
        url: `${appUrl()}/status/${s.slug}`,
        footer: tr(lang, "You receive this because you subscribed to updates from {title}.", { title: s.title }),
        footerUrl: { text: tr(lang, "Unsubscribe"), url: `${appUrl()}/api/public/status/_/unsubscribe?token=${s.token}` },
        lang,
      });
      return sendEmail({ to: s.email, subject: o.subject(s.title, lang), fromName: `${s.title} via OpenUptime`, ...mail });
    }),
  );
  results.forEach((r, i) => r.status === "rejected" && console.error(`subscriber email to ${subs[i].email} failed`, r.reason));
  const bad = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  return { total: subs.length, failed: results.filter((r) => r.status === "rejected").length, error: bad ? reason(bad.reason) : "" };
}

async function notifySubscribers(repo: Repo, orgId: string, ev: Event, entitlements: Entitlements) {
  if (!ev.monitor.id) return null;
  const all = await repo.subscribersFor(orgId, ev.monitor.id);
  const { send: subs, skipped } = await withinEmails(entitlements, orgId, all);
  const opened = ev.kind === "incident.opened";
  const head = (lang: Lang) => `${opened ? (ev.slow ? "🟡" : "🔴") : "✅"} ${tr(lang, opened ? (ev.slow ? "{name} is responding slowly" : "{name} is down") : "{name} has recovered", { name: ev.monitor.name })}`;
  const sent = await mailSubscribers(subs, {
    subject: (p, lang) => `[${p}] ${head(lang)}`,
    title: head,
    body: () => ev.monitor.name,
    badge: (lang) => (opened ? (ev.slow ? { label: tr(lang, "Slow"), tone: "warn" } : { label: tr(lang, "Down"), tone: "down" }) : { label: tr(lang, "Recovered"), tone: "up" }),
  });
  return { ...sent, total: all.length, skipped };
}

/** A manual incident update (investigating → identified → … → resolved) goes to the same subscribers. */
export async function notifyIncidentUpdate(
  repo: Repo,
  inc: { organizationId: string; monitorId: string | null; title: string },
  update: { status: string; body: string },
  entitlements: Entitlements = unmetered,
) {
  const { send: subs } = await withinEmails(entitlements, inc.organizationId, await repo.subscribersFor(inc.organizationId, inc.monitorId));
  const label = (lang: Lang) => tr(lang, update.status === "resolved" ? "Resolved" : update.status[0].toUpperCase() + update.status.slice(1));
  await mailSubscribers(subs, {
    subject: (p, lang) => `[${p}] ${label(lang)}: ${inc.title}`,
    title: (lang) => `${label(lang)}: ${inc.title}`,
    body: () => update.body,
    badge: (lang) => ({ label: label(lang), tone: update.status === "resolved" ? "up" : update.status === "investigating" ? "down" : "warn" }),
  }).catch((e) => console.error("incident update notify failed", e));
}
