import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PushDevice } from "@openuptime/repo";
import { configureEmail } from "./email";
import { type Bytes, b64url, buildWebPayload, configureWebPush, encryptPayload, fromB64url, MAX_PLAINTEXT, sendWebPush, setWebPushSender, vapidHeader, webPushConfigured, webPushPublicKey } from "./webpush";

const text = (u: Uint8Array) => new TextDecoder().decode(u);
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

/** A browser's side of a subscription: its key pair and auth secret, and a way to read what the server sent (RFC 8291). */
async function browser() {
  const keys = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const hkdf = async (salt: Bytes, ikm: Bytes, info: Bytes, n: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
  const enc = (s: string) => new TextEncoder().encode(s);
  const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));
  return {
    sub: { p256dh: b64url(pub), auth: b64url(auth) },
    async open(body: Uint8Array) {
      const salt = body.slice(0, 16);
      expect(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0)).toBe(4096);
      const idLen = body[20];
      const asPub = body.slice(21, 21 + idLen);
      const sealed = body.slice(21 + idLen);
      const peer = await crypto.subtle.importKey("raw", asPub, ECDH, false, []);
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, keys.privateKey, 256));
      const prk = await hkdf(auth, shared, cat(enc("WebPush: info\0"), pub, asPub), 32);
      const cek = await hkdf(salt, prk, enc("Content-Encoding: aes128gcm\0"), 16);
      const nonce = await hkdf(salt, prk, enc("Content-Encoding: nonce\0"), 12);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), sealed));
      expect(plain[plain.length - 1]).toBe(2); // the padding delimiter of the last record
      return plain.slice(0, -1);
    },
  };
}

async function vapidPair() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { publicKey: b64url(raw), privateKey: jwk.d!, verify: pair.publicKey };
}

const device = (browserSub: { p256dh: string; auth: string } | null, over: Partial<PushDevice> = {}): PushDevice => ({
  id: crypto.randomUUID(), userId: "u", token: "https://push.example.com/send/abc", platform: "web", environment: "production", locale: null, name: null, critical: false, p256dh: browserSub?.p256dh ?? null, auth: browserSub?.auth ?? null, createdAt: new Date(), lastSeenAt: new Date(), ...over,
});
const ev = { kind: "incident.opened" as const, incident: { id: "11111111-1111-1111-1111-111111111111", title: "API is down" }, monitor: { id: "m1", name: "API", target: "https://api.example.com" }, reason: "HTTP 503" };

beforeEach(() => {
  configureEmail({ WEB_ORIGIN: "https://app.example.com" } as never);
});
afterEach(() => {
  setWebPushSender(null);
  configureWebPush({});
});

describe("configuration", () => {
  it("is on only when both keys are set, and exposes the public one", async () => {
    configureWebPush({});
    expect(webPushConfigured()).toBe(false);
    configureWebPush({ VAPID_PUBLIC_KEY: "x" });
    expect(webPushConfigured()).toBe(false);
    const k = await vapidPair();
    configureWebPush({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey });
    expect(webPushConfigured()).toBe(true);
    expect(webPushPublicKey()).toBe(k.publicKey);
  });
});

describe("encryption", () => {
  it("is readable by the browser that owns the subscription, and only by it", async () => {
    const b = await browser();
    const other = await browser();
    const body = await encryptPayload(b.sub, new TextEncoder().encode('{"title":"API is down"}'));
    expect(text(await b.open(body))).toBe('{"title":"API is down"}');
    await expect(other.open(body)).rejects.toThrow();
  });

  it("uses a fresh salt and sender key for every message", async () => {
    const b = await browser();
    const a = await encryptPayload(b.sub, new Uint8Array([1]));
    const c = await encryptPayload(b.sub, new Uint8Array([1]));
    expect(a.slice(0, 16)).not.toEqual(c.slice(0, 16));
    expect(a.slice(21, 86)).not.toEqual(c.slice(21, 86));
  });

  it("refuses a message that does not fit one record and keys that are not keys", async () => {
    const b = await browser();
    await expect(encryptPayload(b.sub, new Uint8Array(MAX_PLAINTEXT + 1))).rejects.toThrow(/too large/);
    expect((await encryptPayload(b.sub, new Uint8Array(MAX_PLAINTEXT))).length).toBe(4096);
    await expect(encryptPayload({ ...b.sub, auth: "AAAA" }, new Uint8Array(1))).rejects.toThrow(/not valid/);
    await expect(encryptPayload({ ...b.sub, p256dh: "AAAA" }, new Uint8Array(1))).rejects.toThrow(/not valid/);
  });
});

describe("VAPID", () => {
  it("signs a token for the push service's origin that its public key verifies", async () => {
    const k = await vapidPair();
    const header = await vapidHeader({ publicKey: k.publicKey, privateKey: k.privateKey, subject: "mailto:ops@example.com" }, "https://fcm.googleapis.com/fcm/send/xyz", 1_000);
    const [, t, key] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
    expect(key).toBe(k.publicKey);
    const [h, c, s] = t.split(".");
    expect(JSON.parse(text(fromB64url(h)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(text(fromB64url(c)))).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_000 + 12 * 3600, sub: "mailto:ops@example.com" });
    expect(fromB64url(s).length).toBe(64);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k.verify, fromB64url(s), new TextEncoder().encode(`${h}.${c}`))).toBe(true);
  });
});

describe("the notification", () => {
  it("carries the alert's words in the browser's language and opens the incident", () => {
    const en = buildWebPayload(ev, "org1", "en");
    expect(en).toMatchObject({ title: "API is down", body: "HTTP 503", url: `https://app.example.com/app/incidents/${ev.incident.id}`, tag: "m1", kind: "incident.opened" });
    expect(buildWebPayload(ev, "org1", "zh-CN").title).toContain("API");
    expect(buildWebPayload({ ...ev, test: true }, "org1", "en").url).toBe("https://app.example.com/app/alerting");
  });
});

describe("sending", () => {
  const configure = async () => {
    const k = await vapidPair();
    configureWebPush({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey });
  };
  const repo = () => {
    const removed: string[] = [];
    return { removed, repo: { deletePushDeviceByToken: async (t: string) => void removed.push(t) } };
  };

  it("posts one encrypted message per browser with the headers a push service needs", async () => {
    await configure();
    const b = await browser();
    const seen: { url: string; init: RequestInit }[] = [];
    setWebPushSender(async (url, init) => (seen.push({ url, init }), { status: 201 }));
    const r = repo();
    await sendWebPush(r.repo, [device(b.sub)], ev, "org1");
    expect(seen).toHaveLength(1);
    const h = seen[0].init.headers as Record<string, string>;
    expect(seen[0].url).toBe("https://push.example.com/send/abc");
    expect(h["content-encoding"]).toBe("aes128gcm");
    expect(h.authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(h.topic).toBe("11111111-1111-1111-1111-11111111");
    expect(h.topic.length).toBeLessThanOrEqual(32);
    const msg = JSON.parse(text(await b.open(seen[0].init.body as Uint8Array)));
    expect(msg).toMatchObject({ title: "API is down", incidentId: ev.incident.id });
    expect(r.removed).toEqual([]);
  });

  it("forgets a subscription the push service says is gone, and a malformed one, without failing the alert", async () => {
    await configure();
    const b = await browser();
    setWebPushSender(async (url) => ({ status: url.endsWith("/gone") ? 410 : url.endsWith("/missing") ? 404 : 201 }));
    const r = repo();
    await sendWebPush(r.repo, [device(b.sub, { token: "https://push.example.com/gone" }), device(b.sub, { token: "https://push.example.com/missing" }), device(null, { token: "https://push.example.com/nokeys" }), device(b.sub, { token: "http://push.example.com/plain" }), device(b.sub)], ev, "org1");
    expect(r.removed.sort()).toEqual(["http://push.example.com/plain", "https://push.example.com/gone", "https://push.example.com/missing", "https://push.example.com/nokeys"]);
  });

  it("fails only when every browser failed, and never puts the endpoint in the message", async () => {
    await configure();
    const b = await browser();
    const r = repo();
    setWebPushSender(async () => ({ status: 503 }));
    await expect(sendWebPush(r.repo, [device(b.sub, { token: "https://push.example.com/secret-endpoint-token" })], ev, "org1")).rejects.toThrow("push.example.com responded HTTP 503");
    await expect(sendWebPush(r.repo, [device(b.sub, { token: "https://push.example.com/secret-endpoint-token" })], ev, "org1")).rejects.not.toThrow(/secret-endpoint-token/);
    // one good browser is enough
    setWebPushSender(async (url) => ({ status: url.endsWith("/ok") ? 201 : 503 }));
    await sendWebPush(r.repo, [device(b.sub, { token: "https://push.example.com/ok" }), device(b.sub, { token: "https://push.example.com/bad" })], ev, "org1");
  });

  it("turns a blocked or unreachable endpoint into a plain message", async () => {
    await configure();
    const b = await browser();
    const r = repo();
    setWebPushSender(async () => { throw Object.assign(new Error("10.0.0.1 is private"), { name: "BlockedTarget" }); });
    await expect(sendWebPush(r.repo, [device(b.sub, { token: "https://internal.example/x" })], ev, "org1")).rejects.toThrow("internal.example is not a public address");
    setWebPushSender(async () => { throw new Error("ECONNRESET"); });
    await expect(sendWebPush(r.repo, [device(b.sub, { token: "https://internal.example/x" })], ev, "org1")).rejects.toThrow("Could not reach internal.example");
  });

  it("does nothing without devices and refuses when not configured", async () => {
    const r = repo();
    await sendWebPush(r.repo, [], ev, "org1");
    await expect(sendWebPush(r.repo, [device(null)], ev, "org1")).rejects.toThrow(/not configured/);
  });
});
