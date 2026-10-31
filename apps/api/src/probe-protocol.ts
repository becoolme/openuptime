/**
 * Request signing between the scheduler and a remote probe (apps/probe). Only Web Crypto, so the same file runs on
 * Workers, Node and Vercel. A probe is an HTTP endpoint that makes requests on demand: without a signature it would be
 * an open proxy, so every request carries an HMAC of its timestamp and body under a shared secret.
 */

const encoder = new TextEncoder();

/** How far a request's timestamp may be from the probe's clock, in seconds. */
export const MAX_SKEW_SEC = 60;
export const TIMESTAMP_HEADER = "x-ou-timestamp";
export const SIGNATURE_HEADER = "x-ou-signature";
/**
 * HMAC of the timestamp and declared body length, checked before the body is read. The body signature covers the
 * bytes and so can only be checked after buffering them; this lets a probe accept a large (MCP) body only from the
 * scheduler and keep a small limit for everyone else.
 */
export const ENVELOPE_HEADER = "x-ou-envelope";
/** Advertised by probes that run MCP checks with the current request format. */
export const MCP_MONITOR_CAPABILITY = "mcp-monitor-v2";

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(secret: string, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, encoder.encode(message));
}

/** Hex HMAC-SHA256 of `<timestamp>.<body>`. */
export async function signProbe(secret: string, timestampSec: number, body: string): Promise<string> {
  return hex(await hmac(secret, `${timestampSec}.${body}`));
}

/** Hex HMAC-SHA256 of `envelope.<timestamp>.<byte length>`; distinct from any body signature by its prefix. */
export async function signProbeEnvelope(secret: string, timestampSec: number, byteLength: number): Promise<string> {
  return hex(await hmac(secret, `envelope.${timestampSec}.${byteLength}`));
}

/** Is the timestamp present and within the allowed skew, and does a signature header look like one? No body needed. */
export function probeHeadersPlausible(o: { timestamp: string | null; signature: string | null; nowSec?: number }): boolean {
  if (!o.timestamp || !o.signature || !/^\d{1,12}$/.test(o.timestamp) || !/^[0-9a-f]{64}$/i.test(o.signature)) return false;
  return Math.abs((o.nowSec ?? Math.floor(Date.now() / 1000)) - Number(o.timestamp)) <= MAX_SKEW_SEC;
}

/** Does the envelope signature match this timestamp and declared length? Checked before reading the body. */
export async function verifyProbeEnvelope(secret: string, o: { timestamp: string | null; envelope: string | null; byteLength: number; nowSec?: number }): Promise<boolean> {
  if (!secret || !o.envelope || !Number.isSafeInteger(o.byteLength) || o.byteLength < 0 || !probeHeadersPlausible({ timestamp: o.timestamp, signature: o.envelope, nowSec: o.nowSec })) return false;
  return same(await signProbeEnvelope(secret, Number(o.timestamp), o.byteLength), o.envelope.toLowerCase());
}

/** Constant-time comparison of two equal-purpose hex strings. */
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Does `signature` match this body and a timestamp within the allowed skew? */
export async function verifyProbe(secret: string, o: { timestamp: string | null; signature: string | null; body: string; nowSec?: number }): Promise<boolean> {
  if (!secret || !o.timestamp || !o.signature || !/^\d{1,12}$/.test(o.timestamp)) return false;
  const ts = Number(o.timestamp);
  const now = o.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_SKEW_SEC) return false;
  return same(await signProbe(secret, ts, o.body), o.signature.toLowerCase());
}
