/** Fire-and-forget notification shown by <Toaster />. */
export type ToastKind = "ok" | "err";

export interface ToastOptions {
  /** a toast with the same key replaces the one already showing instead of stacking */
  key?: string;
  /** stays until dismissed instead of fading after a few seconds */
  sticky?: boolean;
  action?: { label: string; run: () => void };
}

export const toast = (message: string, kind: ToastKind = "ok", opts: ToastOptions = {}) => {
  window.dispatchEvent(new CustomEvent("ou:toast", { detail: { message, kind, ...opts } }));
};
