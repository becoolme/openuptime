import { useEffect, useState } from "react";
import type { ToastKind } from "../lib/toast";

type Item = { id: number; message: string; kind: ToastKind };
let seq = 0;

/** Stack of short-lived notifications at the top of the page. */
export default function Toaster() {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const { message, kind } = (e as CustomEvent<{ message: string; kind: ToastKind }>).detail;
      const id = ++seq;
      setItems((l) => [...l.slice(-3), { id, message, kind }]);
      setTimeout(() => setItems((l) => l.filter((x) => x.id !== id)), kind === "err" ? 6000 : 3500);
    };
    window.addEventListener("ou:toast", on);
    return () => window.removeEventListener("ou:toast", on);
  }, []);
  if (!items.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((i) => <div key={i.id} className={`toast ${i.kind}`}>{i.message}</div>)}
    </div>
  );
}
