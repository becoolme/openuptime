import { domainName } from "./domain-name";
/**
 * Outbound-request guard. Monitors, status checks and alert webhooks make requests to addresses users type in; on a
 * server that can reach its own network that is a way to probe it (metadata endpoints, databases, admin panels). By
 * default a target must therefore be a public address. Self-hosters who want to monitor internal services opt in with
 * ALLOW_PRIVATE_TARGETS=true.
 *
 * What is checked: literal IPs (including the decimal / hex / short spellings a URL parser normalises), names that can
 * only be internal (`localhost`, `*.internal`, single-label names such as a compose service), and, on Node, every
 * address the name resolves to. Redirects are followed by hand so each hop is checked as well. On Cloudflare Workers
 * the platform itself refuses private ranges, so only the static checks run there.
 */

import { pinnedFetch } from "./pinnedfetch";
import { configureSelfCheck } from "./selfcheck";

let allowPrivate = false;
let userAgent = "OpenUptime/0.1 (+https://github.com/becoolme/openuptime)";

/** Env values are constant per deployment, so a module-level config is safe in a Worker isolate. */
export function configureNetGuard(env: { ALLOW_PRIVATE_TARGETS?: string; CHECK_USER_AGENT?: string; SELFCHECK_URLS?: string }) {
  configureSelfCheck(env.SELFCHECK_URLS);
  allowPrivate = env.ALLOW_PRIVATE_TARGETS === "true";
  userAgent = env.CHECK_USER_AGENT?.trim() || "OpenUptime/0.1 (+https://github.com/becoolme/openuptime)";
}
export const checkUserAgent = () => userAgent;

export class BlockedTarget extends Error {
  constructor() {
    super("Target is a private or internal address. Set ALLOW_PRIVATE_TARGETS=true to monitor internal services.");
    this.name = "BlockedTarget";
  }
}

// ---- addresses -----------------------------------------------------------------------------------------------------

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function v4Bytes(s: string): number[] | null {
  const m = V4.exec(s);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((n) => n <= 255) ? b : null;
}

function v4Blocked([a, b, c]: number[]): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** 16 bytes of an IPv6 literal (no brackets), or null when it is not one. */
function v6Bytes(input: string): number[] | null {
  let s = input.split("%")[0].toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const b = v4Bytes(dotted[1]);
    if (!b) return null;
    s = s.slice(0, -dotted[1].length) + ((b[0] << 8) | b[1]).toString(16) + ":" + ((b[2] << 8) | b[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : head.length !== 8) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
}

function v6Blocked(b: number[]): boolean {
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 15) && (b[15] === 0 || b[15] === 1)) return true; // :: and ::1
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4Blocked(b.slice(12)); // ::ffff:a.b.c.d
  if (zeros(0, 12)) return v4Blocked(b.slice(12)); // IPv4-compatible
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return v4Blocked(b.slice(12)); // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return v4Blocked(b.slice(2, 6)); // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && (b[2] === 0 && b[3] === 0)) return true; // Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
  if (b[0] === 0x01 && b[1] === 0x00 && zeros(2, 8)) return true; // discard-only
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 site local
  return b[0] === 0xff; // multicast
}

/** True for an IP literal (v4 or v6, no brackets) that is not a public address. Anything else is false. */
export function addressBlocked(ip: string): boolean {
  const v4 = v4Bytes(ip);
  if (v4) return v4Blocked(v4);
  if (ip.includes(":")) {
    const v6 = v6Bytes(ip);
    return v6 ? v6Blocked(v6) : true; // an unparseable literal is not worth a request
  }
  return false;
}

const INTERNAL_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".home.arpa", ".lan", ".intranet", ".corp", ".private"];

/** Lower-cased host without brackets or a trailing dot; IPv4 spellings (2130706433, 0x7f.1, 127.1) become dotted. */
function normaliseHost(host: string): string {
  let h = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h.includes(":") && /^[0-9a-fx.]+$/.test(h)) {
    try {
      h = new URL(`http://${h}`).hostname;
    } catch { /* not a number: keep as typed */ }
  }
  return h;
}

/** Static verdict for a host: an IP in a private range, or a name that can only be internal. */
export function hostBlocked(host: string): boolean {
  const h = normaliseHost(host);
  if (!h) return true;
  if (h.includes(":") || V4.test(h)) return addressBlocked(h);
  if (h === "localhost" || INTERNAL_SUFFIXES.some((s) => h.endsWith(s))) return true;
  return !h.includes("."); // single label: a search-domain or compose-network name
}

export const isWorkers = () => (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers";
const isLiteral = (h: string) => h.includes(":") || V4.test(h);

const resolved = new Map<string, { at: number; addrs: string[] }>();
const RESOLVE_TTL_MS = 30_000;

/** Every address `host` resolves to. Throws the resolver's own error: a name that cannot be resolved is not dialled blind. */
async function resolveAll(host: string): Promise<string[]> {
  const hit = resolved.get(host);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.addrs;
  const dns = await import("node:dns/promises");
  const addrs = (await dns.lookup(host, { all: true })).map((r) => r.address);
  if (resolved.size > 500) resolved.clear();
  resolved.set(host, { at: Date.now(), addrs });
  return addrs;
}

/**
 * Refuses a private host (throws BlockedTarget). On Node, returns the addresses the name resolves to, all of them
 * validated, so the connection can be pinned to what was checked. Literals and Workers (where the platform refuses
 * private ranges itself) have nothing to pin: `addresses` is null.
 */
export async function guardAddresses(host: string, publicOnly = false): Promise<{ host: string; addresses: string[] | null }> {
  if (allowPrivate && !publicOnly) return { host, addresses: null };
  const h = normaliseHost(host);
  if (hostBlocked(h)) throw new BlockedTarget();
  if (isLiteral(h) || isWorkers()) return { host: h, addresses: null };
  const addrs = await resolveAll(h);
  if (!addrs.length) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${h}`), { code: "ENOTFOUND" });
  if (addrs.some(addressBlocked)) throw new BlockedTarget();
  return { host: h, addresses: addrs };
}

/** The address to dial for `host`: the first validated one on Node, otherwise the host unchanged. */
export async function guardHost(host: string): Promise<string> {
  return (await guardHosts(host))[0];
}

/** Every validated address of `host` to dial, IPv4 first (the order the resolver gave otherwise); the host itself when there is nothing to pin. */
export async function guardHosts(host: string): Promise<string[]> {
  const g = await guardAddresses(host);
  if (!g.addresses) return [g.host];
  return [...g.addresses.filter((a) => !a.includes(":")), ...g.addresses.filter((a) => a.includes(":"))];
}

/** Forget what `host` resolved to, so the next lookup asks the resolver again. */
export function forgetResolved(host: string) {
  resolved.delete(normaliseHost(host));
}

/** Shortest slice an address gets while time remains: a slow but working address still has room to answer. */
const MIN_SLICE_MS = 3000;

/**
 * Runs `connect` against each validated address of `host` in turn and returns the first success. When every address
 * failed, the cached lookup is dropped and the whole list is tried once more from a fresh lookup (the name may have
 * moved). The error thrown lists every failure (`errors`), so callers can tell a prober-side problem from a target one.
 * `until` (epoch ms) bounds the whole dial: each address gets its own slice of the time that is left (an equal share, at
 * least 3 seconds), so one blackholed address cannot use up the deadline of the others. `connect` receives a signal that
 * aborts when its slice ends; a connection that still succeeds after that is handed to `discard` so it is not leaked.
 */
export async function dialEach<T>(host: string, connect: (address: string, signal: AbortSignal) => Promise<T>, until = Infinity, discard?: (value: T) => void): Promise<T> {
  const failures: unknown[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const addrs = await guardHosts(host);
    for (let i = 0; i < addrs.length; i++) {
      const remaining = until - Date.now();
      if (remaining <= 0) break;
      const slice = Number.isFinite(remaining) ? Math.min(remaining, Math.max(remaining / (addrs.length - i), MIN_SLICE_MS)) : Infinity;
      const ctl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let lost = false;
      const attempt = connect(addrs[i], ctl.signal);
      try {
        if (!Number.isFinite(slice)) return await attempt;
        return await Promise.race([
          attempt,
          new Promise<never>((_, reject) => { timer = setTimeout(() => { lost = true; ctl.abort(); reject(new Error("Connection timed out")); }, slice); }),
        ]);
      } catch (e) {
        failures.push(e);
        if (lost) attempt.then((v) => discard?.(v), () => {});
      } finally {
        clearTimeout(timer);
      }
    }
    // a literal or a Workers host has no lookup to repeat
    if (addrs.length === 1 && normaliseHost(addrs[0]) === normaliseHost(host)) break;
    if (Date.now() >= until) break;
    forgetResolved(host);
  }
  if (failures.length === 1) throw failures[0];
  const last = failures[failures.length - 1] as Error;
  throw Object.assign(new Error(last?.message ?? "Connection failed", { cause: last }), { errors: failures });
}

/**
 * Is the host private as far as the prober can tell: a private literal or internal name, or a name that resolves to a
 * private address (also with ALLOW_PRIVATE_TARGETS, where public names stay usable for the prober's own connectivity
 * check). Such a target says nothing about the prober's internet access. A name that cannot be resolved is not private.
 */
export async function targetIsPrivate(host: string): Promise<boolean> {
  const h = normaliseHost(host);
  if (isLiteral(h)) return addressBlocked(h);
  // with private targets allowed an internal-looking name may still be public: only its addresses decide
  if (!allowPrivate && hostBlocked(h)) return true;
  if (isWorkers()) return allowPrivate ? hostBlocked(h) : false;
  try {
    return (await resolveAll(h)).some(addressBlocked);
  } catch {
    return false;
  }
}

// ---- targets -------------------------------------------------------------------------------------------------------

/** `host`, `host:port`, `[v6]:port` or `scheme://host:port`: the host and port, or null. */
export function hostPort(target: string, defaultPort: number): { hostname: string; port: number } | null {
  const t = target.trim().replace(/^[a-z]+:\/\//i, "");
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(t);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  return port > 0 && port < 65536 ? { hostname: m[1].replace(/^\[|\]$/g, ""), port } : null;
}

/** Why a monitor target is refused, or null. Used when a monitor is created or its target changes. */
export async function targetProblem(type: string, target: string): Promise<string | null> {
  if (type === "domain") { try { domainName(target); return null; } catch (e) { return (e as Error).message; } }
  if (allowPrivate || type === "heartbeat" || type === "dns") return null;
  let host: string | undefined;
  if (type === "http" || type === "websocket") {
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      return null; // reported by the check itself, as before
    }
    if (type === "http" && u.protocol !== "http:" && u.protocol !== "https:") return "Only http:// and https:// URLs can be monitored.";
    if (type === "websocket" && u.protocol !== "ws:" && u.protocol !== "wss:") return "Only ws:// and wss:// URLs can be monitored.";
    host = u.hostname;
  } else {
    host = hostPort(target, 1)?.hostname;
  }
  if (!host) return null;
  try {
    await guardHost(host);
    return null;
  } catch (e) {
    if (e instanceof BlockedTarget) return e.message;
    return null; // a name that does not resolve is reported by the check itself, as before
  }
}

/** Why a webhook-style channel URL is refused, or null. */
export async function urlProblem(url: string): Promise<string | null> {
  return targetProblem("http", url);
}

// ---- fetch ---------------------------------------------------------------------------------------------------------

const MAX_REDIRECTS = 5;
/** Failures of the connect phase: no request left this machine, so repeating it cannot duplicate anything. */
const CONNECT_FAILURES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * Does the failure (or one of the attempts inside an AggregateError, several addresses tried) come from the connect phase?
 * A timeout counts only when it is the connect syscall's own: an ETIMEDOUT while reading means the request may have been sent.
 */
export function connectFailure(e: unknown): boolean {
  const walk = (x: unknown, depth: number): boolean => {
    if (!x || typeof x !== "object" || depth > 3) return false;
    const { code, syscall, cause, errors } = x as { code?: unknown; syscall?: unknown; cause?: unknown; errors?: unknown };
    if (typeof code === "string" && (CONNECT_FAILURES.has(code) || (code === "ETIMEDOUT" && syscall === "connect"))) return true;
    return walk(cause, depth + 1) || (Array.isArray(errors) && errors.some((i) => walk(i, depth + 1)));
  };
  return walk(e, 0);
}
const SENSITIVE = ["authorization", "cookie", "proxy-authorization"];

/**
 * fetch() that checks the host before every hop and follows redirects itself (so a public URL cannot bounce a check to
 * an internal one). Returns the final response and URL; throws BlockedTarget for a refused hop. With `follow: false` the
 * first response is returned as it is, redirect or not, so the caller can judge the redirect itself.
 */
export async function guardedFetch(url: string, init: RequestInit = {}, { follow = true, publicOnly = false }: { follow?: boolean; publicOnly?: boolean } = {}): Promise<{ res: Response; url: string }> {
  let current = url;
  let method = init.method ?? "GET";
  let body = init.body;
  let headers = new Headers(init.headers);
  for (let hop = 0; ; hop++) {
    const u = new URL(current);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Unsupported protocol ${u.protocol}`);
    let { addresses } = await guardAddresses(u.hostname, publicOnly);
    const req = { ...init, method, body, headers, redirect: "manual" as const };
    // the connection goes to the addresses that were just validated, not to whatever the name resolves to next
    let res: Response;
    try {
      res = addresses ? await pinnedFetch(current, req, addresses) : await fetch(current, req);
    } catch (e) {
      // The cached lookup may be stale (the name moved): forget it and try once more on a fresh, re-validated one.
      // (connect-phase errors only: a request that may have reached the server is never sent twice)
      if (!addresses || init.signal?.aborted || !connectFailure(e)) throw e;
      // only worth repeating when the name now points somewhere else
      const before = new Set(addresses);
      forgetResolved(u.hostname);
      const fresh = (await guardAddresses(u.hostname, publicOnly)).addresses;
      if (!fresh || (fresh.length === before.size && fresh.every((a) => before.has(a)))) throw e;
      res = await pinnedFetch(current, req, fresh);
    }
    const location = res.headers.get("location");
    if (!follow || res.status < 300 || res.status >= 400 || !location || [304].includes(res.status)) return { res, url: current };
    await res.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects");
    const next = new URL(location, current);
    if (next.origin !== u.origin) {
      headers = new Headers(headers);
      for (const h of SENSITIVE) headers.delete(h);
    }
    // like browsers: 303, and POST after 301/302, become a bodiless GET; 307 / 308 repeat the request
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = method === "HEAD" ? "HEAD" : "GET";
      body = undefined;
    }
    current = next.toString();
  }
}

/** Reads at most `max` bytes of a body as text and drops the rest, so a huge or endless response cannot be pulled in. */
export async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - size;
    const part = value.byteLength > room ? value.subarray(0, room) : value;
    size += part.byteLength;
    out += decoder.decode(part, { stream: true });
    if (size >= max) { await reader.cancel(); break; }
  }
  return out + decoder.decode();
}
