import { useBusy } from "@openuptime/ui/use-busy";

export default function UseBusyDemo() {
  const [busy, run] = useBusy();
  return (
    <div className="demo-row">
      <button className="btn primary" disabled={busy} onClick={() => run(() => new Promise((r) => setTimeout(r, 1500)))}>
        {busy ? "Saving…" : "Save (1.5 s)"}
      </button>
      <span className="muted mono">busy: {String(busy)}</span>
    </div>
  );
}
