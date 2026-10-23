/**
 * Calls `fn` every `ms` while the tab is visible. A hidden tab makes no requests; when it comes back, `fn` runs once
 * straight away so the page is fresh, and the interval carries on. Returns the function that stops it.
 */
export function pollWhileVisible(fn: () => void, ms: number): () => void {
  let stale = false;
  const timer = setInterval(() => {
    if (document.visibilityState === "hidden") stale = true;
    else fn();
  }, ms);
  const onChange = () => {
    if (document.visibilityState === "hidden") stale = true;
    else if (stale) { stale = false; fn(); }
  };
  document.addEventListener("visibilitychange", onChange);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onChange);
  };
}
