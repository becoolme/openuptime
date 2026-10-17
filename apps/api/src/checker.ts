import { checkUserAgent, guardHost, guardedFetch, hostBlocked, hostPort, readCapped } from "./netguard";
import { networkLevelError, proberOnline, proberSideError } from "./selfcheck";

export type CheckInput = {
  type: "http" | "tcp" | "dns" | "heartbeat" | "postgres" | "mysql" | "redis";
  target: string;
  method: string;
  expectedStatus: number;
  timeoutMs: number;
  keyword?: string | null;
  keywordMode?: string;
  headers?: Record<string, string>;
};
export type CheckOutcome = {
  ok: boolean;
  statusCode?: number;
  latencyMs?: number;
  error?: string;
  /** The check could not be carried out from here (the prober itself is offline): nothing to record about the target. */
  inconclusive?: boolean;
};

/** How much of a response is read when looking for a keyword. A larger body is not downloaded further. */
export const MAX_BODY_BYTES = 1_000_000;

export async function runCheck(m: CheckInput): Promise<CheckOutcome> {
  const started = Date.now();
  try {
    switch (m.type) {
      case "http": return await httpCheck(m, started);
      case "dns": return await dnsCheck(m, started);
      case "tcp": return await tcpCheck(m, started);
      case "postgres": return await postgresCheck(m, started);
      case "mysql": return await mysqlCheck(m, started);
      case "redis": return await redisCheck(m, started);
      default: return { ok: true };
    }
  } catch (e) {
    const failed: CheckOutcome = { ok: false, latencyMs: Date.now() - started, error: describe(e) };
    return (await proberFault(m, e)) ? { ...failed, inconclusive: true } : failed;
  }
}

/** The host a check dials, or null when it has none of its own (dns checks ask a public resolver, not the target). */
function dialedHost(m: CheckInput): string | null {
  try {
    if (m.type === "http") return new URL(m.target).hostname;
    if (m.type === "dns" || m.type === "heartbeat") return null;
    return hostPort(m.target, 1)?.hostname ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether a thrown failure is the prober's fault: its own network stack refused (no IPv6 route…), or it cannot reach any
 * well-known site. Internal targets are never doubted this way: a private network can be fine while the internet is not.
 */
async function proberFault(m: CheckInput, e: unknown): Promise<boolean> {
  if (!networkLevelError(e)) return false;
  if (proberSideError(e)) return true;
  const host = dialedHost(m);
  if (host && hostBlocked(host)) return false;
  return !(await proberOnline());
}

async function httpCheck(m: CheckInput, started: number): Promise<CheckOutcome> {
  const { res, url } = await guardedFetch(m.target, {
    method: m.method,
    signal: AbortSignal.timeout(m.timeoutMs),
    headers: { "user-agent": checkUserAgent(), accept: "*/*", ...m.headers },
  });
  // when redirects were followed, say where we ended up: a 404 usually comes from the final hop, not the URL typed
  const where = url !== m.target ? ` at ${url}` : "";
  const statusOk = res.status === m.expectedStatus || (m.expectedStatus === 200 && res.status >= 200 && res.status < 300);
  if (!m.keyword || m.method === "HEAD") {
    await res.body?.cancel();
    const latencyMs = Date.now() - started;
    return { ok: statusOk, statusCode: res.status, latencyMs, error: statusOk ? undefined : `Expected ${m.expectedStatus}, got ${res.status}${where}` };
  }
  const body = await readCapped(res, MAX_BODY_BYTES);
  const latencyMs = Date.now() - started;
  if (!statusOk) return { ok: false, statusCode: res.status, latencyMs, error: `Expected ${m.expectedStatus}, got ${res.status}${where}` };
  const found = body.includes(m.keyword);
  const wantFound = m.keywordMode !== "absent";
  const ok = found === wantFound;
  return {
    ok, statusCode: res.status, latencyMs,
    error: ok ? undefined : wantFound ? `Keyword "${m.keyword}" not found in response` : `Unexpected keyword "${m.keyword}" found in response`,
  };
}

// DNS-over-HTTPS keeps this runnable on Workers, where there is no raw resolver.
async function dnsCheck(m: CheckInput, started: number): Promise<CheckOutcome> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(m.target)}&type=A`;
  const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(m.timeoutMs) });
  const data = (await res.json()) as { Status: number; Answer?: unknown[] };
  const ok = data.Status === 0 && (data.Answer?.length ?? 0) > 0;
  return { ok, latencyMs: Date.now() - started, error: ok ? undefined : `DNS status ${data.Status}, no answer` };
}

/** Cloudflare's socket API. The import fails anywhere else (Node, tests), whatever the runtime words the error as. */
type WorkerSockets = { connect(o: { hostname: string; port: number }): { opened: Promise<unknown>; close(): Promise<void>; readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } };
let sockets: Promise<WorkerSockets | null> | undefined;
const workerSockets = () => (sockets ??= import(/* @vite-ignore */ "cloudflare:sockets" as string).then((m) => m as WorkerSockets, () => null));

async function tcpCheck(m: CheckInput, started: number): Promise<CheckOutcome> {
  const hp = hostPort(m.target, 0);
  if (!hp) return { ok: false, error: "Target must be host:port" };
  const { port } = hp;
  const hostname = await guardHost(hp.hostname);
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Connection timed out")), m.timeoutMs));
  const connect = async () => {
    const cf = await workerSockets();
    if (cf) {
      const socket = cf.connect({ hostname, port });
      await socket.opened;
      await socket.close();
      return;
    }
    // Node
    const net = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const s = net.connect({ host: hostname, port }, () => { s.end(); resolve(); });
      s.on("error", reject);
    });
  };
  await Promise.race([connect(), timeout]);
  return { ok: true, latencyMs: Date.now() - started };
}

// ---- Database probes -------------------------------------------------------------------------------------------------
// These speak just enough of each wire protocol, without credentials, to prove a real server answers (not merely that
// a port is open). Auth failures therefore count as "up": the server is alive and talking. A bad or missing password
// cannot be detected here.

type Conn = { write(b: Uint8Array): Promise<void>; read(): Promise<Uint8Array | null>; close(): void };

async function open(hostname: string, port: number): Promise<Conn> {
  const cf = await workerSockets();
  if (cf) {
    const socket = cf.connect({ hostname, port });
    await socket.opened;
    const w = socket.writable.getWriter();
    const r = socket.readable.getReader();
    return {
      write: (b) => w.write(b),
      read: async () => { const x = await r.read(); return x.done ? null : (x.value as Uint8Array); },
      close: () => { void socket.close().catch(() => {}); },
    };
  }
  // Node
  const net = await import("node:net");
  const sock = await new Promise<import("node:net").Socket>((resolve, reject) => {
    const s = net.connect({ host: hostname, port }, () => resolve(s));
    s.once("error", reject);
  });
  const queue: Uint8Array[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  sock.on("data", (d) => { queue.push(new Uint8Array(d)); wake?.(); });
  sock.on("close", () => { ended = true; wake?.(); });
  sock.on("error", () => { ended = true; wake?.(); });
  return {
    write: (b) => new Promise((res, rej) => sock.write(b, (err) => (err ? rej(err) : res()))),
    read: async () => {
      while (!queue.length && !ended) await new Promise<void>((r) => { wake = r; });
      return queue.shift() ?? null;
    },
    close: () => sock.destroy(),
  };
}

/** Connect, optionally send bytes, read until `done(bytes)` says the reply is complete; everything bounded by timeoutMs. */
async function exchange(m: CheckInput, port: number, send: Uint8Array | null, done: (b: Uint8Array) => boolean): Promise<Uint8Array> {
  const hp = hostPort(m.target, port);
  if (!hp) throw new Error("Target must be host or host:port");
  const hostname = await guardHost(hp.hostname);
  let conn: Conn | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("Connection timed out")), m.timeoutMs); });
  const run = async () => {
    conn = await open(hostname, hp.port);
    if (send) await conn.write(send);
    let buf = new Uint8Array(0);
    while (!done(buf)) {
      const chunk = await conn.read();
      if (!chunk) break;
      const next = new Uint8Array(buf.length + chunk.length);
      next.set(buf); next.set(chunk, buf.length);
      buf = next;
    }
    return buf;
  };
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
    try { conn?.close(); } catch { /* already closed */ }
  }
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** SSLRequest: any real PostgreSQL server answers with a single 'S' (TLS available) or 'N'. */
async function postgresCheck(m: CheckInput, started: number): Promise<CheckOutcome> {
  const ssl = new Uint8Array([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);
  const reply = await exchange(m, 5432, ssl, (b) => b.length >= 1);
  const latencyMs = Date.now() - started;
  const c = reply[0];
  if (c === 0x53 /* S */ || c === 0x4e /* N */) return { ok: true, latencyMs };
  if (c === 0x45 /* E */) return { ok: true, latencyMs }; // ErrorResponse: still a PostgreSQL server
  return { ok: false, latencyMs, error: reply.length ? "Not a PostgreSQL server (unexpected reply)" : "Connection closed without a reply" };
}

/** The MySQL/MariaDB server speaks first: a handshake packet whose payload starts with protocol version 10. */
async function mysqlCheck(m: CheckInput, started: number): Promise<CheckOutcome> {
  const reply = await exchange(m, 3306, null, (b) => b.length >= 5);
  const latencyMs = Date.now() - started;
  if (reply.length < 5) return { ok: false, latencyMs, error: "Connection closed without a handshake" };
  if (reply[4] === 0x0a) return { ok: true, latencyMs };
  if (reply[4] === 0xff) return { ok: false, latencyMs, error: `Server refused the connection: ${text(reply.slice(7)).replace(/[^\x20-\x7e]/g, "").slice(0, 200) || "error packet"}` };
  return { ok: false, latencyMs, error: "Not a MySQL server (unexpected handshake)" };
}

/** Inline PING: +PONG, or -NOAUTH / -WRONGPASS when a password is required (still a live Redis). */
async function redisCheck(m: CheckInput, started: number): Promise<CheckOutcome> {
  const reply = await exchange(m, 6379, new TextEncoder().encode("PING\r\n"), (b) => b.includes(10));
  const latencyMs = Date.now() - started;
  const line = text(reply).split("\r\n")[0].slice(0, 200);
  if (line.startsWith("+PONG") || line.startsWith("-NOAUTH") || line.startsWith("-WRONGPASS")) return { ok: true, latencyMs };
  return { ok: false, latencyMs, error: line ? `Unexpected Redis reply: ${line}` : "Connection closed without a reply" };
}

function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  if (e.name === "TimeoutError") return "Request timed out";
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  return cause?.code ?? cause?.message ?? e.message;
}
