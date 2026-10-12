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

let allowPrivate = false;
let userAgent = "OpenUptime/0.1 (+https://github.com/becoolme/openuptime)";

/** Env values are constant per deployment, so a module-level config is safe in a Worker isolate. */
export function configureNetGuard(env: { ALLOW_PRIVATE_TARGETS?: string; CHECK_USER_AGENT?: string }) {
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

const isWorkers = () => (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers";
const isLiteral = (h: string) => h.includes(":") || V4.test(h);

const resolved = new Map<string, { at: number; addrs: string[] | null }>();
const RESOLVE_TTL_MS = 30_000;

async function resolveAll(host: string): Promise<string[] | null> {
  const hit = resolved.get(host);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.addrs;
  let addrs: string[] | null = null;
  try {
    const dns = await import("node:dns/promises");
    addrs = (await dns.lookup(host, { all: true })).map((r) => r.address);
  } catch { /* unresolvable: the request itself will fail with the real reason */ }
  if (resolved.size > 500) resolved.clear();
  resolved.set(host, { at: Date.now(), addrs });
  return addrs;
}

/**
 * Refuses a private host (throws BlockedTarget). Returns the address to dial: on Node the first resolved address, so
 * the connection goes where the check looked; otherwise the host unchanged.
 */
export async function guardHost(host: string): Promise<string> {
  if (allowPrivate) return host;
  const h = normaliseHost(host);
  if (hostBlocked(h)) throw new BlockedTarget();
  if (isLiteral(h) || isWorkers()) return h;
  const addrs = await resolveAll(h);
  if (!addrs?.length) return h;
  if (addrs.some(addressBlocked)) throw new BlockedTarget();
  return addrs[0];
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
  if (allowPrivate || type === "heartbeat" || type === "dns") return null;
  let host: string | undefined;
  if (type === "http") {
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      return null; // reported by the check itself, as before
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "Only http:// and https:// URLs can be monitored.";
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
    throw e;
  }
}

/** Why a webhook-style channel URL is refused, or null. */
export async function urlProblem(url: string): Promise<string | null> {
  return targetProblem("http", url);
}

// ---- fetch ---------------------------------------------------------------------------------------------------------

const MAX_REDIRECTS = 5;
const SENSITIVE = ["authorization", "cookie", "proxy-authorization"];

/**
 * fetch() that checks the host before every hop and follows redirects itself (so a public URL cannot bounce a check to
 * an internal one). Returns the final response and URL; throws BlockedTarget for a refused hop.
 */
export async function guardedFetch(url: string, init: RequestInit = {}): Promise<{ res: Response; url: string }> {
  let current = url;
  let method = init.method ?? "GET";
  let body = init.body;
  let headers = new Headers(init.headers);
  for (let hop = 0; ; hop++) {
    const u = new URL(current);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Unsupported protocol ${u.protocol}`);
    await guardHost(u.hostname);
    const res = await fetch(current, { ...init, method, body, headers, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location || [304].includes(res.status)) return { res, url: current };
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
