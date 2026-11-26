import { toast } from "@openuptime/ui/toast";
import { t } from "./i18n";

/** How often a running tab asks the server whether a newer version was deployed. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

type Worker = Pick<ServiceWorker, "state" | "postMessage" | "addEventListener">;
export interface Reg {
  waiting: Pick<ServiceWorker, "postMessage"> | null;
  installing: Worker | null;
  update(): Promise<unknown>;
  addEventListener(type: "updatefound", cb: () => void): void;
}

/**
 * Tells `prompt` when a new version is waiting, now and then every CHECK_EVERY_MS for as long as it keeps waiting.
 * `hasController` is false on the very first visit: that install is not an update and must not ask anything.
 * Returns a function that stops the checks.
 */
export function watchForUpdates(reg: Reg, prompt: () => void, hasController: () => boolean, now = Date.now): () => void {
  const announce = () => {
    if (reg.waiting && hasController()) prompt();
  };
  announce(); // a worker left waiting by an earlier visit

  reg.addEventListener("updatefound", () => {
    const w = reg.installing;
    w?.addEventListener("statechange", () => {
      if (w.state === "installed") announce();
    });
  });

  let last = now();
  const check = () => {
    last = now();
    // update() only re-fetches /sw.js; a failure (offline, server down) is retried at the next check
    reg.update().then(announce, () => {});
  };
  const timer = setInterval(check, CHECK_EVERY_MS);
  // timers pause while a laptop sleeps or a phone tab is frozen: catch up as soon as the tab is visible again
  const onVisible = () => {
    if (document.visibilityState === "visible" && now() - last >= CHECK_EVERY_MS) check();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** The longest "Refresh" waits for a newer version to download before it applies the one it already has. */
export const LATEST_WAIT_MS = 5000;

/**
 * Asks the server for the newest version and waits until a worker that was found has finished installing, or until `ms` passes.
 * A version deployed after the prompt appeared is then the one that gets activated, so one click lands on the newest.
 */
function latestSettled(reg: Pick<Reg, "installing" | "update">, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    reg.update().then(() => {
      const w = reg.installing;
      if (!w || (w.state !== "parsed" && w.state !== "installing")) return finish();
      w.addEventListener("statechange", () => {
        if (w.state !== "parsed" && w.state !== "installing") finish();
      });
    }, finish);
  });
}

/** Activates the newest waiting worker and reloads once it has taken over (or after a short grace period). */
export async function applyUpdate(
  reg: Pick<Reg, "waiting" | "installing" | "update">,
  sw: { addEventListener(type: "controllerchange", cb: () => void): void } = navigator.serviceWorker,
  reload: () => void = () => location.reload(),
): Promise<void> {
  await latestSettled(reg, LATEST_WAIT_MS);
  const waiting = reg.waiting;
  if (!waiting) return reload();
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    reload();
  };
  sw.addEventListener("controllerchange", go);
  setTimeout(go, 4000);
  waiting.postMessage({ type: "SKIP_WAITING" });
}

/** Registers /sw.js (production only, and only where service workers exist) and starts watching for new versions. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const sw = navigator.serviceWorker;
  const start = () =>
    sw
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        const prompt = () =>
          toast(t("A new version of OpenUptime is available."), "ok", {
            key: "pwa-update",
            sticky: true,
            action: { label: t("Refresh"), run: () => applyUpdate(reg) },
          });
        // give the back office a moment to mount its toast area before the first prompt
        setTimeout(() => watchForUpdates(reg, prompt, () => !!sw.controller), 3000);
      })
      .catch(() => {});
  if (document.readyState === "complete") start();
  else addEventListener("load", start, { once: true });
}
