import { useEffect, useId, useRef, useState } from "react";

export type Option<V extends string | number> = { value: V; label: string };

/** Custom dropdown used instead of the system <select> so every picker looks the same in the app and on the landing page. */
export default function Select<V extends string | number>({
  value, options, onChange, className = "", label, icon, compact,
}: {
  value: V;
  options: Option<V>[];
  onChange: (v: V) => void;
  className?: string;
  label?: string;
  icon?: React.ReactNode;
  /** small pill for the top bar instead of a full-width form field */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const cur = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open]);

  const pick = (v: V) => { setOpen(false); if (v !== value) onChange(v); };
  const onKey = (e: React.KeyboardEvent) => {
    const i = active < 0 ? Math.max(0, options.findIndex((o) => o.value === value)) : active;
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { setOpen(true); setActive(i); return; }
      setActive((i + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
    } else if ((e.key === "Enter" || e.key === " ") && open && active >= 0) {
      e.preventDefault();
      pick(options[active].value);
    }
  };

  return (
    <div className={`dd${compact ? " dd-c" : ""}`} ref={root} onKeyDown={onKey}>
      <button
        type="button"
        className={`dd-btn ${compact ? "" : className}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => { setOpen((o) => !o); setActive(-1); }}
      >
        {icon}
        <span className="dd-cur">{cur?.label}</span>
        <svg className="dd-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <ul className="dd-menu" id={id} role="listbox">
          {options.map((o, i) => (
            <li key={String(o.value)}>
              <button
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={i === active ? "act" : ""}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.value)}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
