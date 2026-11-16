import type { CheckDiagnosis } from "@openuptime/repo";

/**
 * What a failed check keeps for its incident, and what it removes first. Everything here ends up in front of people
 * (the incident page, and every member of the workspace), so the rule is to keep too little rather than too much: request
 * credentials, cookies and anything shaped like a secret never survive.
 */

/** How much of a failing response body is read, and how much of it is kept. */
export const DIAG_READ_BYTES = 4096;
const BODY_CHARS = 1000;
const HEADER_CHARS = 200;
const MAX_HOPS = 12;

/** Response headers worth seeing when something fails: who answered, what kind of answer, and the cache and CDN path. */
const KEPT_HEADERS = ["server", "content-type", "content-length", "location", "cache-control", "age", "via", "x-cache", "cf-ray", "cf-cache-status", "x-served-by", "x-vercel-id", "x-vercel-cache", "retry-after", "www-authenticate"];

/** Names whose values are secrets, in a form, JSON or a header-like line ("author" and "passed" are not). */
const SECRET_NAME = /(passw(or)?d|passphrase|^pass$|^pwd$|secret|token|api[-_]?key|apikey|auth(?!or)|session|cookie|credential|signature|access[-_]?key|private[-_]?key|jwt|bearer)/i;
/** In a query string also the short names that carry one-time codes and signatures (OAuth, signed URLs). */
const SECRET_PARAM = /^(code|state|sig|sid|key|ticket|nonce|hash|otp|x-amz-[a-z-]+)$/i;
const secretParam = (k: string) => SECRET_NAME.test(k) || SECRET_PARAM.test(k);
const R = "[redacted]";

/** The kind of failure behind a thrown error, from its name, its cause's code and its message. */
export function classifyError(e: unknown): CheckDiagnosis["kind"] {
  if (!(e instanceof Error)) return "other";
  if (e.name === "TimeoutError" || e.name === "AbortError") return "timeout";
  if (e.name === "BlockedTarget") return "blocked";
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  const text = `${cause?.code ?? ""} ${cause?.message ?? ""} ${(e as { code?: string }).code ?? ""} ${e.message}`;
  if (/ENOTFOUND|EAI_AGAIN|ENODATA|ESERVFAIL|could not resolve|resolve|dns|no such host|name not resolved/i.test(text)) return "dns";
  if (/CERT|TLS|SSL|certificate|self[- ]signed|handshake|ERR_SSL|UNABLE_TO_VERIFY|DEPTH_ZERO|HOSTNAME_MISMATCH|ERR_TLS/i.test(text)) return "tls";
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|timed out|timeout/i.test(text)) return "timeout";
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ECONNABORTED|UND_ERR_SOCKET|socket|connect|connection|network/i.test(text)) return "connect";
  return "other";
}

/** The values the monitor itself sends that must never come back in a diagnosis: its header values and URL credentials. */
export function secretsOf(target: string, headers: Record<string, string> | undefined): string[] {
  const out: string[] = [];
  for (const v of Object.values(headers ?? {})) {
    if (!v) continue;
    out.push(v);
    // "Bearer abc" -> also "abc", which may be echoed back alone
    const parts = v.split(/\s+/);
    if (parts.length > 1) out.push(parts.slice(1).join(" "));
    // a Cookie header: each value on its own
    for (const c of v.split(";")) { const val = c.split("=").slice(1).join("=").trim(); if (val) out.push(val); }
  }
  try {
    const u = new URL(target);
    if (u.password) out.push(decodeURIComponent(u.password), u.password);
    if (u.username) out.push(decodeURIComponent(u.username), u.username);
    for (const [k, v] of u.searchParams) if (v && secretParam(k)) out.push(v);
  } catch { /* not a URL */ }
  // short values would remove ordinary words; a 3-character secret is not worth guarding that way
  return [...new Set(out.map((s) => s.trim()).filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Removes the given values and everything that looks like a credential from free text. */
export function redactText(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) out = out.replace(new RegExp(escapeRe(s), "g"), R);
  out = out
    // JSON Web Tokens
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, R)
    // Authorization schemes
    .replace(/\b(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{4,}/gi, `$1 ${R}`)
    // "secret": "value" in JSON
    .replace(/("([^"\\]{0,60})"\s*:\s*)"(?:[^"\\]|\\.)*"/g, (all, head: string, key: string) => (SECRET_NAME.test(key) ? `${head}"${R}"` : all))
    // secret=value / secret: value in forms, query strings and header-like lines
    .replace(/\b([A-Za-z0-9_.-]{0,40})(\s*[=:]\s*)([^\s&;,"'<>]{1,})/g, (all, key: string, sep: string) => (SECRET_NAME.test(key) ? `${key}${sep}${R}` : all))
    // email addresses
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    // long opaque strings: keys, hashes and tokens without a name
    .replace(/[A-Za-z0-9_+/=-]{40,}/g, R);
  return out;
}

/** HTML reduced to its visible text: an error page says more as words than as markup. */
export function htmlText(body: string): string {
  if (!/<(html|body|head|div|p|h1|title|!doctype)\b/i.test(body)) return body;
  return body
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The start of a response body, as plain text, with credentials removed and the length capped. */
export function bodyExcerpt(body: string, secrets: string[] = []): string | undefined {
  // cut first, so the secret patterns never work on an unbounded string
  const text = htmlText(body.slice(0, DIAG_READ_BYTES * 2)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!text) return undefined;
  const clean = redactText(text, secrets);
  return clean.length > BODY_CHARS ? `${clean.slice(0, BODY_CHARS)}…` : clean;
}

/** A URL safe to show: no user or password, and query values that may be secrets replaced. */
export function safeUrl(url: string, secrets: string[] = []): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    const q = new URLSearchParams();
    for (const [k, v] of u.searchParams) q.append(k, secretParam(k) || v.length >= 20 || secrets.includes(v) ? R : v);
    u.search = q.toString() ? `?${q.toString().replaceAll(encodeURIComponent(R), R)}` : "";
    u.hash = "";
    return u.toString();
  } catch {
    return redactText(url.slice(0, 500), secrets);
  }
}

/** The allowlisted response headers, with values capped and credentials removed. Set-Cookie is never kept. */
export function keptHeaders(h: Headers, base: string, secrets: string[] = []): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    let v = h.get(name);
    if (v == null || v === "") continue;
    if (name === "location") {
      try { v = safeUrl(new URL(v, base).href, secrets); } catch { v = R; }
    } else if (name === "www-authenticate") {
      // the scheme says what kind of login is wanted; realms and nonces are left out
      v = v.split(/[\s,]/)[0];
    } else v = redactText(v, secrets);
    out[name] = v.length > HEADER_CHARS ? `${v.slice(0, HEADER_CHARS)}…` : v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The hops a fetch went through, safe to show. */
export function safeHops(hops: { url: string; status: number; location: string | null; ms: number }[], secrets: string[] = []): CheckDiagnosis["redirects"] {
  if (hops.length < 2 && !hops[0]?.location) return undefined;
  return hops.slice(0, MAX_HOPS).map((h) => {
    let location: string | null = null;
    if (h.location) { try { location = safeUrl(new URL(h.location, h.url).href, secrets); } catch { location = R; } }
    return { url: safeUrl(h.url, secrets), status: h.status, location, ms: h.ms };
  });
}

const KINDS = new Set<CheckDiagnosis["kind"]>(["dns", "connect", "tls", "timeout", "http", "assertion", "blocked", "other"]);

/**
 * A diagnosis that came from somewhere else (a regional probe), reduced to the expected shape and sizes. Anything that does
 * not fit is dropped rather than trusted.
 */
export function sanitizeDiagnosis(v: unknown): CheckDiagnosis | undefined {
  if (!v || typeof v !== "object") return undefined;
  const d = v as Record<string, unknown>;
  if (typeof d.kind !== "string" || !KINDS.has(d.kind as CheckDiagnosis["kind"])) return undefined;
  const out: CheckDiagnosis = { kind: d.kind as CheckDiagnosis["kind"] };
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.round(x) : undefined);
  const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : undefined);
  if (d.timings && typeof d.timings === "object") {
    const t = d.timings as Record<string, unknown>;
    const totalMs = num(t.totalMs);
    if (totalMs != null) out.timings = { totalMs, ...(num(t.firstByteMs) != null ? { firstByteMs: num(t.firstByteMs) } : {}) };
  }
  if (Array.isArray(d.redirects)) {
    const hops = d.redirects.slice(0, MAX_HOPS).flatMap((h) => {
      if (!h || typeof h !== "object") return [];
      const x = h as Record<string, unknown>;
      const url = str(x.url, 500);
      const status = num(x.status);
      if (!url || status == null) return [];
      return [{ url: safeUrl(url), status, location: typeof x.location === "string" ? safeUrl(x.location.slice(0, 500)) : null, ms: num(x.ms) ?? 0 }];
    });
    if (hops.length) out.redirects = hops;
  }
  if (d.headers && typeof d.headers === "object") {
    const h = new Headers();
    for (const [k, val] of Object.entries(d.headers as Record<string, unknown>).slice(0, 30)) if (typeof val === "string") { try { h.set(k, val.slice(0, 500)); } catch { /* not a header */ } }
    const kept = keptHeaders(h, "https://invalid.example/");
    if (kept) out.headers = kept;
  }
  const body = str(d.body, BODY_CHARS * 2);
  if (body) out.body = bodyExcerpt(body);
  const steps = sanitizeSteps(d.steps);
  if (steps) out.steps = steps;
  return out;
}

/** The per-request lines of a multi-step check from somewhere else, cut to the expected shape. */
export function sanitizeSteps(v: unknown): CheckDiagnosis["steps"] {
  if (!Array.isArray(v)) return undefined;
  const out = v.slice(0, 6).flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const s = x as Record<string, unknown>;
    if (typeof s.name !== "string" || typeof s.ok !== "boolean") return [];
    const ms = typeof s.ms === "number" && Number.isFinite(s.ms) && s.ms >= 0 ? Math.round(s.ms) : 0;
    return [{
      name: s.name.slice(0, 60), ok: s.ok, ms,
      ...(typeof s.statusCode === "number" && Number.isInteger(s.statusCode) ? { statusCode: s.statusCode } : {}),
      ...(typeof s.error === "string" ? { error: redactText(s.error.slice(0, 300)) } : {}),
    }];
  });
  return out.length ? out : undefined;
}
