/**
 * Remembers that a detail page was opened from the "All projects" view, so its back link can return there instead of
 * leaving the visitor in the one project the page belongs to. Storage is injected so the rule is testable.
 */
export const FROM_ALL_KEY = "ou_from_all";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const browserStore = (): Store | null => {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; }
};

/** The visitor leaves the All view for a detail page. */
export function rememberAll(store: Store | null = browserStore()) {
  try { store?.setItem(FROM_ALL_KEY, "1"); } catch { /* storage may be blocked */ }
}

/** The visitor chose a project or workspace themselves: forget it. */
export function forgetAll(store: Store | null = browserStore()) {
  try { store?.removeItem(FROM_ALL_KEY); } catch { /* storage may be blocked */ }
}

/** True once, when the back link should restore the All view; the memory is consumed. */
export function takeAll(store: Store | null = browserStore()): boolean {
  try {
    if (store?.getItem(FROM_ALL_KEY) !== "1") return false;
    store.removeItem(FROM_ALL_KEY);
    return true;
  } catch { return false; }
}
