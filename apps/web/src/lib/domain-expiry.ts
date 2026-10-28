import type { Monitor } from "./api";

export function monitorState(m: Monitor, now = Date.now()): { label: string; tone: string } {
  if (m.type !== "domain" || m.paused || m.status === "paused" || m.status === "pending") return { label: m.status, tone: m.status };
  const d = m.domainExpiry;
  if (!d || !Number.isFinite(Date.parse(d.cacheUntil)) || Date.parse(d.cacheUntil) <= now || !d.expiresAt || !Number.isFinite(Date.parse(d.expiresAt)) || d.state === "unknown") return { label: "Unknown expiry", tone: "degraded" };
  if (d.expiresAt && Date.parse(d.expiresAt) <= now) return { label: "Registration date passed", tone: "down" };
  if (d.state === "expiring" || Date.parse(d.expiresAt!) - now <= (m.domainExpiryWarnDays ?? 30) * 864e5) return { label: "Renewal needed", tone: "degraded" };
  return { label: "Expiry verified", tone: "up" };
}
