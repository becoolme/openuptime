import { useState } from "react";
import { api, type TimeCoverage as Report } from "../lib/api";
import { t } from "../lib/i18n";

export default function TimeCoverage({ id }: { id: string }) {
  const [days, setDays] = useState<7 | 30>(7);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    setBusy(true); setError("");
    try { setReport(await api.timeCoverage(id, days)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function download() {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `monitor-${id}-time-coverage.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="card sect">
    <h3>{t("Time coverage")}</h3>
    <p className="muted">{t("Time inferred from fresh checks, not exact outage duration. Missing history stays unknown. Maintenance is included.")}</p>
    <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
      <select className="in" aria-label={t("Coverage window")} value={days} disabled={busy} onChange={(e) => { setDays(Number(e.target.value) as 7 | 30); setReport(null); }}>
        <option value={7}>{t("7 days")}</option><option value={30}>{t("30 days")}</option>
      </select>
      <button className="btn" disabled={busy} onClick={load}>{busy ? t("Loading…") : t("Load report")}</button>
    </div>
    {error && <p className="err" role="alert">{error}</p>}
    {report && <>
      <p className="muted mono">{report.from} → {report.to}</p>
      <dl>{Object.entries(report.states).map(([state, ms]) => <div key={state} style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <dt>{t(state)}</dt><dd>{t("{n} hours").replace("{n}", (ms / 3_600_000).toFixed(3))}</dd>
      </div>)}</dl>
      <p className="muted">{t("Paused and unknown time are separate. The export includes exact millisecond totals and observed maintenance labels.")}</p>
      <button className="btn sm" onClick={download}>{t("Export JSON report")}</button>
    </>}
  </section>;
}
