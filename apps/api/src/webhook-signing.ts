/**
 * Signing for the generic webhook channel, in the Standard Webhooks format (https://www.standardwebhooks.com):
 *
 *   webhook-id:        unique per message, the same on every retry of it, so receivers can drop duplicates
 *   webhook-timestamp: Unix seconds when this attempt was sent, so receivers can refuse replays
 *   webhook-signature: "v1," + base64(HMAC-SHA256(key, "{id}.{timestamp}.{body}"))
 *
 * The secret is "whsec_" followed by the base64 of the key bytes. Existing libraries for the format (Svix, standardwebhooks)
 * verify these requests as they are.
 */

const PREFIX = "whsec_";
const SHAPE = /^whsec_((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/;

/** Whether this is a usable secret: "whsec_" and 24 to 64 key bytes, base64 encoded. */
export function isWebhookSecret(secret: string): boolean {
  const b64 = SHAPE.exec(secret)?.[1];
  if (!b64) return false;
  const bytes = (b64.length / 4) * 3 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  return bytes >= 24 && bytes <= 64;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** A new random signing secret (32 key bytes). */
export function newWebhookSecret(): string {
  return PREFIX + b64(crypto.getRandomValues(new Uint8Array(32)));
}

/** The `webhook-signature` value for one message. */
export async function signWebhook(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  const raw = Uint8Array.from(atob(secret.slice(PREFIX.length)), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return `v1,${b64(mac)}`;
}

/** Headers for one attempt. The id and timestamp are always sent; the signature only when the channel has a secret. */
export async function webhookHeaders(id: string, body: string, secret?: string, now = Date.now()): Promise<Record<string, string>> {
  const timestamp = Math.floor(now / 1000);
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    ...(secret ? { "webhook-signature": await signWebhook(secret, id, timestamp, body) } : {}),
  };
}
