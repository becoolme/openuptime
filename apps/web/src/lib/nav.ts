/** In-app navigation: the back-office Router listens for popstate and swaps the page without reloading. */
import { lp } from "./locale-path";

export function navigate(to: string) {
  history.pushState(null, "", lp(to));
  window.dispatchEvent(new PopStateEvent("popstate"));
}
