import type { DomainExpiry, Repo } from "@openuptime/repo";
import type { CheckOutcome } from "./checker";
import { domainName } from "./domain-name";
import { guardedFetch } from "./netguard";

const BOOTSTRAP = "https://data.iana.org/rdap/dns.json";
export const DOMAIN_TTL_MS = 26 * 3600_000;
export const UNKNOWN_TTL_MS = 15 * 60_000;
const BOOTSTRAP_TTL_MS = 24 * 3600_000;
const MAX_BYTES = 1024 * 1024;
type Lookup = { expiresAt: string | null; checkedAt: string; source: string | null; error: string | null };

/** RDAP responses are data, not redirects or instructions; keep both body and duration bounded. */
async function json(url: string, signal: AbortSignal): Promise<unknown> {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password || u.port && u.port !== "443") throw new Error("RDAP requires a public HTTPS endpoint");
  const { res } = await guardedFetch(url, { headers: { accept: "application/rdap+json, application/json" }, signal }, { follow: false, publicOnly: true });
  if (!res.ok) { await res.body?.cancel(); throw new Error(res.status === 429 ? "RDAP registry rate limited the lookup (429)" : `RDAP returned HTTP ${res.status}; redirects are not followed`); }
  if (!res.body) throw new Error("RDAP returned an empty response");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("RDAP response exceeds 1 MiB");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("RDAP returned invalid JSON"); }
}

export function registryUrl(raw: unknown, domain: string): string {
  const services = (raw as { services?: unknown } | null)?.services;
  if (!Array.isArray(services)) throw new Error("IANA bootstrap contains no RDAP services");
  // RFC 9224 longest label-wise suffix match. Never infer or strip a registered-domain label.
  let best = ""; let endpoint = "";
  for (const entry of services) {
    if (!Array.isArray(entry) || !Array.isArray(entry[0]) || !Array.isArray(entry[1])) continue;
    for (const suffix of entry[0]) {
      if (typeof suffix !== "string" || !(domain === suffix || domain.endsWith("." + suffix)) || suffix.length <= best.length) continue;
      const candidate = entry[1].find((value: unknown) => {
        if (typeof value !== "string") return false;
        try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && (!u.port || u.port === "443"); } catch { return false; }
      });
      if (candidate) { best = suffix; endpoint = candidate; }
    }
  }
  if (!endpoint) throw new Error("No HTTPS RDAP service is published for this domain suffix");
  return new URL(`domain/${encodeURIComponent(domain)}`, endpoint.endsWith("/") ? endpoint : endpoint + "/").toString();
}

export function expiration(raw: unknown, domain: string): string {
  const o = raw as { objectClassName?: unknown; ldhName?: unknown; events?: unknown } | null;
  if (o?.objectClassName !== "domain" || typeof o.ldhName !== "string" || o.ldhName.toLowerCase().replace(/\.$/, "") !== domain) throw new Error("RDAP did not return the requested registered domain");
  const dates = Array.isArray(o.events) ? o.events.flatMap((event: { eventAction?: unknown; eventDate?: unknown } | null) => {
    if (event?.eventAction !== "expiration" || typeof event.eventDate !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(event.eventDate)) return [];
    const time = Date.parse(event.eventDate);
    return Number.isFinite(time) ? [time] : [];
  }) : [];
  if (!dates.length) throw new Error("The registry did not publish a usable registration expiration date");
  return new Date(Math.min(...dates)).toISOString();
}

/** Shared persistent caches hold public RDAP data only; expiry is reevaluated on every check. */
export async function domainCheck(repo: Repo | undefined, input: { target: string; timeoutMs: number; domainExpiryWarnDays?: number }): Promise<CheckOutcome> {
  const started = Date.now();
  let lookup: Lookup = { expiresAt: null, checkedAt: new Date(started).toISOString(), source: null, error: null };
  let until = new Date(started + UNKNOWN_TTL_MS);
  try {
    if (!repo) throw new Error("Domain expiry checks require the local database cache");
    const domain = domainName(input.target);
    // Sequential cache transactions avoid nested connection acquisition and work with one DB connection.
    const bootstrap = await repo.cachedRdap("bootstrap:v1", async () => {
      try { return { value: { data: await json(BOOTSTRAP, AbortSignal.timeout(input.timeoutMs)) }, expiresAt: new Date(Date.now() + BOOTSTRAP_TTL_MS) }; }
      catch (e) { return { value: { error: (e as Error).message }, expiresAt: new Date(Date.now() + UNKNOWN_TTL_MS) }; }
    });
    const data = bootstrap.value as { data?: unknown; error?: string };
    if (data.error) throw new Error(data.error);
    const result = await repo.cachedRdap("domain:v1:" + domain, async () => {
      const value: Lookup = { expiresAt: null, checkedAt: new Date().toISOString(), source: null, error: null };
      try { value.source = registryUrl(data.data, domain); value.expiresAt = expiration(await json(value.source, AbortSignal.timeout(input.timeoutMs)), domain); }
      catch (e) { value.error = (e as Error).message; }
      return { value, expiresAt: new Date(Date.now() + (value.error ? UNKNOWN_TTL_MS : DOMAIN_TTL_MS)) };
    }, 24 * 3600_000); // Refresh before the next supported daily check; negative cache keeps its full backoff.
    lookup = result.value as Lookup;
    until = result.expiresAt;
    if (until.getTime() <= Date.now()) throw new Error("Cached registration data is stale");
  } catch (e) { lookup = { ...lookup, expiresAt: null, error: (e as Error).message }; }
  const days = lookup.expiresAt ? (Date.parse(lookup.expiresAt) - Date.now()) / 864e5 : null;
  const state: DomainExpiry["state"] = lookup.error || days === null ? "unknown" : days <= 0 ? "expired" : days <= (input.domainExpiryWarnDays ?? 30) ? "expiring" : "valid";
  const error = state === "unknown" ? `Domain expiry unknown: ${lookup.error ?? "No expiration date"}` : state === "expired" ? `Domain registration expiration date has passed (${lookup.expiresAt})` : state === "expiring" ? `Domain registration expires in ${Math.ceil(days!)} days (${lookup.expiresAt})` : undefined;
  return { ok: state === "valid", latencyMs: Date.now() - started, error, domainExpiry: { ...lookup, error: error ?? null, state, cacheUntil: until.toISOString() } };
}
