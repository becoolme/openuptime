/** Fire-and-forget notification shown by <Toaster />. */
export type ToastKind = "ok" | "err";
export const toast = (message: string, kind: ToastKind = "ok") => {
  window.dispatchEvent(new CustomEvent("ou:toast", { detail: { message, kind } }));
};
