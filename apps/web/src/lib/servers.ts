import type { Server, ServerSnapshot } from "./api";
import { t } from "./i18n";

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

/** A span as one unit, the largest that fits: "41d", "5h", "14m", "30s" (localized). */
export function fmtSpan(sec: number | undefined | null): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
  const [n, k] = sec >= 86400 ? [sec / 86400, "{n}d"] : sec >= 3600 ? [sec / 3600, "{n}h"] : sec >= 60 ? [sec / 60, "{n}m"] : [sec, "{n}s"];
  return t(k).replace("{n}", String(Math.floor(n)));
}

/** "14m ago" for a timestamp, localized; "—" before the first one. */
export const since = (iso: string | null, now = Date.now()) =>
  iso ? t("{d} ago").replace("{d}", fmtSpan(Math.max(0, (now - new Date(iso).getTime()) / 1000))) : "—";

/** "4 cores · 16 GB": what the machine has, from what it reported. */
export const specLabel = (s: Pick<Server, "cores" | "memTotal">) =>
  [s.cores > 0 && t("{n} cores").replace("{n}", String(s.cores)), s.memTotal > 0 && fmtBytes(s.memTotal)].filter(Boolean).join(" · ");

export type Disk = ServerSnapshot["disks"][number];
/** The mount closest to full: the one a reader has to watch. */
export const fullestDisk = (disks: Disk[]): (Disk & { pct: number }) | null =>
  disks.reduce<(Disk & { pct: number }) | null>((best, d) => {
    const p = pct(d.used, d.total);
    return !best || p > best.pct ? { ...d, pct: p } : best;
  }, null);

export const memPct = (s: Pick<Server, "snapshot" | "memTotal">) => pct(s.snapshot?.metrics.memUsed ?? 0, s.memTotal);

/** Usage at which a server counts as running hot in the list. Shown only; it sends no alert. */
export const HOT_PCT = 90;

/** What runs hot on an online server: "CPU 92%", "Memory 91%", "Disk / 95%". */
export function hotReasons(s: Pick<Server, "online" | "snapshot" | "memTotal">): string[] {
  const m = s.snapshot?.metrics;
  if (!s.online || !m) return [];
  const out: string[] = [];
  if (m.cpu >= HOT_PCT) out.push(`${t("CPU")} ${Math.round(m.cpu)}%`);
  const mem = memPct(s);
  if (mem >= HOT_PCT) out.push(`${t("Memory")} ${Math.round(mem)}%`);
  const d = fullestDisk(s.snapshot?.disks ?? []);
  if (d && d.pct >= HOT_PCT) out.push(`${t("Disk")} ${d.mount} ${Math.round(d.pct)}%`);
  return out;
}

export type ServerState = "waiting" | "offline" | "hot" | "online";
export const serverState = (s: Pick<Server, "online" | "lastSeenAt" | "snapshot" | "memTotal">): ServerState =>
  !s.lastSeenAt ? "waiting" : !s.online ? "offline" : hotReasons(s).length ? "hot" : "online";

export type IpRow = { family: "IPv4" | "IPv6"; ip: string; iface: string };
/** Every address the server reported, IPv4 first, each once, with the interface it sits on. */
export function ipRows(snapshot: ServerSnapshot | null | undefined): IpRow[] {
  const ifs = snapshot?.interfaces ?? [];
  const seen = new Set<string>();
  const rows: IpRow[] = [];
  for (const family of ["IPv4", "IPv6"] as const) {
    for (const i of ifs) {
      for (const ip of family === "IPv4" ? i.ipv4 : i.ipv6) {
        if (seen.has(ip)) continue;
        seen.add(ip);
        rows.push({ family, ip, iface: i.name });
      }
    }
  }
  return rows;
}

/** An address with every digit hidden, keeping only its shape. */
export const maskIp = (ip: string) => (!ip ? "" : ip.includes(":") ? "••••:••••::••••" : "•••.•••.•••.•••");

export type ServerFilter = "all" | "hot" | "offline" | `tag:${string}`;
/** The list after the pill filter and the search box: the search matches the name, host name, any address or a tag. */
export function filterServers<T extends Pick<Server, "name" | "hostname" | "tags" | "online" | "lastSeenAt" | "snapshot" | "memTotal">>(list: T[], q: string, f: ServerFilter): T[] {
  const needle = q.trim().toLowerCase();
  return list.filter((s) => {
    const st = serverState(s);
    if (f === "hot" && st !== "hot") return false;
    if (f === "offline" && st !== "offline") return false;
    if (f.startsWith("tag:") && !s.tags.includes(f.slice(4))) return false;
    if (!needle) return true;
    return [s.name, s.hostname, ...s.tags, ...ipRows(s.snapshot).map((r) => r.ip)].some((v) => v.toLowerCase().includes(needle));
  });
}
