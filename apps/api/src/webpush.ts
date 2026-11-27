import type { PushDevice, Repo } from "@openuptime/repo";
import { appUrl } from "./email";
import { buildPayload, type PushEvent } from "./apns";
import { isLang, type Lang } from "./mail-i18n";
import { guardedFetch } from "./netguard";

/**
 * Browser push (the Web Push protocol). The server proves who it is with one VAPID key pair (RFC 8292) and encrypts each
 * message for one browser subscription (RFC 8291, aes128gcm). Only WebCrypto is used, so it runs on Workers and Node.
 *
 * A subscription's endpoint is chosen by the browser, which means by whoever registered it: it is sent through the SSRF
 * guard and must be https.
 */

type VapidEnv = { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string };
export type Vapid = { publicKey: string; privateKey: string; subject?: string };

let vapid: Vapid | null = null;
let signingKey: Promise<CryptoKey> | null = null;

/** Configured only when both keys are set (base64url; see scripts/gen-vapid-keys.mjs). */
export function configureWebPush(env: VapidEnv) {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const next = publicKey && privateKey ? { publicKey, privateKey, subject: env.VAPID_SUBJECT?.trim() || undefined } : null;
  if (JSON.stringify(next) !== JSON.stringify(vapid)) signingKey = null;
  vapid = next;
}
export const webPushConfigured = () => vapid !== null;
/** The public key a browser needs to subscribe (the `applicationServerKey`). */
export const webPushPublicKey = () => vapid?.publicKey ?? null;

// ---- bytes -----------------------------------------------------------------------------------------------------------

/** Always backed by a plain ArrayBuffer, which is what WebCrypto and fetch accept. */
export type Bytes = Uint8Array<ArrayBuffer>;

export const b64url = (bytes: Uint8Array | string) => {
  const u8 = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const fromB64url = (s: string): Bytes => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

const text = (s: string) => new TextEncoder().encode(s) as Bytes;

// ---- VAPID -----------------------------------------------------------------------------------------------------------

function importSigningKey(v: Vapid): Promise<CryptoKey> {
  const pub = fromB64url(v.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY must be an uncompressed P-256 public key (65 bytes, base64url)");
  return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d: v.privateKey, x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33)), ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** `Authorization` for one push service: an ES256 JWT for the endpoint's origin, valid for 12 hours. */
export async function vapidHeader(v: Vapid, endpoint: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await (signingKey ??= importSigningKey(v));
  const claims = { aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: v.subject || appUrl() };
  const signing = `${b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }))}.${b64url(JSON.stringify(claims))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, text(signing)));
  return `vapid t=${signing}.${b64url(sig)}, k=${v.publicKey}`;
}

// ---- encryption (RFC 8291) -------------------------------------------------------------------------------------------

const RECORD_SIZE = 4096;
/** The most plaintext one record holds (the header is 86 bytes, the AEAD tag 16, the padding delimiter 1). */
export const MAX_PLAINTEXT = RECORD_SIZE - 86 - 16 - 1;

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** The request body for one subscription: `salt || record size || key id length || sender public key || ciphertext`. */
export async function encryptPayload(sub: { p256dh: string; auth: string }, plaintext: Uint8Array, opts: { salt?: Bytes } = {}): Promise<Bytes> {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error("Push message is too large");
  const uaPublic = fromB64url(sub.p256dh);
  const authSecret = fromB64url(sub.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error("Browser subscription keys are not valid");
  const sender = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", sender.publicKey));
  const peer = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, sender.privateKey, 256));
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdf(authSecret, shared, concat(text("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, prk, text("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, prk, text("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, RECORD_SIZE);
  return concat(salt, size, new Uint8Array([asPublic.length]), asPublic, sealed);
}

// ---- payload ---------------------------------------------------------------------------------------------------------

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What the service worker shows. Same words as the phone alert; `url` opens the incident. */
export function buildWebPayload(ev: PushEvent, orgId: string, lang: Lang) {
  const { aps, kind } = buildPayload(ev, orgId, lang);
  return {
    title: clip(aps.alert.title, 160),
    body: clip(aps.alert.body, 300),
    url: ev.test ? `${appUrl()}/app/alerting` : `${appUrl()}/app/incidents/${ev.incident.id}`,
    tag: ev.monitor.id ?? ev.incident.id,
    kind,
    incidentId: ev.incident.id,
    organizationId: orgId,
  };
}

// ---- sending ---------------------------------------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 10_000;

/** What `sendOne` (and a test stub) answers: the HTTP status the push service gave, or why none arrived. */
export type WebPushSender = (url: string, init: RequestInit) => Promise<{ status: number }>;

const defaultSender: WebPushSender = async (url, init) => {
  const { res } = await guardedFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, { follow: false });
  await res.body?.cancel().catch(() => {});
  return { status: res.status };
};

let sender: WebPushSender | null = null;
/** Tests inject a stub; null restores the real one. */
export const setWebPushSender = (s: WebPushSender | null) => { sender = s; };

export const isWebDevice = (d: Pick<PushDevice, "platform">) => d.platform === "web";

type Outcome = { outcome: "ok" | "dead" | "failed"; detail?: string };

async function sendOne(v: Vapid, d: PushDevice, payload: Uint8Array, topic: string): Promise<Outcome> {
  if (!d.p256dh || !d.auth) return { outcome: "dead" };
  let url: URL;
  try {
    url = new URL(d.token);
  } catch {
    return { outcome: "dead" };
  }
  if (url.protocol !== "https:") return { outcome: "dead" };
  try {
    const body = await encryptPayload({ p256dh: d.p256dh, auth: d.auth }, payload);
    const res = await (sender ?? defaultSender)(url.toString(), {
      method: "POST",
      headers: {
        authorization: await vapidHeader(v, url.toString()),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: "3600",
        urgency: "high",
        topic,
      },
      body,
    });
    if (res.status >= 200 && res.status < 300) return { outcome: "ok" };
    if (res.status === 404 || res.status === 410) return { outcome: "dead" };
    return { outcome: "failed", detail: `${url.host} responded HTTP ${res.status}` };
  } catch (e) {
    const name = (e as Error)?.name;
    // the endpoint is a credential for that browser: errors name the host only
    return { outcome: "failed", detail: name === "BlockedTarget" ? `${url.host} is not a public address` : name === "TimeoutError" ? `${url.host} timed out` : `Could not reach ${url.host}` };
  }
}

/**
 * Push one event to the browsers in `devices`. Browsers whose subscription is gone are removed. Throws only when every
 * browser that was tried failed for a reason worth retrying (or the sender is misconfigured); the message never holds an endpoint.
 */
export async function sendWebPush(repo: Pick<Repo, "deletePushDeviceByToken">, devices: PushDevice[], ev: PushEvent, orgId: string) {
  if (!devices.length) return;
  const v = vapid;
  if (!v) throw new Error("Browser push is not configured on this server");
  const topic = ev.incident.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const results = await Promise.all(
    devices.map(async (d) => {
      const lang: Lang = isLang(d.locale) ? d.locale : "en";
      const r = await sendOne(v, d, text(JSON.stringify(buildWebPayload(ev, orgId, lang))), topic);
      if (r.outcome === "dead") await repo.deletePushDeviceByToken(d.token).catch((e) => console.error("could not remove a dead browser subscription", (e as Error).message));
      return r;
    }),
  );
  const failed = results.filter((r) => r.outcome === "failed");
  if (failed.length && failed.length === results.length) throw new Error(`${failed[0].detail}${failed.length > 1 ? ` (${failed.length} browsers)` : ""}`);
  if (failed.length) console.error(`web push: ${failed.length}/${results.length} browsers failed (${failed[0].detail})`);
}
