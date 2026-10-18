import type { PushDevice, Repo } from "@openuptime/repo";
import { tr, isLang, type Lang } from "./mail-i18n";

/**
 * Apple Push Notification service sender. Credentials are one APNs Auth Key (.p8) with its key id, the Apple team id and
 * the app's bundle id (the `apns-topic`). The hosts are fixed, so requests deliberately skip the SSRF guard.
 */

export type ApnsConfig = { key: string; keyId: string; teamId: string; bundleId: string };
type ApnsEnv = { APNS_KEY?: string; APNS_KEY_ID?: string; APNS_TEAM_ID?: string; APNS_BUNDLE_ID?: string };

let config: ApnsConfig | null = null;

/** Env values are constant per deployment, so a module-level config is safe in a Worker isolate. Configured only when all four are set. */
export function configureApns(env: ApnsEnv) {
  const key = env.APNS_KEY?.trim().replace(/\\n/g, "\n");
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const bundleId = env.APNS_BUNDLE_ID?.trim();
  const next = key && keyId && teamId && bundleId ? { key, keyId, teamId, bundleId } : null;
  if (JSON.stringify(next) !== JSON.stringify(config)) tokenCache = null;
  config = next;
}
export const apnsConfigured = () => config !== null;

// ---- provider token --------------------------------------------------------------------------------------------------

const b64url = (bytes: Uint8Array | string) => {
  const u8 = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function importKey(pem: string) {
  const der = atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  const bytes = Uint8Array.from(der, (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", bytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** A signed ES256 JWT: header {alg, kid}, claims {iss: team, iat}. */
export async function buildProviderToken(cfg: Pick<ApnsConfig, "key" | "keyId" | "teamId">, nowSec: number): Promise<string> {
  const input = `${b64url(JSON.stringify({ alg: "ES256", kid: cfg.keyId }))}.${b64url(JSON.stringify({ iss: cfg.teamId, iat: nowSec }))}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await importKey(cfg.key), new TextEncoder().encode(input));
  // WebCrypto returns the raw r||s form that JWS wants
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

/** APNs rejects tokens older than an hour and throttles refreshing more often than every 20 minutes: reuse one for 50. */
const TOKEN_TTL_SEC = 50 * 60;
let tokenCache: { token: string; at: number } | null = null;

export async function providerToken(cfg: ApnsConfig, nowMs = Date.now()): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  if (tokenCache && now - tokenCache.at < TOKEN_TTL_SEC) return tokenCache.token;
  const token = await buildProviderToken(cfg, now);
  tokenCache = { token, at: now };
  return token;
}
const forgetProviderToken = () => { tokenCache = null; };

// ---- transport -------------------------------------------------------------------------------------------------------

export type ApnsRequest = { host: string; path: string; headers: Record<string, string>; body: string };
export type ApnsResponse = { status: number; body: string };
export type ApnsTransport = (req: ApnsRequest) => Promise<ApnsResponse>;

const HOSTS = { production: "api.push.apple.com", sandbox: "api.development.push.apple.com" } as const;
const REQUEST_TIMEOUT_MS = 10_000;

const onWorkers = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

/** Cloudflare Workers' fetch speaks HTTP/2 to APNs. */
const fetchTransport: ApnsTransport = async (r) => {
  const res = await fetch(`https://${r.host}${r.path}`, { method: "POST", headers: r.headers, body: r.body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  return { status: res.status, body: await res.text().catch(() => "") };
};

type H2Session = { request(h: Record<string, string>): any; close(): void; destroy(): void; on(e: string, f: (...a: any[]) => void): void; closed: boolean; destroyed: boolean; setTimeout(ms: number, f: () => void): void; unref(): void };
const sessions = new Map<string, H2Session>();

/** Node's fetch (undici) is HTTP/1.1 only and APNs requires HTTP/2, so the Node/Docker server uses node:http2 directly. */
const http2Transport: ApnsTransport = async (r) => {
  // a computed specifier keeps bundlers for Workers from resolving it; this branch never runs there
  const http2 = (await import(/* @vite-ignore */ "node:" + "http2")) as unknown as { connect(url: string): H2Session };
  let session = sessions.get(r.host);
  if (!session || session.closed || session.destroyed) {
    const s = http2.connect(`https://${r.host}`);
    s.on("error", () => { sessions.delete(r.host); s.destroy(); });
    s.on("close", () => sessions.delete(r.host));
    s.setTimeout(60_000, () => s.close());
    s.unref();
    sessions.set(r.host, s);
    session = s;
  }
  const s = session;
  return new Promise<ApnsResponse>((resolve, reject) => {
    const req = s.request({ ":method": "POST", ":path": r.path, ...r.headers });
    const chunks: Buffer[] = [];
    let status = 0;
    const timer = setTimeout(() => { req.close(); reject(new Error("timeout")); }, REQUEST_TIMEOUT_MS);
    req.on("response", (h: Record<string, unknown>) => { status = Number(h[":status"] ?? 0); });
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => { clearTimeout(timer); resolve({ status, body: Buffer.concat(chunks).toString("utf8") }); });
    req.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
    req.setEncoding?.("utf8");
    req.end(r.body);
  });
};

let transport: ApnsTransport | null = null;
/** Tests inject a stub; null restores the automatic choice. */
export const setApnsTransport = (t: ApnsTransport | null) => { transport = t; };
const activeTransport = () => transport ?? (onWorkers ? fetchTransport : http2Transport);

// ---- payload ---------------------------------------------------------------------------------------------------------

export type PushEvent = {
  kind: "incident.opened" | "incident.resolved" | "incident.reminder" | "incident.escalated";
  incident: { id: string; title: string; startedAt?: Date; resolvedAt?: Date | null };
  reason?: string;
  test?: true;
  slow?: true;
  monitor: { id?: string; name: string; target: string };
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const downtime = (ms: number, lang: Lang) => {
  const m = Math.max(1, Math.round(ms / 60000));
  const [h, min] = lang === "zh-CN" ? ["小时", "分钟"] : ["h", "min"];
  const sp = lang === "zh-CN" ? "" : " ";
  return m < 60 ? `${m}${sp}${min}` : `${Math.floor(m / 60)}${sp}${h}${m % 60 ? ` ${m % 60}${sp}${min}` : ""}`;
};

/** The notification for one language. Stays far below APNs' 4 KB limit: free text is clipped. */
export function buildPayload(ev: PushEvent, orgId: string, lang: Lang) {
  const opened = ev.kind !== "incident.resolved";
  const still = ev.kind === "incident.reminder" || ev.kind === "incident.escalated";
  const name = clip(ev.monitor.name, 100);
  let title: string;
  let body: string;
  if (ev.test) {
    title = tr(lang, "Your channel is connected");
    body = tr(lang, "This is a test alert from OpenUptime");
  } else if (opened) {
    title = tr(lang, still ? (ev.slow ? "{name} is still responding slowly" : "{name} is still down") : ev.slow ? "{name} is responding slowly" : "{name} is down", { name });
    body = clip(ev.reason || ev.monitor.target || ev.incident.title, 300);
  } else {
    title = tr(lang, "{name} has recovered", { name });
    const s = ev.incident.startedAt;
    const r = ev.incident.resolvedAt;
    body = s && r ? tr(lang, "Down for {duration}", { duration: downtime(r.getTime() - s.getTime(), lang) }) : tr(lang, "Checks are passing again and the incident is resolved.");
  }
  return {
    aps: {
      alert: { title, body },
      sound: "default",
      "thread-id": ev.monitor.id ?? ev.incident.id,
      "interruption-level": opened && !ev.test ? "time-sensitive" : "active",
    },
    incidentId: ev.incident.id,
    monitorId: ev.monitor.id ?? null,
    organizationId: orgId,
    kind: ev.test ? "test" : ev.kind,
  };
}

// ---- sending ---------------------------------------------------------------------------------------------------------

/** APNs reasons that mean the token will never work again. */
const DEAD = new Set(["Unregistered", "BadDeviceToken", "DeviceTokenNotForTopic"]);

type Outcome = "ok" | "dead" | "failed";

async function sendOne(cfg: ApnsConfig, jwt: string, device: PushDevice, payload: unknown, collapseId: string, expiresAt: number): Promise<{ outcome: Outcome; detail?: string }> {
  let res: ApnsResponse;
  try {
    res = await activeTransport()({
      host: HOSTS[device.environment === "sandbox" ? "sandbox" : "production"],
      path: `/3/device/${device.token}`,
      headers: {
        authorization: `bearer ${jwt}`,
        "apns-topic": cfg.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-collapse-id": collapseId,
        "apns-expiration": String(expiresAt),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // the transport's own message is not trusted to be free of the request path (the token)
    return { outcome: "failed", detail: (e as Error)?.name === "TimeoutError" || (e as Error)?.message === "timeout" ? "APNs timed out" : "Could not reach APNs" };
  }
  if (res.status === 200) return { outcome: "ok" };
  let apnsReason = "";
  try { apnsReason = String((JSON.parse(res.body) as { reason?: unknown }).reason ?? "").slice(0, 60).replace(/[^A-Za-z]/g, ""); } catch { /* no body */ }
  if (res.status === 410 || DEAD.has(apnsReason)) return { outcome: "dead" };
  if (res.status === 403) forgetProviderToken();
  return { outcome: "failed", detail: `APNs responded ${res.status}${apnsReason ? ` (${apnsReason})` : ""}` };
}

/**
 * Push one event to `devices`. No devices: nothing happens. Dead tokens are removed. Throws only when every device that
 * was tried failed for a reason worth retrying (or the sender is misconfigured); the message never holds a token or key.
 */
export async function sendPush(repo: Pick<Repo, "deletePushDeviceByToken">, devices: PushDevice[], ev: PushEvent, orgId: string) {
  if (!devices.length) return;
  const cfg = config;
  if (!cfg) throw new Error("Push notifications are not configured on this server");
  let jwt: string;
  try {
    jwt = await providerToken(cfg);
  } catch {
    throw new Error("APNs key could not be used (check APNS_KEY)");
  }
  const collapseId = ev.incident.id;
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const results = await Promise.all(
    devices.map(async (d) => {
      const lang: Lang = isLang(d.locale) ? d.locale : "en";
      const r = await sendOne(cfg, jwt, d, buildPayload(ev, orgId, lang), collapseId, expiresAt);
      if (r.outcome === "dead") await repo.deletePushDeviceByToken(d.token).catch((e) => console.error("could not remove a dead push device", (e as Error).message));
      return r;
    }),
  );
  const failed = results.filter((r) => r.outcome === "failed");
  const okOrDead = results.length - failed.length;
  if (failed.length && !okOrDead) throw new Error(`${failed[0].detail}${failed.length > 1 ? ` (${failed.length} devices)` : ""}`);
  if (failed.length) console.error(`push: ${failed.length}/${results.length} devices failed (${failed[0].detail})`);
}
