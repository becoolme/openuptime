import { useSyncExternalStore } from "react";

/** Whether server addresses are hidden, kept per browser so a screen share or screenshot does not leak them. */
export const HIDE_IPS_KEY = "ou.servers.hideIps";

const subs = new Set<() => void>();
let hidden: boolean | null = null;

function read(): boolean {
  try { return localStorage.getItem(HIDE_IPS_KEY) === "1"; } catch { return false; }
}

export function hideIps(): boolean {
  if (hidden === null) hidden = read();
  return hidden;
}

export function setHideIps(v: boolean) {
  hidden = v;
  try { if (v) localStorage.setItem(HIDE_IPS_KEY, "1"); else localStorage.removeItem(HIDE_IPS_KEY); } catch { /* private mode: this page only */ }
  subs.forEach((f) => f());
}

function subscribe(f: () => void) {
  subs.add(f);
  // another tab flipped it
  const onStorage = (e: StorageEvent) => { if (e.key === HIDE_IPS_KEY) { hidden = read(); f(); } };
  window.addEventListener("storage", onStorage);
  return () => { subs.delete(f); window.removeEventListener("storage", onStorage); };
}

/** The switch, shared by every server view on the page. */
export function useHideIps(): [boolean, (v: boolean) => void] {
  return [useSyncExternalStore(subscribe, hideIps, () => false), setHideIps];
}
