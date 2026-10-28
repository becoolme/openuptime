/**
 * WebSocket checks. The handshake is the check: a 101 with a valid Sec-WebSocket-Accept means the endpoint is up.
 * Optionally a text message is sent once the connection is open, and the first message that comes back (a reply, or a
 * greeting the server sends on its own) is matched against the keyword.
 *
 * Two transports, one verdict. On Cloudflare Workers the runtime's own client is used (fetch with `Upgrade: websocket`);
 * the platform refuses private ranges there. On Node the upgrade goes over http.request pinned to the addresses the
 * guard validated, like every other request, and frames are read and written here.
 */

import type { CheckInput, CheckOutcome } from "./checker";
import { checkUserAgent, connectFailure, forgetResolved, guardAddresses, isWorkers } from "./netguard";

/** How much of one message is kept when looking for a keyword. The rest of a larger message is not waited for. */
export const MAX_MESSAGE_BYTES = 1_000_000;

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Headers the handshake sets itself: a monitor's own headers cannot replace them. */
const RESERVED = new Set(["connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "host"]);

/** What the server must answer in Sec-WebSocket-Accept for `key` (RFC 6455, section 4.2.2). */
export async function acceptFor(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(key + GUID));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

function newKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/** A ws:// or wss:// URL, or why the target is not one. */
export function websocketUrl(target: string): URL | string {
  let u: URL;
  try {
    u = new URL(target.trim());
  } catch {
    return "Target must be a ws:// or wss:// URL";
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return "Target must be a ws:// or wss:// URL";
  return u;
}

// ---- frames (Node) -------------------------------------------------------------------------------------------------

export const OP = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

/** One frame from client to server: always masked, as the protocol requires. */
export function encodeFrame(opcode: number, payload: Uint8Array, mask = crypto.getRandomValues(new Uint8Array(4))): Uint8Array {
  const len = payload.length;
  const ext = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const out = new Uint8Array(2 + ext + 4 + len);
  out[0] = 0x80 | opcode;
  out[1] = 0x80 | (ext === 0 ? len : ext === 2 ? 126 : 127);
  const view = new DataView(out.buffer);
  if (ext === 2) view.setUint16(2, len);
  if (ext === 8) view.setBigUint64(2, BigInt(len));
  out.set(mask, 2 + ext);
  for (let i = 0; i < len; i++) out[2 + ext + 4 + i] = payload[i] ^ mask[i & 3];
  return out;
}

export type Frame = { fin: boolean; opcode: number; payload: Uint8Array };

/**
 * The first complete frame in `buf` and how many bytes it took, null when more bytes are needed. A frame larger than
 * `max` is refused with an error rather than buffered.
 */
export function decodeFrame(buf: Uint8Array, max = MAX_MESSAGE_BYTES): { frame: Frame; size: number } | null {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let at = 2;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (len === 126) {
    if (buf.length < 4) return null;
    len = view.getUint16(2);
    at = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = view.getBigUint64(2);
    if (big > BigInt(max)) throw new Error("Message is larger than 1 MB");
    len = Number(big);
    at = 10;
  }
  if (len > max) throw new Error("Message is larger than 1 MB");
  const maskAt = at;
  if (masked) at += 4;
  if (buf.length < at + len) return null;
  const payload = buf.slice(at, at + len);
  if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskAt + (i & 3)];
  return { frame: { fin, opcode, payload }, size: at + len };
}

/** Code and reason of a close frame's payload. */
export function closeInfo(payload: Uint8Array): { code?: number; reason: string } {
  if (payload.length < 2) return { reason: "" };
  return { code: (payload[0] << 8) | payload[1], reason: new TextDecoder().decode(payload.subarray(2)) };
}

// ---- sessions --------------------------------------------------------------------------------------------------------

type Next = { message: string } | { closed: { code?: number; reason: string } };

/** An open (or refused) handshake, whichever transport made it. */
type Session = {
  status: number;
  /** Where a redirect leads, when the server answered with one instead of upgrading. */
  location?: string | null;
  /** Whether Sec-WebSocket-Accept matched the key. Workers check this themselves: always true there. */
  accepted: boolean;
  send(text: string): Promise<void>;
  /** The next data message, or how the connection ended. */
  next(): Promise<Next>;
  close(): void;
};

function handshakeHeaders(m: CheckInput): Record<string, string> {
  const out: Record<string, string> = { "user-agent": checkUserAgent() };
  for (const [k, v] of Object.entries(m.headers ?? {})) if (!RESERVED.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  return out;
}

async function workersSession(u: URL, m: CheckInput, signal: AbortSignal): Promise<Session> {
  const url = new URL(u);
  url.protocol = u.protocol === "wss:" ? "https:" : "http:";
  const res = await fetch(url, { headers: { ...handshakeHeaders(m), upgrade: "websocket" }, signal, redirect: "manual" });
  const ws = (res as Response & { webSocket?: WorkersSocket | null }).webSocket;
  if (res.status !== 101 || !ws) {
    await res.body?.cancel();
    return { status: res.status, location: res.headers.get("location"), accepted: false, send: async () => {}, next: async () => ({ closed: { reason: "" } }), close: () => {} };
  }
  ws.accept();
  // newer compatibility dates hand binary messages over as a Blob unless asked otherwise
  ws.binaryType = "arraybuffer";
  // promises, so a Blob that is still being read cannot let a later message overtake it
  const queue: Promise<Next>[] = [];
  let wake: (() => void) | null = null;
  const push = (n: Next | Promise<Next>) => { queue.push(Promise.resolve(n)); wake?.(); };
  const text = (bytes: ArrayBuffer) => new TextDecoder().decode(new Uint8Array(bytes).subarray(0, MAX_MESSAGE_BYTES));
  ws.addEventListener("message", (e) => {
    const data = e.data as string | ArrayBuffer | Blob;
    if (typeof data === "string") push({ message: data.slice(0, MAX_MESSAGE_BYTES) });
    else if (data instanceof ArrayBuffer) push({ message: text(data) });
    else push(data.slice(0, MAX_MESSAGE_BYTES).arrayBuffer().then((b) => ({ message: text(b) })));
  });
  ws.addEventListener("close", (e) => push({ closed: { code: e.code, reason: e.reason } }));
  ws.addEventListener("error", () => push({ closed: { reason: "connection error" } }));
  const drop = () => { try { ws.close(1000); } catch { /* already closed */ } };
  // the check may have timed out while the handshake was finishing: nothing is left to wait for this connection
  if (signal.aborted) drop();
  else signal.addEventListener("abort", drop, { once: true });
  return {
    status: 101,
    accepted: true,
    send: async (text) => ws.send(text),
    next: async () => {
      while (!queue.length) await new Promise<void>((r) => { wake = r; });
      return await queue.shift()!;
    },
    close: () => { try { ws.close(1000, "check done"); } catch { /* already closed */ } },
  };
}

/** The Workers client socket, as much of it as is used here (the probe compiles without the Workers types). */
type WorkersSocket = {
  binaryType: string;
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: (e: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", fn: () => void): void;
};

type Upgraded = { status: number; location?: string | null; acceptHeader?: string | null; socket?: import("node:stream").Duplex; head?: Buffer };

/** The upgrade request over Node's http client, connecting only to `addresses` when there are any (see pinnedFetch). */
async function nodeUpgrade(u: URL, m: CheckInput, key: string, addresses: string[] | null, signal: AbortSignal): Promise<Upgraded> {
  const secure = u.protocol === "wss:";
  const lib = secure ? await import("node:https") : await import("node:http");
  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  return new Promise<Upgraded>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const req = lib.request({
      protocol: secure ? "https:" : "http:",
      hostname,
      port: u.port || undefined,
      path: `${u.pathname}${u.search}`,
      method: "GET",
      headers: { ...handshakeHeaders(m), connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": key },
      ...(addresses ? {
        lookup: (_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          const list = addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
          if (opts?.all) cb(null, list);
          else cb(null, list[0].address, list[0].family);
        },
      } : {}),
      // names that are IP literals carry no SNI; named hosts verify the certificate against the name, not the address
      ...(secure && !/^[\d.]+$|:/.test(hostname) ? { servername: hostname } : {}),
    } as import("node:http").RequestOptions);
    req.on("upgrade", (res, socket, head) => resolve({ status: res.statusCode ?? 101, acceptHeader: res.headers["sec-websocket-accept"] as string | undefined, socket, head }));
    req.on("response", (res) => { res.resume(); resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? null }); });
    req.on("error", reject);
    signal.addEventListener("abort", () => { req.destroy(); reject(signal.reason ?? new Error("Connection timed out")); }, { once: true });
    req.end();
  });
}

async function nodeSession(u: URL, m: CheckInput, signal: AbortSignal): Promise<Session> {
  const key = newKey();
  let { addresses } = await guardAddresses(u.hostname);
  let up: Upgraded;
  try {
    up = await nodeUpgrade(u, m, key, addresses, signal);
  } catch (e) {
    // the cached lookup may be stale: one more try on a fresh, re-validated one, only when the name now points elsewhere
    if (!addresses || signal.aborted || !connectFailure(e)) throw e;
    const before = new Set(addresses);
    forgetResolved(u.hostname);
    addresses = (await guardAddresses(u.hostname)).addresses;
    if (!addresses || (addresses.length === before.size && addresses.every((a) => before.has(a)))) throw e;
    up = await nodeUpgrade(u, m, key, addresses, signal);
  }
  const socket = up.socket;
  if (up.status !== 101 || !socket) {
    socket?.destroy();
    return { status: up.status, location: up.location, accepted: false, send: async () => {}, next: async () => ({ closed: { reason: "" } }), close: () => {} };
  }
  const accepted = up.acceptHeader === (await acceptFor(key));
  let buf: Uint8Array = new Uint8Array(up.head ?? []);
  let ended = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  socket.on("data", (d: Buffer) => {
    const next = new Uint8Array(buf.length + d.length);
    next.set(buf); next.set(d, buf.length);
    buf = next;
    wake?.();
  });
  socket.on("close", () => { ended = true; wake?.(); });
  socket.on("error", (e) => { failure = e; ended = true; wake?.(); });
  if (signal.aborted) socket.destroy();
  else signal.addEventListener("abort", () => socket.destroy(), { once: true });
  const write = (b: Uint8Array) => new Promise<void>((res, rej) => socket.write(b, (err) => (err ? rej(err) : res())));

  async function frame(): Promise<Frame | null> {
    for (;;) {
      const got = decodeFrame(buf);
      if (got) { buf = buf.subarray(got.size); return got.frame; }
      if (ended) return null;
      await new Promise<void>((r) => { wake = r; });
    }
  }

  return {
    status: 101,
    accepted,
    send: (text) => write(encodeFrame(OP.text, new TextEncoder().encode(text))),
    next: async () => {
      const parts: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        let f: Frame | null;
        try {
          f = await frame();
        } catch (e) {
          // a message too large to hold: what arrived so far is enough to look for the keyword
          if (parts.length) return { message: new TextDecoder().decode(concat(parts)) };
          throw e;
        }
        if (!f) return { closed: { reason: failure ? (failure as Error).message : "" } };
        if (f.opcode === OP.ping) { await write(encodeFrame(OP.pong, f.payload)).catch(() => {}); continue; }
        if (f.opcode === OP.pong) continue;
        if (f.opcode === OP.close) return { closed: closeInfo(f.payload) };
        if (f.opcode !== OP.text && f.opcode !== OP.binary && f.opcode !== OP.continuation) continue;
        parts.push(f.payload);
        size += f.payload.length;
        if (size >= MAX_MESSAGE_BYTES) return { message: new TextDecoder().decode(concat(parts).subarray(0, MAX_MESSAGE_BYTES)) };
        if (f.fin) return { message: new TextDecoder().decode(concat(parts)) };
      }
    },
    close: () => {
      // a polite close frame (1000, normal closure), then the socket goes
      void write(encodeFrame(OP.close, new Uint8Array([0x03, 0xe8]))).catch(() => {}).finally(() => socket.destroy());
    },
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ---- the check -------------------------------------------------------------------------------------------------------

const closedText = (c: { code?: number; reason: string }) =>
  c.code ? ` (code ${c.code}${c.reason ? `: ${c.reason.slice(0, 200)}` : ""})` : c.reason ? ` (${c.reason.slice(0, 200)})` : "";

/**
 * Up when the handshake completes; with a message to send or a keyword, a message must also come back (and match).
 * Everything, from connecting to the reply, is bounded by the monitor's timeout.
 */
export async function websocketCheck(m: CheckInput, started: number): Promise<CheckOutcome> {
  const u = websocketUrl(m.target);
  if (typeof u === "string") return { ok: false, error: u };
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => { const e = new Error("Connection timed out"); ctl.abort(e); rej(e); }, m.timeoutMs);
  });
  let session: Session | undefined;
  const run = async (): Promise<CheckOutcome> => {
    session = isWorkers() ? await workersSession(u, m, ctl.signal) : await nodeSession(u, m, ctl.signal);
    const s = session;
    if (s.status !== 101) {
      const where = s.location ? ` (redirects to ${s.location.slice(0, 500)})` : "";
      return { ok: false, statusCode: s.status, latencyMs: Date.now() - started, error: `Expected 101 Switching Protocols, got ${s.status}${where}` };
    }
    if (!s.accepted) return { ok: false, statusCode: 101, latencyMs: Date.now() - started, error: "Server sent a wrong Sec-WebSocket-Accept" };
    const message = m.wsMessage ?? "";
    if (!message && !m.keyword) return { ok: true, statusCode: 101, latencyMs: Date.now() - started };
    if (message) await s.send(message);
    const reply = await s.next();
    const latencyMs = Date.now() - started;
    if ("closed" in reply) return { ok: false, statusCode: 101, latencyMs, error: `Connection closed before ${message ? "a reply" : "a message"} arrived${closedText(reply.closed)}` };
    if (!m.keyword) return { ok: true, statusCode: 101, latencyMs };
    const found = reply.message.includes(m.keyword);
    const wantFound = m.keywordMode !== "absent";
    const ok = found === wantFound;
    return {
      ok, statusCode: 101, latencyMs,
      error: ok ? undefined : wantFound ? `Keyword "${m.keyword}" not found in ${message ? "the reply" : "the first message"}` : `Unexpected keyword "${m.keyword}" found in ${message ? "the reply" : "the first message"}`,
    };
  };
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
    session?.close();
  }
}
