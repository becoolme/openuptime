import { useEffect, useState } from "react";
import type { ToastKind, ToastOptions } from "../lib/toast";
import { t } from "../lib/i18n";

type Item = { id: number; message: string; kind: ToastKind } & ToastOptions;
let seq = 0;

/** Stack of short-lived notifications at the top of the page. */
export default function Toaster() {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    const drop = (id: number) => setItems((l) => l.filter((x) => x.id !== id));
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ message: string; kind: ToastKind } & ToastOptions>).detail;
      const id = ++seq;
      setItems((l) => [...l.filter((x) => !d.key || x.key !== d.key).slice(-3), { id, ...d }]);
      if (!d.sticky) setTimeout(() => drop(id), d.kind === "err" ? 6000 : 3500);
    };
    window.addEventListener("ou:toast", on);
    return () => window.removeEventListener("ou:toast", on);
  }, []);
  if (!items.length) return null;
  const close = (id: number) => setItems((l) => l.filter((x) => x.id !== id));
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((i) => (
        <div key={i.id} className={`toast ${i.kind}${i.action || i.sticky ? " act" : ""}`}>
          <span>{i.message}</span>
          {i.action && <button className="btn sm primary" onClick={() => { close(i.id); i.action!.run(); }}>{i.action.label}</button>}
          {i.sticky && <button className="toast-x" aria-label={t("Dismiss")} onClick={() => close(i.id)}>×</button>}
        </div>
      ))}
    </div>
  );
}
