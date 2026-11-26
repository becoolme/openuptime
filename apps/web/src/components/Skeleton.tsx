import { t } from "../lib/i18n";

/** A few grey text lines, for a note or paragraph that is still loading. */
export function SkeletonLines({ widths = ["70%", "45%"], height = 13 }: { widths?: (number | string)[]; height?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label={t("Loading…")}>
      {widths.map((w, i) => <i className="sk" key={i} aria-hidden="true" style={{ width: w, height, marginTop: i ? 9 : 0 }} />)}
    </div>
  );
}

/** The shape of a detail page in grey: back link, title, an optional row of figures, then cards. */
export function SkeletonPage({ back, kpis = 0, cards = 2 }: { back: { href: string; label: string }; kpis?: number; cards?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label={t("Loading…")}>
      <p className="crumb-back"><a href={back.href} className="muted">{back.label}</a></p>
      <div className="ph" aria-hidden="true">
        <div style={{ flex: 1 }}><i className="sk" style={{ width: 260, height: 32 }} /><i className="sk" style={{ width: "min(440px, 80%)", height: 13, marginTop: 12 }} /></div>
      </div>
      {kpis > 0 && (
        <div className="kp" aria-hidden="true">
          {Array.from({ length: kpis }, (_, i) => <div className="card" key={i}><i className="sk" style={{ width: 70, height: 11 }} /><i className="sk" /></div>)}
        </div>
      )}
      {Array.from({ length: cards }, (_, i) => (
        <div className="card cc" key={i} aria-hidden="true" style={{ marginBottom: 16 }}>
          <i className="sk" style={{ width: 130, height: 15 }} />
          <i className="sk" style={{ height: 110, marginTop: 16, borderRadius: 8 }} />
        </div>
      ))}
    </div>
  );
}
