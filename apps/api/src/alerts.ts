import { MAX_REMINDERS, type AlertChannel, type AlertDelivery, type DeliveryRetry, type NewDelivery, type Repo, type SubscriberTarget } from "@openuptime/repo";
import { sendPush } from "./apns";
import { actionEmail, appUrl, sendEmail } from "./email";
import { unmetered, type Entitlements } from "./entitlements";
import { isLang, orgLang, tr, userLang, type Lang } from "./mail-i18n";
import { guardedFetch, readCapped } from "./netguard";
import { ttlCache } from "./ttlcache";

type Event = {
  /** a reminder or escalation repeats the down alert for an incident nobody has acknowledged */
  kind: "incident.opened" | "incident.resolved" | "incident.reminder" | "incident.escalated";
  /** which repeat (reminder) or level (escalation) this is */
  count?: number;
  incident: { id: string; title: string; startedAt?: Date; resolvedAt?: Date | null };
  /** Why the check failed, shown in the down email. */
  reason?: string;
  /** Channel test: rendered as a "connected" message instead of an incident. */
  test?: true;
  /** latency incident rather than an outage */
  slow?: true;
  /** the monitor failed again soon after recovering, so an earlier incident was reopened */
  reopened?: true;
  monitor: { id?: string; projectId?: string | null; name: string; target: string };
  /** The monitor's project; filled in when the alert goes out. */
  project?: { id: string; name: string };
  /** The workspace has more than one project, so the project's name is shown in the alert. */
  multiProject?: true;
};

const PROJECT_TTL_MS = 30_000;
const projectCache = ttlCache<{ names: Map<string, string> }>(PROJECT_TTL_MS);
/** For tests: forget the cached project names. */
export const clearProjectNames = () => projectCache.clear();

/**
 * Names the monitor's project on the event. The workspace's projects are read once and kept for a short while, so a burst of
 * alerts costs one query. A lookup that fails leaves the event as it is: an alert never waits on, or fails because of, a name.
 */
export async function withProject<E extends Event>(repo: Repo, orgId: string, ev: E): Promise<E> {
  const id = ev.monitor.projectId;
  if (!id) return ev;
  try {
    let hit = projectCache.get(orgId);
    if (!hit) {
      hit = { names: new Map((await repo.listProjects(orgId, null)).map((p) => [p.id, p.name])) };
      projectCache.set(orgId, hit);
    }
    const name = hit.names.get(id);
    if (!name) return ev;
    return { ...ev, project: { id, name }, ...(hit.names.size > 1 ? { multiProject: true as const } : {}) };
  } catch (e) {
    console.error("project name lookup failed", e);
    return ev;
  }
}

/** `[name] ` when the alert should say which project it is from, else nothing. */
const tag = (ev: Pick<Event, "project" | "multiProject">) => (ev.project && ev.multiProject ? `[${ev.project.name}] ` : "");

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

/** The destination's host only: webhook paths and bot tokens are credentials and must not end up in logs or delivery rows. */
const hostOf = (url: string) => {
  try { return new URL(url).host; } catch { return "the destination"; }
};

/** Sends through the SSRF guard; errors name the host, never the full URL. */
async function send(url: string, body: unknown) {
  try {
    return (await guardedFetch(url, json(body))).res;
  } catch (e) {
    const name = (e as Error).name;
    throw new Error(name === "BlockedTarget" ? (e as Error).message : name === "TimeoutError" ? `${hostOf(url)} timed out` : `Could not reach ${hostOf(url)}`);
  }
}

async function post(url: string, body: unknown) {
  const res = await send(url, body);
  await res.body?.cancel().catch(() => {}); // only the status matters; do not hold the connection open for a body
  if (!res.ok) throw new Error(`${hostOf(url)} responded HTTP ${res.status}`);
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
  const res = await send(url, body);
  const data = (await readCapped(res, 64 * 1024).then((t) => JSON.parse(t)).catch(() => null)) as { code?: number; StatusCode?: number; msg?: string; StatusMessage?: string } | null;
  const code = data?.code ?? data?.StatusCode ?? 0;
  if (!res.ok || code !== 0) throw new Error(`Lark responded HTTP ${res.status}${code ? ` (${code}: ${data?.msg ?? data?.StatusMessage ?? "rejected"})` : ""}`);
}

const alertText = (ev: Event) =>
  ev.kind === "incident.opened"
    ? `${ev.slow ? "🟡" : "🔴"} ${tag(ev)}${ev.monitor.name} ${ev.slow ? "is responding slowly" : "is down"}${ev.reopened ? " again" : ""} — ${ev.incident.title}`
    : ev.kind === "incident.reminder"
      ? `⏰ ${tag(ev)}${ev.monitor.name} ${ev.slow ? "is still responding slowly" : "is still down"} and nobody has acknowledged it — reminder ${ev.count ?? 1}`
      : ev.kind === "incident.escalated"
        ? `🚨 ${tag(ev)}${ev.monitor.name} ${ev.slow ? "is still responding slowly" : "is still down"} and nobody has acknowledged it — escalated to you`
        : `✅ ${tag(ev)}${ev.monitor.name} has recovered`;

/** The alert is not sent, on purpose, and that is final (an allowance used up, a channel switched off); never retried. The message is the reason shown to people. */
export class Skipped extends Error {}
const SKIPPED = "skipped: email allowance used up for this period";
const RETRIED_KINDS = new Set(["incident.opened", "incident.resolved", "incident.reminder", "incident.escalated"]);

/** Devices an event is being pushed to, with whether that push worked: a phone is pushed once per event, unless the first push failed. */
export type PushedDevices = Map<string, Promise<boolean>>;

/** Take emails for `subs` from the allowance: who may be mailed and how many were left out. A failing ledger lets them all through. */
async function withinEmails<T>(entitlements: Entitlements, orgId: string, subs: T[]) {
  if (!subs.length) return { send: subs, skipped: 0 };
  const granted = await entitlements.spendEmails(orgId, subs.length).catch((e) => (console.error("email allowance unavailable", e), subs.length));
  return { send: subs.slice(0, granted), skipped: subs.length - granted };
}

/** Attempts per alert, the first one included. The first retry is queued a minute after the failure, the next five minutes later. */
export const MAX_ATTEMPTS = 3;
const RETRY_DELAY_SEC = 300;
const FIRST_RETRY_DELAY_SEC = 60;
/** A row that stays in `sending` this long belongs to a worker that died. */
export const STUCK_SEC = 300;

const eventOf = (kind: string, incident: DeliveryRetry["incident"], monitor: DeliveryRetry["monitor"], count?: number, reopened = false): Event => ({
  kind: kind === "incident.resolved" || kind === "incident.reminder" || kind === "incident.escalated" ? kind : "incident.opened",
  count,
  incident: { id: incident.id, title: incident.title, startedAt: incident.startedAt, resolvedAt: incident.resolvedAt },
  monitor: { id: monitor.id, projectId: monitor.projectId, name: monitor.name, target: monitor.target },
  ...(incident.auto && incident.severity === "minor" ? { slow: true as const } : {}),
  ...(reopened ? { reopened: true as const } : {}),
});

const languageFor = async (repo: Repo, channel: AlertChannel, fallback?: Lang) => {
  const to = (channel.config as { to?: string }).to;
  return channel.type === "email" && to ? userLang(repo, to, fallback ?? (await orgLang(repo, channel.organizationId))) : (fallback ?? "en");
};

const ROUTING_UNAVAILABLE = "alert routing policy unavailable";
async function authorizeChannel(channel: AlertChannel, ev: Event, entitlements: Entitlements, at: Date) {
  let allowed: boolean;
  try {
    if (!entitlements.allowAlertChannel) throw new Error(ROUTING_UNAVAILABLE);
    allowed = await entitlements.allowAlertChannel(channel.organizationId, {
      projectId: ev.monitor.projectId ?? null, monitorId: ev.monitor.id ?? null,
      incidentId: ev.incident.id, kind: ev.kind, at, channelId: channel.id,
    });
  } catch { throw new Error(ROUTING_UNAVAILABLE); }
  if (!allowed) throw new Skipped("skipped: not selected by alert routing policy");
}

/**
 * Send one delivery that this worker has already claimed (status `sending`) and record the outcome. Never throws.
 * `meter` charges an email against the workspace allowance; retries are not charged again.
 */
async function execute(repo: Repo, d: Pick<AlertDelivery, "id" | "kind" | "attempts">, channel: AlertChannel, ev: Event, lang: Lang, meter?: Entitlements, pushed?: PushedDevices, routingAt?: Date) {
  const attempts = d.attempts + 1;
  try {
    if (routingAt) await authorizeChannel(channel, ev, meter ?? unmetered, routingAt);
    if (meter && channel.type === "email" && (await withinEmails(meter, channel.organizationId, [channel])).skipped) throw new Skipped(SKIPPED);
    await deliver(channel, ev, alertText(ev), lang, repo, pushed);
    await repo.finishDelivery(d.id, { status: "sent", error: null, message: null });
    return true;
  } catch (e) {
    if (e instanceof Skipped) {
      await repo.finishDelivery(d.id, { status: "skipped", error: e.message, message: e.message }).catch((x) => console.error("could not record a skipped alert", x));
      return false;
    }
    console.error(`alert via ${channel.name} failed`, e);
    const why = reason(e);
    const retryInSec = !RETRIED_KINDS.has(d.kind) || attempts >= MAX_ATTEMPTS ? null : attempts === 1 ? FIRST_RETRY_DELAY_SEC : RETRY_DELAY_SEC;
    const message = retryInSec == null ? `failed: ${why}${RETRIED_KINDS.has(d.kind) ? ` (gave up after ${attempts} attempts)` : ""}` : `failed: ${why} (attempt ${attempts} of ${MAX_ATTEMPTS}, trying again in ${retryInSec >= 120 ? `${retryInSec / 60} min` : `${retryInSec} s`})`;
    await repo.finishDelivery(d.id, { status: "failed", error: why, message, retryInSec }).catch((x) => console.error("could not record a failed alert", x));
    return false;
  }
}

/** A delivery row that counts as an alert people could have seen: not one that was skipped or failed. */
export const wasDelivered = (r: { status?: string | null; ok?: boolean }) => (r.status ? r.status !== "skipped" && r.status !== "failed" : r.ok !== false);

/** Try failed incident alerts again. Each channel's own delivery row is updated; nothing here throws. */
export async function retryDeliveries(repo: Repo, limit = 10, entitlements: Entitlements = unmetered) {
  const due: DeliveryRetry[] = await repo.claimRetries(limit);
  // a phone is pushed once per event, also when several of its retries are due in the same round
  const pushedBy = new Map<string, PushedDevices>();
  for (const { delivery, incident, monitor, channel } of due) {
    // a repeat or escalation is pointless once someone has taken the incident
    if ((delivery.kind === "incident.reminder" || delivery.kind === "incident.escalated") && (incident.acknowledgedAt || incident.resolvedAt)) {
      const why = incident.resolvedAt ? "skipped: the incident was resolved before this alert could be sent" : "skipped: the incident was acknowledged before this alert could be sent";
      await repo.finishDelivery(delivery.id, { status: "skipped", error: why, message: why });
      continue;
    }
    // the incident changed while this alert waited for its retry: a "down" for one that has recovered, or a "recovered" for one that was reopened
    if ((delivery.kind === "incident.opened" && incident.resolvedAt) || (delivery.kind === "incident.resolved" && !incident.resolvedAt)) {
      const why = delivery.kind === "incident.opened" ? "skipped: the incident was resolved before this alert could be sent" : "skipped: the incident was reopened before this alert could be sent";
      await repo.finishDelivery(delivery.id, { status: "skipped", error: why, message: why });
      continue;
    }
    // A reopened incident alerts again as "down again". Which of its down alerts this is follows from the order they were
    // queued in: a later one makes this a stale original, an earlier one makes this the "again".
    let reopened = false;
    if (delivery.kind === "incident.opened" && incident.evaluationNote?.startsWith("reopened")) {
      const opened = (await repo.incidentDeliveries(incident.organizationId, incident.id)).filter((x) => x.kind === "incident.opened" && x.id !== delivery.id);
      if (opened.some((x) => x.channelId === delivery.channelId && x.createdAt > delivery.createdAt && wasDelivered(x))) {
        const why = "skipped: the incident was reopened and alerted again before this alert could be sent";
        await repo.finishDelivery(delivery.id, { status: "skipped", error: why, message: why });
        continue;
      }
      reopened = opened.some((x) => x.createdAt < delivery.createdAt);
    }
    const ev = await withProject(repo, incident.organizationId, eventOf(delivery.kind, incident, monitor, delivery.kind === "incident.escalated" ? incident.escalationLevel : incident.reminderCount, reopened));
    const eventKey = `${incident.id}:${delivery.kind}:${ev.count ?? 0}`;
    if (!pushedBy.has(eventKey)) pushedBy.set(eventKey, new Map());
    const pendingRouting = delivery.error === ROUTING_UNAVAILABLE;
    await execute(repo, delivery, channel, ev, await languageFor(repo, channel), pendingRouting ? entitlements : undefined, pushedBy.get(eventKey), pendingRouting ? delivery.createdAt : undefined);
  }
  return due.length;
}

/**
 * Queue one delivery per channel, claim each (one conditional UPDATE, so overlapping runs cannot send the same row twice)
 * and send it. Switched-off channels get a row that says so. A log that cannot be written must not stop the alert, so the
 * channels without a row are sent directly.
 */
async function fanOut(repo: Repo, orgId: string, event: Event, channels: AlertChannel[], entitlements: Entitlements, extra: Partial<NewDelivery> = {}) {
  const ev = await withProject(repo, orgId, event);
  const fallback = channels.some((c) => c.type === "email") ? await orgLang(repo, orgId) : "en";
  const base = { organizationId: orgId, projectId: ev.monitor.projectId ?? null, kind: ev.kind, incidentId: ev.incident.id, monitorName: ev.monitor.name, ...extra };
  const live = channels.filter((c) => c.enabled);
  const off = channels.filter((c) => !c.enabled);
  await repo.logDeliveries(off.map((c) => ({ ...base, channelId: c.id, channelName: c.name, channelType: c.type, ok: false, status: "skipped" as const, error: "skipped: channel disabled", statusMessage: "skipped: channel disabled" })));
  // a phone is pushed once per event, however many push channels reach it
  const pushed: PushedDevices = new Map();
  const rows = await repo.queueDeliveries(live.map((c) => ({ ...base, channelId: c.id, channelName: c.name, channelType: c.type, ok: false })));
  await Promise.all(
    live.map(async (c) => {
      const lang = await languageFor(repo, c, fallback);
      const row = rows.find((r) => r.channelId === c.id);
      if (!row) {
        // no row to claim: send anyway, only the history is missing
        await (async () => {
          if (entitlements.allowAlertChannel) await authorizeChannel(c, ev, entitlements, new Date());
          await deliver(c, ev, alertText(ev), lang, repo, pushed);
        })().catch((e) => console.error(`alert via ${c.name} failed`, e));
        return;
      }
      const claimed = await repo.claimDelivery(row.id);
      if (claimed) await execute(repo, claimed, c, ev, lang, entitlements, pushed, entitlements.allowAlertChannel ? claimed.createdAt ?? new Date() : undefined);
    }),
  );
}

/** Fan an event out to every enabled channel in the org. Failures are logged, never thrown. */
export async function dispatchAlert(repo: Repo, orgId: string, ev: Event, channelIds: string[] = [], entitlements: Entitlements = unmetered) {
  const channels = await repo.channelsToAlert(orgId, { channelIds, projectId: ev.monitor.projectId, withDisabled: true });
  await fanOut(repo, orgId, ev, channels, entitlements);
  const base = { organizationId: orgId, projectId: ev.monitor.projectId ?? null, kind: ev.kind, incidentId: ev.incident.id, monitorName: ev.monitor.name };
  const subs = await notifySubscribers(repo, orgId, ev, entitlements).catch((e) => { console.error("subscriber notify failed", e); return null; });
  if (subs && subs.total > 0) {
    const error = subs.failed ? `${subs.failed}/${subs.total} failed: ${subs.error}` : subs.skipped ? `${SKIPPED} (${subs.skipped}/${subs.total} not sent)` : null;
    await repo.logDeliveries([{ ...base, channelId: null, channelName: "Status page subscribers", channelType: "email", ok: !error, error, status: !error ? "sent" : subs.failed ? "failed" : "skipped", statusMessage: error && (subs.failed ? `failed: ${error}` : error) }]);
  }
}

const suppressed = (organizationId: string, ev: Event, why: string): NewDelivery => ({
  organizationId, projectId: ev.monitor.projectId ?? null, kind: ev.kind, incidentId: ev.incident.id, monitorName: ev.monitor.name,
  channelId: null, channelName: "Alerts", channelType: "none", ok: false, status: "skipped", error: why, statusMessage: why,
});

/**
 * Repeat the down alert for incidents nobody has acknowledged. The repo hands each due repeat to exactly one caller and
 * counts it, so a repeat is sent once however many workers run; intervals that were missed collapse into this one.
 */
export async function sendReminders(repo: Repo, entitlements: Entitlements = unmetered, limit = 10) {
  // Monitors under maintenance are not claimed: a suppressed repeat must not use up the incident's repeats, and it goes out
  // after the window if the incident is still unacknowledged.
  const due = await repo.claimReminders(limit, (monitor) => repo.underMaintenance(monitor));
  for (const { incident, monitor, project, number } of due) {
    const ev = eventOf("incident.reminder", incident, monitor, number);
    const all = await repo.channelsToAlert(incident.organizationId, { channelIds: monitor.channelIds, projectId: monitor.projectId, withDisabled: true });
    // push is what repeats are for; email only when the project opted in
    const channels = all.filter((c) => c.type === "push" || (project.reminderEmail && c.type === "email"));
    if (!channels.length) {
      await repo.logDeliveries([suppressed(incident.organizationId, ev, "skipped: no push channel to repeat the alert on")]);
      continue;
    }
    await fanOut(repo, incident.organizationId, ev, channels, entitlements);
  }
  return due.length;
}

/** Tell the next escalation level about an incident that is still unacknowledged. Claimed once, like a reminder. */
export async function sendEscalations(repo: Repo, entitlements: Entitlements = unmetered, limit = 10) {
  const due = await repo.claimEscalations(limit);
  for (const { incident, monitor, step, level } of due) {
    const ev = eventOf("incident.escalated", incident, monitor, level);
    if (await repo.underMaintenance(monitor)) {
      await repo.logDeliveries([suppressed(incident.organizationId, ev, "suppressed: maintenance")]);
      continue;
    }
    const channels = await repo.channelsByIds(incident.organizationId, step.channelIds);
    if (!channels.length) {
      await repo.logDeliveries([suppressed(incident.organizationId, ev, `skipped: escalation level ${level} has no channel left`)]);
      continue;
    }
    await fanOut(repo, incident.organizationId, ev, channels, entitlements);
  }
  return due.length;
}

/** Housekeeping for deliveries: free rows a dead worker left in `sending`, then the retries that are due. */
export async function sweepDeliveries(repo: Repo) {
  return repo.sweepStuckDeliveries({ stuckSec: STUCK_SEC, maxAttempts: MAX_ATTEMPTS });
}

/** Send one alert to one channel; throws when the provider rejects it. */
export async function deliver(c: { type: string; name?: string; config: unknown; organizationId?: string }, ev: Event, text: string, lang: Lang = "en", repo?: Repo, pushed?: PushedDevices) {
  const L = (k: string, v?: Record<string, string>) => tr(lang, k, v);
  // a repeat or an escalation reads like the down alert
  const opened = ev.kind !== "incident.resolved";
  const cfg = c.config as Record<string, string | undefined>;
  const need = (v: unknown, what: string) => { if (!v) throw new Skipped(`skipped: the channel has no ${what}`); };
  switch (c.type) {
    case "slack":
      need(cfg.url, "webhook URL");
      await post(cfg.url!, { text });
      break;
    case "lark":
      need(cfg.url, "webhook URL");
      await postLark(cfg.url!, text, cfg.secret || undefined);
      break;
    case "webhook":
      need(cfg.url, "webhook URL");
      await post(cfg.url!, { kind: ev.kind, ...(ev.count ? { count: ev.count } : {}), incident: ev.incident, monitor: { name: ev.monitor.name, target: ev.monitor.target }, ...(ev.project ? { project: ev.project } : {}), ...(ev.slow ? { slow: true } : {}), ...(ev.reopened ? { reopened: true } : {}) });
      break;
    case "telegram":
      need(cfg.botToken && cfg.chatId, "bot token or chat id");
      await post(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, { chat_id: cfg.chatId, text });
      break;
    case "pagerduty":
      need(cfg.routingKey, "routing key");
      await post("https://events.pagerduty.com/v2/enqueue", {
          routing_key: cfg.routingKey,
          event_action: opened ? "trigger" : "resolve",
          dedup_key: ev.incident.id,
          payload: { summary: text, source: ev.monitor.target || ev.monitor.name, severity: "critical" },
        });
      break;
    case "push": {
      // devices belong to people: every member of the workspace who registered one is reached, each in their own language
      if (!repo || !c.organizationId) throw new Error("Push channel has no workspace to look devices up in");
      const devices = await repo.pushDevicesForOrganization(c.organizationId);
      if (!devices.length) throw new Skipped("skipped: no phone has registered for push alerts");
      // devices another push channel is already handling are claimed by it; they are taken over only if that push fails
      const mine = pushed ? devices.filter((d) => !pushed.has(d.id)) : devices;
      const theirs = pushed ? devices.filter((d) => pushed.has(d.id)).map((d) => ({ d, done: pushed.get(d.id)! })) : [];
      let settle: (ok: boolean) => void = () => {};
      const mineDone = new Promise<boolean>((r) => { settle = r; });
      mine.forEach((d) => pushed?.set(d.id, mineDone));
      try {
        if (mine.length) await sendPush(repo, mine, ev, c.organizationId);
        settle(true);
      } catch (e) {
        mine.forEach((d) => pushed?.delete(d.id));
        settle(false);
        throw e;
      }
      const retake = [];
      for (const { d, done } of theirs) if (!(await done)) retake.push(d);
      if (!mine.length && !retake.length) throw new Skipped("skipped: every phone was already notified through another push channel");
      if (retake.length) await sendPush(repo, retake, ev, c.organizationId);
      break;
    }
    case "email":
      need(cfg.to, "email address");
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
        if (ev.project && ev.multiProject) rows.push([L("Project"), ev.project.name]);
        if (ev.monitor.target) rows.push([L("Target"), ev.monitor.target]);
        if (started) rows.push([L("Started"), utc(started)]);
        if (opened && ev.reason) rows.push([L("Error"), ev.reason]);
        if (!opened && started && ev.incident.resolvedAt) {
          rows.push([L("Downtime"), duration(ev.incident.resolvedAt.getTime() - started.getTime(), lang)]);
          rows.push([L("Resolved"), utc(ev.incident.resolvedAt)]);
        }
        const still = ev.kind === "incident.reminder" || ev.kind === "incident.escalated";
        const heading = still ? (ev.slow ? "{name} is still responding slowly" : "{name} is still down") : opened ? (ev.slow ? "{name} is responding slowly" : "{name} is down") : "{name} has recovered";
        const intro = ev.kind === "incident.reminder"
          ? L("Nobody has acknowledged this incident yet. This is reminder {n} of {max}.", { n: String(ev.count ?? 1), max: String(MAX_REMINDERS) })
          : ev.kind === "incident.escalated"
            ? L("Nobody acknowledged this incident in time, so it was escalated to this channel.")
            : L(opened ? (ev.slow ? "The monitor responded slower than its threshold on several checks in a row, so an incident was opened." : "The monitor failed its consecutive checks, so an incident was opened.") : "Checks are passing again and the incident is resolved.");
        const mail = actionEmail({
          title: L(heading, { name: ev.monitor.name }),
          body: intro,
          badge: opened ? (ev.slow ? { label: L("Slow"), tone: "warn" } : { label: L("Down"), tone: "down" }) : { label: L("Recovered"), tone: "up" },
          rows,
          cta: L("View incident"),
          url: `${appUrl()}/app/incidents/${ev.incident.id}`,
          footer: L("You get this because {name} is an alert channel in your workspace.", { name: c.name ?? L("this email") }),
          footerUrl: { text: L("Manage alerting"), url: `${appUrl()}/app/alerting` },
          lang,
        });
        await sendEmail({ to: cfg.to, subject: `${tag(ev)}${opened ? (ev.slow ? "🟡" : "🔴") : "✅"} ${L(heading, { name: ev.monitor.name })} · OpenUptime`, fromName: "OpenUptime Alerts", ...mail });
      }
      break;
  }
}

/** A page that hides the OpenUptime brand also sends its mail under its own name, when the plan allows it. */
const mayHideBranding = async (entitlements: Entitlements, orgId: string) => (await entitlements.plan(orgId))?.hideBranding !== false;

async function mailSubscribers(
  subs: SubscriberTarget[],
  allowHide: boolean,
  o: { subject: (pageTitle: string, lang: Lang) => string; title: (lang: Lang) => string; body: (lang: Lang) => string; badge: (lang: Lang) => { label: string; tone: "down" | "up" | "warn" | "neutral" } },
) {
  const results = await Promise.allSettled(
    subs.map((s) => {
      const lang: Lang = isLang(s.locale) ? s.locale : "en";
      const white = allowHide && s.hideBranding;
      const mail = actionEmail({
        title: o.title(lang),
        body: `${s.title}\n\n${o.body(lang)}`,
        badge: o.badge(lang),
        cta: tr(lang, "View status page"),
        url: `${appUrl()}/status/${s.slug}`,
        footer: tr(lang, "You receive this because you subscribed to updates from {title}.", { title: s.title }),
        footerUrl: { text: tr(lang, "Unsubscribe"), url: `${appUrl()}/api/public/status/_/unsubscribe?token=${s.token}` },
        lang,
        brand: white ? s.title : undefined,
      });
      // one-click unsubscribe (RFC 8058): mail clients show their own button and POST to this address
      const unsubscribe = `${appUrl()}/api/public/status/_/unsubscribe?token=${s.token}`;
      return sendEmail({ to: s.email, subject: o.subject(s.title, lang), fromName: white ? s.title : `${s.title} via OpenUptime`, headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, ...mail });
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
  const sent = await mailSubscribers(subs, await mayHideBranding(entitlements, orgId), {
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
  inc: { organizationId: string; monitorId: string | null; projectId?: string | null; title: string },
  update: { status: string; body: string },
  entitlements: Entitlements = unmetered,
) {
  const { send: subs } = await withinEmails(entitlements, inc.organizationId, await repo.subscribersFor(inc.organizationId, inc.monitorId, inc.projectId));
  const label = (lang: Lang) => tr(lang, update.status === "resolved" ? "Resolved" : update.status[0].toUpperCase() + update.status.slice(1));
  await mailSubscribers(subs, await mayHideBranding(entitlements, inc.organizationId), {
    subject: (p, lang) => `[${p}] ${label(lang)}: ${inc.title}`,
    title: (lang) => `${label(lang)}: ${inc.title}`,
    body: () => update.body,
    badge: (lang) => ({ label: label(lang), tone: update.status === "resolved" ? "up" : update.status === "investigating" ? "down" : "warn" }),
  }).catch((e) => console.error("incident update notify failed", e));
}

/** How many times a reminder whose every mail failed is handed back before it is given up on. */
const REMINDER_ATTEMPTS = 3;

/**
 * Reminds the confirmed subscribers of a page shortly before one of its maintenance windows starts. Each window is claimed
 * once per page before anything is sent, so overlapping ticks never send twice. The claim stays when the plan's email
 * allowance leaves nobody to mail, and when at least one mail went out. It is given back only when every mail failed, and
 * only for the first few attempts, so a broken mail setup does not retry for ever.
 */
export async function sendMaintenanceReminders(repo: Repo, entitlements: Entitlements = unmetered) {
  for (const r of await repo.claimMaintenanceReminders(20)) {
    const { send: subs } = await withinEmails(entitlements, r.page.organizationId, r.subscribers);
    // the plan allows no more mail: nothing to send and nothing to retry, so the claim stays
    if (!subs.length) continue;
    const sent = await mailSubscribers(subs, await mayHideBranding(entitlements, r.page.organizationId), {
      subject: (p, lang) => `[${p}] ${tr(lang, "Scheduled maintenance: {name}", { name: r.window.name })}`,
      title: (lang) => tr(lang, "Scheduled maintenance: {name}", { name: r.window.name }),
      body: (lang) => `${tr(lang, "Scheduled maintenance for {title} starts soon. Checks keep running, but alerts are paused while it lasts.", { title: r.page.title })}\n\n${tr(lang, "Starts")}: ${utc(r.window.startsAt)}\n${tr(lang, "Ends")}: ${utc(r.window.endsAt)}`,
      badge: (lang) => ({ label: tr(lang, "Scheduled"), tone: "neutral" }),
    }).catch((e) => { console.error("maintenance reminder failed", e); return null; });
    if (sent && sent.failed < sent.total) continue;
    // every mail failed: hand the claim back for another try, up to REMINDER_ATTEMPTS times
    const retry = await repo.withinLimit(`maint-reminder:${r.window.id}:${r.page.id}`, REMINDER_ATTEMPTS, 24 * 3600).catch(() => false);
    if (retry) await repo.releaseMaintenanceReminder(r.window.id, r.page.id).catch((e) => console.error("maintenance reminder release failed", e));
  }
}
