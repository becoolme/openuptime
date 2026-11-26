import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { fmtTime } from "../lib/time";
import type { Run } from "../lib/runs";

/** A bar never gets narrower than this, so a long history scrolls instead of squeezing the bars away. */
export const MIN_BAR_PX = 10;

/** The slice of `count` bars that is on screen, given the scroll position; both ends inclusive. */
export function visibleRange(count: number, scrollLeft: number, viewWidth: number, scrollWidth: number): [number, number] {
  if (count === 0) return [0, 0];
  const w = scrollWidth / count;
  if (!(w > 0)) return [0, count - 1];
  const first = Math.min(count - 1, Math.max(0, Math.floor(scrollLeft / w + 0.01)));
  const last = Math.min(count - 1, Math.max(first, Math.ceil((scrollLeft + viewWidth) / w - 0.01) - 1));
  return [first, last];
}

/** Response time of the runs, oldest first. Shows as many bars as fit; older ones are a scroll away. */
export default function ResponseChart({ runs, max, regionName }: { runs: Run[]; max: number; regionName: (id: string) => string }) {
  const box = useRef<HTMLDivElement>(null);
  // follow the newest bar while the reader is at the right edge; leave the place alone once they scrolled back
  const atEnd = useRef(true);
  const [range, setRange] = useState<[number, number]>([0, Math.max(0, runs.length - 1)]);
  const [scrolls, setScrolls] = useState(false);
  const measure = () => {
    const el = box.current;
    if (!el) return;
    setScrolls(el.scrollWidth > el.clientWidth + 1);
    atEnd.current = el.scrollWidth - el.clientWidth - el.scrollLeft < 4;
    setRange(visibleRange(runs.length, el.scrollLeft, el.clientWidth, el.scrollWidth));
  };
  const last = runs[runs.length - 1]?.at;
  useLayoutEffect(() => {
    const el = box.current;
    if (el && atEnd.current) el.scrollLeft = el.scrollWidth;
    measure();
  }, [runs.length, last]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  });
  // the tip sits outside the scroll box's clipping: place it on the bar it belongs to
  const place = (e: React.MouseEvent<HTMLDivElement>) => {
    const tip = e.currentTarget.querySelector<HTMLElement>(".rt-tip");
    if (!tip) return;
    const r = e.currentTarget.getBoundingClientRect();
    tip.style.left = `${r.left + r.width / 2}px`;
    tip.style.top = `${r.top}px`;
  };
  const [a, b] = range;
  return (
    <>
      <div className="rt-scroll" ref={box} onScroll={measure} tabIndex={scrolls ? 0 : undefined} aria-label={t("Response time")}>
        <div className="bars rt" style={{ minWidth: runs.length * MIN_BAR_PX }}>
          {runs.map((run) => (
            <div key={run.rows[0].id} className="rt-col" onMouseEnter={place}>
              <i className={run.state === "up" ? "" : run.state === "down" ? "d" : "w"} style={{ height: `${Math.max(4, ((run.latencyMs ?? max) / max) * 100)}%` }} />
              <span className="rt-tip">
                <b>{run.latencyMs != null ? `${run.rows.length > 1 ? "avg " : ""}${run.latencyMs} ms` : "—"}</b>
                <small>{run.rows.length > 1 ? `${run.okCount}/${run.rows.length} OK` : run.rows[0].ok ? "OK" : run.rows[0].statusCode ?? "Failed"} · {fmtTime(run.at, { seconds: true })}</small>
                {run.rows.length > 1 && run.rows.map((r) => (
                  <small key={r.id} className={`rt-r${r.ok ? "" : " d"}`}>{regionName(r.region ?? "auto")} · {r.ok ? `${r.latencyMs ?? "—"} ms` : r.error ?? t("Failed")}</small>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
      {runs.length > 1 && (
        <div className="ax"><span>{fmtTime(runs[a].at, { seconds: true })}</span><span>{fmtTime(runs[Math.min(b, runs.length - 1)].at, { seconds: true })}</span></div>
      )}
    </>
  );
}
