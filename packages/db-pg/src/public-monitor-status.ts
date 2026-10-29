import type { Monitor } from "@openuptime/repo";

/** Registration risk is distinct from a service outage, including when internal incident state is down. */
export function publicMonitorStatus(m: Pick<Monitor, "type" | "status" | "paused" | "domainExpiry" | "domainExpiryWarnDays">, now = Date.now()): Monitor["status"] | "unknown" {
  if (m.type !== "domain" || m.paused) return m.status;
  const expiry = m.domainExpiry;
  if (!expiry || expiry.state === "unknown" || !expiry.expiresAt) return "unknown";
  const until = Date.parse(expiry.cacheUntil), expires = Date.parse(expiry.expiresAt);
  if (!Number.isFinite(until) || until <= now || !Number.isFinite(expires)) return "unknown";
  return expires - now <= (m.domainExpiryWarnDays ?? 30) * 864e5 ? "degraded" : "up";
}
