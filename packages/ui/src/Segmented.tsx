import { useRef } from "react";

export type Segment<V extends string | number> = {
  value: V;
  label: React.ReactNode;
  /** Shown but not selectable (a plan limit, say); pair it with a `title` that says why. */
  locked?: boolean;
  /** Faded but still selectable, for a choice the server may refuse with an explanation. */
  dim?: boolean;
  /** Tooltip. */
  title?: string;
};

/** A row of mutually exclusive choices. Keyboard: Tab reaches the chosen one, arrow keys, Home and End move and choose. */
export default function Segmented<V extends string | number>({
  value, options, onChange, label, className = "", style,
}: {
  value: V;
  options: Segment<V>[];
  onChange: (v: V) => void;
  /** Accessible name of the group, when no visible label wraps it. */
  label?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const root = useRef<HTMLDivElement>(null);
  const open = options.map((o, i) => (o.locked ? -1 : i)).filter((i) => i >= 0);
  const cur = options.findIndex((o) => o.value === value);
  const tabStop = cur >= 0 && !options[cur].locked ? cur : open[0];

  const pick = (i: number) => {
    const o = options[i];
    if (!o || o.locked) return;
    if (o.value !== value) onChange(o.value);
  };
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (!open.length) return;
    const at = open.indexOf(i);
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? open[(at + 1) % open.length]
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? open[(at - 1 + open.length) % open.length]
      : e.key === "Home" ? open[0]
      : e.key === "End" ? open.at(-1)
      : undefined;
    if (next === undefined) return;
    e.preventDefault();
    root.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
    pick(next);
  };

  return (
    <div ref={root} className={`seg${className ? ` ${className}` : ""}`} style={style} role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={i === cur}
          aria-disabled={o.locked || undefined}
          tabIndex={i === tabStop ? 0 : -1}
          className={[i === cur && "on", o.locked && "locked", o.dim && "dim"].filter(Boolean).join(" ") || undefined}
          title={o.title}
          onClick={() => pick(i)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
