/**
 * Converters from other monitoring tools' export files to our import records. Each converter keeps the source's own
 * monitor id (so a second import of the same file is recognised) and either returns a record, with warnings for
 * whatever did not carry over, or a reason the monitor has to be set up by hand. Nothing here guesses: a setting
 * without an equivalent is reported, never dropped silently.
 *
 * Supported files:
 * - UptimeRobot: the JSON answer of the v2 API `getMonitors` (numeric types 1 to 5).
 * - Uptime Kuma: the backup file of version 1.x (Settings, Backup, Export), whose monitors are under `monitorList`.
 */

import { parseStatusSpec } from "./status-spec";

export const IMPORT_FORMATS = ["json", "uptimerobot", "uptime-kuma"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

type Rec = Record<string, unknown>;
export type Converted = { name: string | null; record?: Rec; warnings: string[]; error?: string };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const filled = (v: unknown) => v !== undefined && v !== null && v !== "" && v !== 0 && v !== false && !(Array.isArray(v) && !v.length) && !(isRec(v) && !Object.keys(v).length);

function basic(user: string, pass: string) {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `Basic ${btoa(s)}`;
}

/** Which tool produced this file, from its shape. */
export function detectFormat(envelope: Rec, list: unknown[]): ImportFormat {
  if (Array.isArray(envelope.monitorList) && !Array.isArray(envelope.monitors)) return "uptime-kuma";
  if (list.some((m) => isRec(m) && typeof m.type === "number" && "friendly_name" in m)) return "uptimerobot";
  // the monitorList alone, without the backup around it
  // accepted_statuscodes alone is not enough: generic JSON lists may use that field name too
  if (list.some((m) => isRec(m) && ("maxretries" in m || "notificationIDList" in m))) return "uptime-kuma";
  return "json";
}

/** The monitors of a file in any supported shape: a bare list, our export, an UptimeRobot answer or a Kuma backup. */
export function monitorsOf(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw;
  if (!isRec(raw)) return undefined;
  return raw.monitors ?? raw.monitorList;
}

export function convertRecord(format: ImportFormat, raw: unknown): Converted {
  if (!isRec(raw)) return { name: null, warnings: [], error: "item: expected an object" };
  return format === "uptimerobot" ? fromUptimeRobot(raw) : format === "uptime-kuma" ? fromKuma(raw) : { name: null, record: raw, warnings: [] };
}

// --- UptimeRobot -------------------------------------------------------------------------------------------------

const UR_METHODS: Record<number, string> = { 1: "HEAD", 2: "GET", 3: "POST", 4: "PUT", 5: "PATCH", 6: "DELETE", 7: "OPTIONS" };
const UR_PORTS: Record<number, number> = { 1: 80, 2: 443, 3: 21, 4: 25, 5: 110, 6: 143 };

function fromUptimeRobot(m: Rec): Converted {
  const name = str(m.friendly_name) || null;
  const warnings: string[] = [];
  const fail = (error: string): Converted => ({ name, warnings, error });
  const out: Rec = { name: (name || str(m.url)).slice(0, 120), sourceId: m.id };
  const type = num(m.type);
  const interval = num(m.interval);
  if (interval !== null) out.intervalSec = clamp(interval, 30, 86400);
  const timeout = num(m.timeout);
  if (timeout !== null && timeout > 0) out.timeoutMs = clamp(timeout * 1000, 1000, 30000);

  if (type === 1 || type === 2) {
    out.type = "http";
    out.target = str(m.url);
    if (!/^https?:\/\//i.test(out.target as string)) return fail("UptimeRobot HTTP monitor has no http(s) URL");
    const method = UR_METHODS[num(m.http_method) ?? 2];
    if (method) out.method = method;
    if (type === 2) {
      if (!str(m.keyword_value)) return fail("UptimeRobot keyword monitor has no keyword");
      out.keyword = String(m.keyword_value);
      // UptimeRobot names the condition that alerts: "exists" (1) is healthy when the text is absent
      out.keywordMode = num(m.keyword_type) === 1 ? "absent" : "contains";
      if (num(m.keyword_case_type) !== 1) warnings.push("UptimeRobot matched the keyword ignoring case; OpenUptime matches it exactly, so check the spelling");
    }
    const user = str(m.http_username), pass = str(m.http_password);
    const headers: Rec = isRec(m.custom_http_headers) ? { ...m.custom_http_headers } : {};
    if (user || pass) {
      if (num(m.http_auth_type) === 2) return fail("UptimeRobot digest authentication has no equivalent; create this monitor by hand");
      headers.Authorization = basic(user, pass);
      warnings.push("Basic authentication carried over as an Authorization header");
    }
    if (Object.keys(headers).length) out.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)]));
    if (filled(m.post_value)) {
      out.requestBody = typeof m.post_value === "string" ? m.post_value : JSON.stringify(m.post_value);
      warnings.push("Request body carried over; check its Content-Type header");
    }
    const statuses = str(m.custom_http_statuses);
    if (statuses) {
      // "404:1_200:0": status:1 counts as up, status:0 as down
      // UptimeRobot changes single codes on top of its defaults; only the changes outside 2xx need saying here
      const pairs = statuses.split("_").map((s) => s.split(":"));
      const up = pairs.filter(([c, v]) => v === "1" && !/^2\d\d$/.test(c)).map(([c]) => c);
      const down = pairs.filter(([c, v]) => v === "0" && /^2\d\d$/.test(c)).map(([c]) => `!${c}`);
      const spec = up.length || down.length ? parseStatusSpec(["2xx", ...up, ...down].join(",")) : null;
      if (spec && "error" in spec) warnings.push("Custom HTTP statuses were not carried over; the monitor expects 2xx");
      else if (spec) out.acceptedStatuses = spec.normalized;
    }
    if (num(m.ignore_ssl_errors) === 1) warnings.push("UptimeRobot ignored certificate errors; OpenUptime reports them as failures");
  } else if (type === 4) {
    const host = str(m.url).replace(/^[a-z]+:\/\//i, "").replace(/[/:].*$/, "");
    const port = UR_PORTS[num(m.sub_type) ?? 0] ?? num(m.port);
    if (!host || !port) return fail("UptimeRobot port monitor has no host or port");
    Object.assign(out, { type: "tcp", target: `${host}:${port}` });
  } else if (type === 5) {
    Object.assign(out, { type: "heartbeat", target: "" });
    if (interval !== null) out.intervalSec = clamp(interval, 60, 86400);
    warnings.push("Send pings to the new heartbeat URL shown after import; the UptimeRobot URL keeps going to UptimeRobot");
  } else if (type === 3) {
    return fail("ICMP ping monitors are not imported; add a TCP check on a port the host answers on");
  } else {
    return fail(`UptimeRobot monitor type ${str(m.type) || "unknown"} is not supported`);
  }

  if (num(m.status) === 0) warnings.push("Paused in UptimeRobot; it starts checking here once imported");
  if (filled(m.alert_contacts)) warnings.push("Alert contacts are not imported; this project's auto-enabled channels apply");
  if (filled(m.mwindows)) warnings.push("Maintenance windows are not imported");
  return { name, record: out, warnings };
}

// --- Uptime Kuma -------------------------------------------------------------------------------------------------

const KUMA_DNS = ["A", "AAAA", "CNAME", "MX", "TXT", "NS"];
const KUMA_UNSUPPORTED: Record<string, string> = {
  ping: "ICMP ping monitors are not imported; add a TCP check on a port the host answers on",
  docker: "Docker container monitors need access to the Docker host; they are not imported",
  group: "Groups are not monitors; their members are imported on their own",
  "real-browser": "Browser monitors are not imported",
  postgres: "Database monitors carry their credentials in the connection string; create this monitor by hand",
  mysql: "Database monitors carry their credentials in the connection string; create this monitor by hand",
  sqlserver: "Database monitors carry their credentials in the connection string; create this monitor by hand",
  mongodb: "Database monitors carry their credentials in the connection string; create this monitor by hand",
  redis: "Database monitors carry their credentials in the connection string; create this monitor by hand",
};

/** A Kuma JSON query that is a plain property path (`data.status`, `items[0].id`) becomes a path assertion. */
const SIMPLE_PATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*|\[\d{1,6}\])*$/;

function fromKuma(m: Rec): Converted {
  const name = str(m.name) || null;
  const warnings: string[] = [];
  const fail = (error: string): Converted => ({ name, warnings, error });
  const kind = str(m.type).toLowerCase();
  if (KUMA_UNSUPPORTED[kind]) return fail(KUMA_UNSUPPORTED[kind]);
  if (m.upsideDown === true || m.upsideDown === 1) return fail("Upside down mode has no equivalent; create this monitor by hand");
  const out: Rec = { name: (name || str(m.url) || str(m.hostname)).slice(0, 120), sourceId: m.id };
  const interval = num(m.interval);
  if (interval !== null) out.intervalSec = clamp(interval, 30, 86400);
  const retries = num(m.maxretries);
  if (retries !== null) out.failureThreshold = clamp(retries + 1, 1, 10);
  const timeout = num(m.timeout);
  if (timeout !== null && timeout > 0) out.timeoutMs = clamp(timeout * 1000, 1000, 30000);

  if (kind === "http" || kind === "keyword" || kind === "json-query") {
    out.type = "http";
    out.target = str(m.url);
    if (!/^https?:\/\//i.test(out.target as string)) return fail("Uptime Kuma HTTP monitor has no http(s) URL");
    if (str(m.method)) out.method = str(m.method).toUpperCase();
    let headers: Rec = {};
    if (str(m.headers)) {
      try { const h = JSON.parse(String(m.headers)); if (isRec(h)) headers = h; else throw new Error(); } catch { return fail("Uptime Kuma headers are not a JSON object; fix them before importing"); }
    } else if (isRec(m.headers)) headers = { ...m.headers };
    const auth = str(m.authMethod).toLowerCase();
    if (auth && auth !== "null" && auth !== "basic") return fail(`Uptime Kuma ${auth} authentication has no equivalent; create this monitor by hand`);
    if (str(m.basic_auth_user) || str(m.basic_auth_pass)) {
      headers.Authorization = basic(str(m.basic_auth_user), str(m.basic_auth_pass));
      warnings.push("Basic authentication carried over as an Authorization header");
    }
    if (Object.keys(headers).length) out.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)]));
    if (str(m.body)) { out.requestBody = String(m.body); warnings.push("Request body carried over; check its Content-Type header"); }
    const codes = Array.isArray(m.accepted_statuscodes) ? m.accepted_statuscodes.map(str) : [];
    if (codes.length === 1 && /^\d{3}$/.test(codes[0])) out.expectedStatus = Number(codes[0]);
    else if (codes.length && !(codes.length === 1 && codes[0] === "200-299")) {
      const spec = parseStatusSpec(codes.join(","));
      if ("error" in spec) warnings.push("Accepted status codes other than 2xx were not carried over; the monitor expects 2xx");
      else out.acceptedStatuses = spec.normalized;
    }
    if (kind === "keyword") {
      if (!str(m.keyword)) return fail("Uptime Kuma keyword monitor has no keyword");
      out.keyword = String(m.keyword);
      out.keywordMode = m.invertKeyword === true || m.invertKeyword === 1 ? "absent" : "contains";
    }
    if (kind === "json-query") {
      const path = str(m.jsonPath);
      if (!SIMPLE_PATH.test(path)) return fail("This JSON query cannot be converted; add a JSON check on the monitor by hand");
      out.jsonAssertions = [{ path: `$.${path}`, op: "equals", value: str(m.expectedValue) }];
    }
    if (m.ignoreTls === true || m.ignoreTls === 1) warnings.push("Uptime Kuma ignored certificate errors; OpenUptime reports them as failures");
    if (m.expiryNotification === true || m.expiryNotification === 1) warnings.push("Certificate expiry alerts are not imported");
    if (num(m.proxyId)) warnings.push("The proxy is not imported; the check connects directly");
  } else if (kind === "port") {
    const host = str(m.hostname), port = num(m.port);
    if (!host || !port) return fail("Uptime Kuma port monitor has no host or port");
    Object.assign(out, { type: "tcp", target: host.includes(":") ? `[${host}]:${port}` : `${host}:${port}` });
  } else if (kind === "dns") {
    const record = str(m.dns_resolve_type).toUpperCase() || "A";
    if (!KUMA_DNS.includes(record)) return fail(`DNS record type ${record} is not supported`);
    Object.assign(out, { type: "dns", target: str(m.hostname), dnsRecordType: record });
    if (str(m.dns_resolve_server)) warnings.push("The DNS resolver is not imported; OpenUptime asks Cloudflare's public resolver");
  } else if (kind === "push") {
    Object.assign(out, { type: "heartbeat", target: "" });
    if (interval !== null) out.intervalSec = clamp(interval, 60, 86400);
    warnings.push("Send pings to the new heartbeat URL shown after import; the Uptime Kuma push URL keeps going to Uptime Kuma");
  } else {
    return fail(`Uptime Kuma monitor type ${kind || "unknown"} is not supported`);
  }

  const tags = Array.isArray(m.tags) ? m.tags.map((t) => (isRec(t) ? [str(t.name), str(t.value)].filter(Boolean).join(":") : str(t))).filter(Boolean).map((t) => t.slice(0, 32)) : [];
  if (tags.length) out.tags = [...new Set(tags)].slice(0, 20);
  if (m.active === false || m.active === 0) warnings.push("Paused in Uptime Kuma; it starts checking here once imported");
  if (isRec(m.notificationIDList) ? Object.values(m.notificationIDList).some(Boolean) : filled(m.notificationIDList)) warnings.push("Notifications are not imported; this project's auto-enabled channels apply");
  if (num(m.parent)) warnings.push("Group membership is not imported");
  return { name, record: out, warnings };
}
