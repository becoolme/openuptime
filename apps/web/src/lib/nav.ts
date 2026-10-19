/** In-app navigation: the back-office Router listens for popstate and swaps the page without reloading. */
import { lp } from "./locale-path";
import { prefetch, resetCache } from "./api";
import { resolveRoute } from "./routes";
import { isAllProjects, setProjectCookie } from "./scope";

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

/** Works in one project from now on (the switcher and the badges of the "All projects" view). */
export function selectProject(id: string) {
  document.cookie = setProjectCookie(id);
  switchScope();
}

/**
 * A detail page opened from the "All projects" view (or from a link) belongs to one project: from here on work in that
 * project, so what the page does and what the sidebar shows agree. The page itself stays where it is.
 */
export function adoptProject(id: string | null | undefined) {
  if (!id || !isAllProjects()) return;
  document.cookie = setProjectCookie(id);
  resetCache();
  window.dispatchEvent(new Event("ou:project"));
  window.dispatchEvent(new Event("ou:changed"));
}
