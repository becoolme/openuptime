/**
 * Credentials stored in channel settings and monitor headers are for workspace owners and admins. Everyone else (and
 * every API key or agent acting for them) sees a placeholder, and sending the placeholder back means "unchanged", so
 * editing a name or a toggle never needs the secret.
 */
export const MASK = "••••••••";

/** Channel settings that are credentials (the URL of a Slack or Lark hook is one: whoever has it can post). */
const SECRET_KEYS = new Set(["url", "secret", "botToken", "routingKey"]);

const maskUrl = (u: string) => {
  try {
    return `${new URL(u).origin}/${MASK}`;
  } catch {
    return MASK;
  }
};
const maskOne = (key: string, v: unknown) => (typeof v !== "string" || !v ? v : key === "url" ? maskUrl(v) : MASK);

export function maskConfig(config: Record<string, unknown> | null | undefined) {
  return Object.fromEntries(Object.entries(config ?? {}).map(([k, v]) => [k, SECRET_KEYS.has(k) ? maskOne(k, v) : v]));
}

/** `incoming` with every value that is still a placeholder replaced by what is stored. */
export function restoreConfig(incoming: Record<string, unknown>, current: Record<string, unknown> | null | undefined) {
  const cur = current ?? {};
  return Object.fromEntries(Object.entries(incoming).map(([k, v]) => [k, SECRET_KEYS.has(k) && typeof v === "string" && v === maskOne(k, cur[k]) ? cur[k] : v]));
}

export const maskHeaders = (headers: Record<string, string> | null | undefined) => Object.fromEntries(Object.keys(headers ?? {}).map((k) => [k, MASK]));

/** Placeholders keep the stored value of the same header; a placeholder with nothing behind it is dropped. */
export function restoreHeaders(incoming: Record<string, string>, current: Record<string, string> | null | undefined) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v !== MASK) out[k] = v;
    else if (current?.[k] !== undefined) out[k] = current[k]!;
  }
  return out;
}

export const sameJson = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const sortKeys = (v: unknown): unknown =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)])) : v;
