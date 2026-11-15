import { z } from "zod";
import { isWebhookSecret } from "./webhook-signing";

/**
 * What a generic webhook channel can be told: the method, extra headers, which alerts it receives and the shape of the body.
 * Without any of these it sends the standard JSON payload as a POST, as it always has.
 */

export const WEBHOOK_METHODS = ["POST", "PUT", "PATCH"] as const;
/** The alert kinds a webhook can receive; reminders only go to the mobile app and email. */
export const WEBHOOK_EVENTS = ["incident.opened", "incident.resolved", "incident.escalated"] as const;
export const MAX_WEBHOOK_HEADERS = 10;
export const MAX_TEMPLATE_LENGTH = 8000;

/** Set by the request itself or by signing; a channel cannot override them. */
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "transfer-encoding", "connection", "webhook-id", "webhook-timestamp", "webhook-signature"]);
const HEADER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** Values a template can use as {{name}}. */
export const TEMPLATE_VARS = ["id", "event", "status", "timestamp", "message", "incident.id", "incident.title", "incident.url", "monitor.name", "monitor.target", "project.name", "payload"] as const;
type TemplateVar = (typeof TEMPLATE_VARS)[number];
const PLACEHOLDER = /\{\{\s*([a-z.]+)\s*\}\}/g;

const isJson = (contentType: string) => /[/+]json\b/i.test(contentType.split(";")[0] ?? "");

/** Every value a template can reference, filled for one alert. `payload` is the standard JSON body. */
export type TemplateValues = Record<TemplateVar, string>;

/**
 * The body with each {{name}} replaced. In a JSON body every value but `payload` is escaped as the inside of a JSON
 * string, so `"title": "{{monitor.name}}"` stays valid whatever the name contains; `{{payload}}` is the raw JSON object.
 */
export function renderTemplate(template: string, contentType: string, values: TemplateValues): string {
  const json = isJson(contentType);
  return template.replace(PLACEHOLDER, (_m, name: TemplateVar) => {
    const v = values[name] ?? "";
    return json && name !== "payload" ? JSON.stringify(v).slice(1, -1) : v;
  });
}

const SAMPLE: TemplateValues = {
  id: "00000000-0000-0000-0000-000000000000", event: "incident.opened", status: "down", timestamp: "2026-01-01T00:00:00.000Z",
  message: 'Sample "alert"\nline two', "incident.id": "i", "incident.title": "t", "incident.url": "https://example.com", "monitor.name": "n",
  "monitor.target": "https://example.com", "project.name": "p", payload: '{"kind":"incident.opened"}',
};

/** Why a template cannot be saved: an unknown {{name}}, or a JSON body that would not parse. */
export function templateProblem(template: string, contentType: string): string | null {
  for (const [, name] of template.matchAll(PLACEHOLDER)) if (!(TEMPLATE_VARS as readonly string[]).includes(name!)) return `Unknown placeholder {{${name}}}. Use ${TEMPLATE_VARS.map((v) => `{{${v}}}`).join(", ")}`;
  if (isJson(contentType)) {
    try { JSON.parse(renderTemplate(template, contentType, SAMPLE)); } catch { return "The template must be valid JSON once placeholders are filled in"; }
  }
  return null;
}

const headerValue = z.string().max(1000).regex(/^[\x20-\x7E]*$/, "Use printable ASCII characters only");

/** The settings a webhook channel is saved with; `url` is the shared http(s) URL check. */
export const webhookConfig = (url: z.ZodType<string>) => z.object({
  url,
  secret: z.string().trim().refine(isWebhookSecret, "Use a whsec_ secret of 24 to 64 base64-encoded bytes").optional(),
  method: z.enum(WEBHOOK_METHODS).optional(),
  headers: z.record(z.string(), headerValue).optional()
    .refine((h) => !h || Object.keys(h).length <= MAX_WEBHOOK_HEADERS, `At most ${MAX_WEBHOOK_HEADERS} headers`)
    .refine((h) => !h || Object.keys(h).every((k) => HEADER_NAME.test(k)), "Header names may use letters, digits and - _ . only")
    .refine((h) => !h || new Set(Object.keys(h).map((k) => k.toLowerCase())).size === Object.keys(h).length, "Each header may appear once")
    .refine((h) => !h || Object.keys(h).every((k) => !RESERVED_HEADERS.has(k.toLowerCase())), "Host, Content-Type, Content-Length and the webhook-* headers are set by OpenUptime")
    .transform((h) => (h && Object.keys(h).length ? h : undefined)),
  /** absent: every kind */
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, "Choose at least one event").max(WEBHOOK_EVENTS.length).transform((e) => [...new Set(e)]).optional(),
  /** a custom body; absent sends the standard JSON payload */
  template: z.string().max(MAX_TEMPLATE_LENGTH).transform((t) => t.trim() || undefined).optional(),
  contentType: z.string().trim().max(100).regex(/^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w.+-]+=[\w.+-]+)*$/, "Use a media type such as application/json").optional(),
}).superRefine((v, ctx) => {
  if (v.contentType && !v.template) ctx.addIssue({ code: "custom", path: ["contentType"], message: "A content type is only used with a custom template" });
  if (v.template) {
    const problem = templateProblem(v.template, v.contentType ?? "application/json");
    if (problem) ctx.addIssue({ code: "custom", path: ["template"], message: problem });
  }
});

/** One alert as a webhook sees it. */
export type WebhookAlert = {
  kind: string;
  /** "down", "degraded" (slow or schema drift) or "up" */
  status: "down" | "degraded" | "up";
  /** the same text the chat channels get */
  message: string;
  incident: { id: string; title: string };
  monitor: { name: string; target: string };
  project?: { name: string };
  /** the incident in the app, or "" when there is no address to give */
  url: string;
  /** the standard JSON body */
  payload: Record<string, unknown>;
};

/** Whether the channel takes this kind of alert; a channel without a list takes every kind. */
export function webhookWants(config: Record<string, unknown>, kind: string): boolean {
  const events = config.events;
  return !Array.isArray(events) || !events.length || events.includes(kind);
}

/** The method, content type and body to send for one alert. `id` is the webhook-id, also given in the body. */
export function webhookRequest(config: Record<string, unknown>, alert: WebhookAlert, id: string, now = new Date()) {
  const method = (WEBHOOK_METHODS as readonly string[]).includes(config.method as string) ? (config.method as string) : "POST";
  const payload = { id, ...alert.payload };
  const template = typeof config.template === "string" && config.template ? config.template : null;
  if (!template) return { method, contentType: "application/json", body: JSON.stringify(payload) };
  const contentType = typeof config.contentType === "string" && config.contentType ? config.contentType : "application/json";
  const body = renderTemplate(template, contentType, {
    id, event: alert.kind, status: alert.status, timestamp: now.toISOString(), message: alert.message,
    "incident.id": alert.incident.id, "incident.title": alert.incident.title, "incident.url": alert.url,
    "monitor.name": alert.monitor.name, "monitor.target": alert.monitor.target, "project.name": alert.project?.name ?? "",
    payload: JSON.stringify(payload),
  });
  return { method, contentType, body };
}

/** The channel's own headers, as stored. */
export const webhookExtraHeaders = (config: Record<string, unknown>): Record<string, string> =>
  config.headers && typeof config.headers === "object" && !Array.isArray(config.headers)
    ? Object.fromEntries(Object.entries(config.headers as Record<string, unknown>).filter(([k, v]) => typeof v === "string" && !RESERVED_HEADERS.has(k.toLowerCase())) as [string, string][])
    : {};
