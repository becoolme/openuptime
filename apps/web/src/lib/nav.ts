/** In-app navigation: the back-office Router listens for popstate and swaps the page without reloading. */
import { lp } from "./locale-path";
import { prefetch, resetCache } from "./api";
import { resolveRoute } from "./routes";

export function navigate(to: string) {
  history.pushState(null, "", lp(to));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * The active workspace or project changed: drop every remembered read and have the shell and the page fetch again, without
 * reloading the document. List pages stay where they are; a detail page belongs to the old project, so it falls back to Monitors.
 */
export function switchScope() {
  resetCache();
  const hit = resolveRoute(location.pathname);
  if (!hit || hit.params.length) history.pushState(null, "", lp("/app"));
  prefetch(location.pathname);
  window.dispatchEvent(new Event("ou:scope"));
}
