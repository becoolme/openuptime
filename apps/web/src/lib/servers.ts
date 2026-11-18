import type { Server, ServerSnapshot } from "./api";

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** 1536 → "1.5 KB": binary steps, one decimal under 10, none above. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${UNITS[i]}`;
}

/** Bytes per second as a transfer rate. */
export const fmtRate = (bps: number) => `${fmtBytes(bps)}/s`;

export const pct = (used: number, total: number) => (total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0);

/** 93_784 s → "1d 2h", 3_700 → "1h 1m". */
export function fmtUptime(sec: number | undefined): string {
  if (!sec || sec < 0) return "—";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Disk use summed over distinct devices, so a device mounted twice counts once. */
export function diskUse(disks: ServerSnapshot["disks"]): { used: number; total: number } {
  const seen = new Set<string>();
  let used = 0, total = 0;
  for (const d of disks) {
    const k = d.device && d.device !== "none" ? d.device : d.mount;
    if (seen.has(k)) continue;
    seen.add(k);
    used += d.used;
    total += d.total;
  }
  return { used, total };
}

/** The address to show next to a server's name: the first public-looking IPv4, else any IPv4, else IPv6. */
export function primaryIp(s: Pick<Server, "snapshot">): string {
  const ifs = s.snapshot?.interfaces ?? [];
  const v4 = ifs.flatMap((i) => i.ipv4);
  const v6 = ifs.flatMap((i) => i.ipv6);
  return v4.find((ip) => !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip)) ?? v4[0] ?? v6[0] ?? "";
}

export type Level = "ok" | "warn" | "bad";
export const level = (p: number): Level => (p >= 90 ? "bad" : p >= 75 ? "warn" : "ok");

/** "Ubuntu 24.04" from the platform and its version, or the OS when the platform is unknown. */
export const platformLabel = (s: Pick<Server, "platform" | "os" | "snapshot">) =>
  [s.platform || s.os, s.snapshot?.platformVersion].filter(Boolean).join(" ");
