import type { Bindings } from "./env";
import { tr, type Lang } from "./mail-i18n";

type EmailBinding = NonNullable<Bindings["EMAIL"]>;

let cfg: { binding?: EmailBinding; from?: string; appUrl: string } = { appUrl: "" };

/** Whether outgoing mail is wired up here; without it messages only reach the server log. */
export const emailEnabled = () => !!cfg.from && !!(transport || cfg.binding);

/** Public origin of the web app, for links in emails. */
export const appUrl = () => cfg.appUrl;

type Transport = (msg: { from: string; fromName: string; to: string; subject: string; html: string; text: string; headers?: Record<string, string> }) => Promise<unknown>;
let transport: Transport | undefined;
/** Node deployments (Docker) plug an SMTP sender in here; Workers use the EMAIL binding. */
export const setMailTransport = (t: Transport | undefined) => { transport = t; };

/** Env values are constant per deployment, so a module-level config is safe in a Worker isolate. */
export function configureEmail(env: Bindings) {
  cfg = { binding: env.EMAIL, from: env.EMAIL_FROM, appUrl: env.WEB_ORIGIN };
}

/**
 * Sends through the Cloudflare Email Service `send_email` binding. Without the binding or
 * EMAIL_FROM (local dev) the message is logged instead.
 */
export async function sendEmail(msg: { to: string; subject: string; html: string; text: string; fromName?: string; headers?: Record<string, string> }) {
  if (transport && cfg.from) {
    await transport({ from: cfg.from, fromName: msg.fromName ?? "OpenUptime", to: msg.to, subject: msg.subject, html: msg.html, text: msg.text, headers: msg.headers });
    return;
  }
  if (!cfg.binding || !cfg.from) {
    console.log(`[email → ${msg.to}] ${msg.subject}\n${msg.text}`);
    return;
  }
  // the display name is what inboxes show instead of the bare "alerts" local part
  const base = { from: { email: cfg.from, name: msg.fromName ?? "OpenUptime" }, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text };
  if (!msg.headers) {
    await cfg.binding.send(base);
    return;
  }
  // Extra headers (List-Unsubscribe) are not guaranteed to be accepted by every version of the binding. If it says it
  // refused the headers, send the mail without them: a mail without the one-click link beats no mail at all. Any other
  // error is not retried, since the first attempt may have gone out and a second one would deliver the mail twice.
  try {
    await cfg.binding.send({ ...base, headers: msg.headers });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (!/\bheaders?\b/i.test(why)) throw e;
    console.warn("email binding refused custom headers, sending without them", why);
    await cfg.binding.send(base);
  }
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

type Tone = "down" | "up" | "warn" | "neutral";
const TONE: Record<Tone, [string, string]> = {
  down: ["#d93a3a", "rgba(217,58,58,.10)"],
  up: ["#0f9d58", "rgba(15,157,88,.10)"],
  warn: ["#c98a0a", "rgba(201,138,10,.12)"],
  neutral: ["#5a635d", "rgba(14,20,17,.07)"],
};
const INK = "#0e1411";
const MUTED = "#5a635d";
const FAINT = "#8b938d";
const LINE = "#e7e7df";

export type MailOpts = {
  title: string;
  /** Plain paragraph under the title; blank lines split paragraphs. */
  body: string;
  cta: string;
  url: string;
  /** Small status pill above the title. */
  badge?: { label: string; tone: Tone };
  /** Label / value pairs rendered as a detail table. */
  rows?: [string, string][];
  /** Timeline entries (newest first), used by incident updates. */
  timeline?: { label: string; time: string; body: string; tone: Tone }[];
  /** Line(s) under the card, e.g. why the recipient got this and an unsubscribe link. */
  footer?: string;
  footerUrl?: { text: string; url: string };
  /** Only used for the default footer; the caller translates everything else. */
  lang?: Lang;
  /** A white-labelled sender: this name replaces OpenUptime's mark and name in the header. */
  brand?: string;
};

/** Branded transactional layout: header, optional status pill and detail table, one button. */
export function actionEmail(o: MailOpts) {
  const pill = o.badge
    ? `<p style="margin:0 0 14px"><span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${TONE[o.badge.tone][1]};color:${TONE[o.badge.tone][0]};font-size:12px;font-weight:600;letter-spacing:.02em;text-transform:uppercase">${escape(o.badge.label)}</span></p>`
    : "";
  const paras = o.body
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${MUTED}">${escape(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const rows = o.rows?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 24px;border-bottom:1px solid ${LINE};font-size:14px">${o.rows
        .map(([k, v]) => `<tr><td style="padding:10px 16px 10px 0;border-top:1px solid ${LINE};color:${FAINT};width:110px;vertical-align:top">${escape(k)}</td><td style="padding:10px 0;border-top:1px solid ${LINE};color:${INK};word-break:break-word">${escape(v)}</td></tr>`)
        .join("")}</table>`
    : "";
  const timeline = o.timeline?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 8px">${o.timeline
        .map((e) => `<tr><td style="width:18px;vertical-align:top;padding-top:6px"><span style="display:block;width:10px;height:10px;border-radius:50%;background:${TONE[e.tone][0]}"></span></td><td style="padding:0 0 18px"><div style="font-size:14px;color:${INK}"><b style="font-weight:600">${escape(e.label)}</b> <span style="color:${FAINT}">· ${escape(e.time)}</span></div><div style="font-size:14.5px;line-height:1.55;color:${MUTED};margin-top:2px">${escape(e.body)}</div></td></tr>`)
        .join("")}</table>`
    : "";
  const foot = [o.footer && escape(o.footer), o.footerUrl && `<a href="${escape(o.footerUrl.url)}" style="color:${MUTED}">${escape(o.footerUrl.text)}</a>`].filter(Boolean).join(" ");
  const html = `<!doctype html><html lang="${o.lang ?? "en"}"><body style="margin:0;padding:24px 12px;background:#f4f4ee;font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',Helvetica,Arial,sans-serif;color:${INK}">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid ${LINE};border-radius:14px;overflow:hidden">
<div style="padding:20px 32px;border-bottom:1px solid ${LINE};font-size:16px;font-weight:600">${o.brand ? `<span>${escape(o.brand)}</span>` : `<img src="${escape(appUrl())}/logo-mark.png" width="26" height="26" alt="" style="display:inline-block;border-radius:8px;margin-right:8px;vertical-align:middle"><span style="vertical-align:middle">OpenUptime</span>`}</div>
<div style="padding:30px 32px 32px">${pill}<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:600;color:${INK}">${escape(o.title)}</h1>${paras}${rows}${timeline}
<p style="margin:${rows || timeline ? "0" : "8px"} 0 0"><a href="${escape(o.url)}" style="display:inline-block;background:${INK};color:#ffffff;padding:12px 18px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:600">${escape(o.cta)}</a></p>
<p style="margin:20px 0 0;color:${FAINT};font-size:12px;line-height:1.5;word-break:break-all">${escape(o.url)}</p></div>
<div style="padding:16px 32px;background:#fafaf7;border-top:1px solid ${LINE};font-size:12.5px;line-height:1.6;color:${FAINT}">${foot || escape(tr(o.lang ?? "en", "Sent by OpenUptime, open-source uptime monitoring."))}</div>
</div></body></html>`;
  const text = [
    o.title,
    "",
    o.body,
    ...(o.rows?.length ? ["", ...o.rows.map(([k, v]) => `${k}: ${v}`)] : []),
    ...(o.timeline?.length ? ["", ...o.timeline.map((e) => `${e.label} (${e.time}): ${e.body}`)] : []),
    "",
    `${o.cta}: ${o.url}`,
    ...(o.footer || o.footerUrl ? ["", [o.footer, o.footerUrl && `${o.footerUrl.text}: ${o.footerUrl.url}`].filter(Boolean).join(" ")] : []),
  ].join("\n");
  return { html, text };
}
