/**
 * Clock times in the app: the browser's time zone, and a 12- or 24-hour clock. "auto" leaves the clock to the
 * browser's locale; the choice is a per-browser preference, kept in localStorage.
 */

export type Clock = "auto" | "12" | "24";
const STORE = "ou_clock";

export function getClock(): Clock {
  try {
    const v = localStorage.getItem(STORE);
    return v === "12" || v === "24" ? v : "auto";
  } catch { return "auto"; }
}

export function setClock(c: Clock) {
  try { if (c === "auto") localStorage.removeItem(STORE); else localStorage.setItem(STORE, c); } catch {}
}

// a 24-hour clock is asked for as hourCycle h23: `hour12: false` shows midnight as 24:05 in some engines
const cycle = (c: Clock, auto24 = false): Intl.DateTimeFormatOptions =>
  c === "12" ? { hour12: true } : c === "24" || auto24 ? { hourCycle: "h23" } : {};

/**
 * A time of day, such as 14:05 or 2:05 PM; `seconds` adds them, `utc` shows it in UTC with a suffix. UTC times and
 * `auto24` ones (columns of log times) stay on a 24-hour clock unless 12 hours was chosen.
 */
export function fmtTime(iso: string | number | Date, o: { seconds?: boolean; utc?: boolean; auto24?: boolean; clock?: Clock } = {}): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const text = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: o.seconds ? "2-digit" : undefined, ...cycle(o.clock ?? getClock(), o.utc || o.auto24), timeZone: o.utc ? "UTC" : undefined });
  return o.utc ? `${text} UTC` : text;
}

/** A date and time, such as 3 Nov 2026, 14:05. */
export function fmtDateTime(iso: string | number | Date, o: { timeZone?: string; clock?: Clock } = {}): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short", ...cycle(o.clock ?? getClock()), timeZone: o.timeZone });
}
