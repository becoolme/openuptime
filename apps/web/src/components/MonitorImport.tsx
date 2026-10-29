import { useState } from "react";
import { t } from "../lib/i18n";

export type ImportReport = {
  preview: boolean; created: number; duplicates: number; ready: number; canImport: boolean; autoChannelCount: number;
  destination: { organizationId: string; projectId: string; projectName: string | null };
  capacity: { active: number; max: number; requested: number } | null;
  report: { index: number; name: string | null; source?: string; sourceId?: string; status: string; error?: string; warnings: string[]; existing?: { name: string; target: string } }[];
};

/** Keep the parsed file in memory; the preview response never contains supplied credentials. */
const message = (value: string) => value.startsWith("Unsupported fields: ") ? `${t("Unsupported fields")}: ${value.slice(20)}` : t(value);

export default function MonitorImport({ raw, onClose, onImported }: { raw: string; onClose: () => void; onImported: () => void }) {
  const [source, setSource] = useState(() => { try { return JSON.parse(raw).source ?? "json"; } catch { return "json"; } });
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(preview: boolean) {
    setBusy(true); setError("");
    try {
      const parsed = JSON.parse(raw);
      const monitors = Array.isArray(parsed) ? parsed : parsed.monitors;
      const res = await fetch(`/api/monitors/import${preview ? "/preview" : ""}`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, monitors, ...(!preview && report ? { destination: report.destination } : {}) }),
      });
      // a proxy or the body limit can answer with plain text (413): show that, not a JSON parse error
      const result = await res.json().catch(() => null);
      if (!result) throw new Error(res.status === 413 ? t("The file is too large to import. Split it into smaller files.") : t("Import failed"));
      if (!res.ok) {
        if (result.report) setReport({ ...result, preview: true });
        throw new Error(result.code === "monitor_limit" ? t("You have reached your plan's active monitor limit. Pause a monitor or upgrade your plan.") : result.error ?? t("Import failed"));
      }
      setReport(result);
      if (!preview) onImported();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="modal" role="dialog" aria-modal="true" aria-label={t("Import preview")}>
    <div className="card mform" style={{ maxWidth: 820 }}>
      <div className="mhead"><h2>{t("Import preview")}</h2><button className="icon-btn mclose" disabled={busy} aria-label={t("Close")} onClick={onClose}>×</button></div>
      <label className="fld">{t("Source namespace")}
        <input className="in mono" maxLength={80} value={source} disabled={busy || Boolean(report && !report.preview)} onChange={(e) => { setSource(e.target.value); setReport(null); }} />
      </label>
      <p className="muted">{t("Reuse the same source and source IDs on retries. Existing monitors are skipped, never overwritten. Per-row sources take precedence.")}</p>
      <div className="acts"><button className="btn" disabled={busy} onClick={() => run(true)}>{t("Preview import")}</button>
        {report?.preview && <button className="btn primary" disabled={busy || !report.canImport || !report.ready} onClick={() => run(false)}>{t("Import ready monitors")}</button>}
        <button className="btn" disabled={busy} onClick={onClose}>{t("Close")}</button>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      {report && <>
        <p>{report.preview ? t("No monitors have been created.") : t("Import complete.")} {t("Ready")}: {report.ready} · {t("Imported")}: {report.created} · {t("Duplicates")}: {report.duplicates}</p>
        {report.destination.projectName && <p className="muted">{t("Destination project")}: <strong>{report.destination.projectName}</strong></p>}
        <p className="muted">{t("Destination auto-enabled channels")}: {report.autoChannelCount}</p>
        {report.capacity && <p className="err">{t("Import exceeds the active monitor limit")}: {report.capacity.active} + {report.capacity.requested} &gt; {report.capacity.max}</p>}
        <div style={{ maxHeight: "45vh", overflow: "auto" }}><table style={{ width: "100%" }}><thead><tr><th>{t("Monitor")}</th><th>{t("Status")}</th><th>{t("Details")}</th></tr></thead><tbody>
          {report.report.map((r) => <tr key={r.index}><td>#{r.index + 1} {r.name}<div className="muted mono" style={{ fontSize: 11, overflowWrap: "anywhere" }}>{r.source}/{r.sourceId}</div></td><td>{t(({ ready: "Ready", created: "Imported", duplicate: "Duplicates", skipped: "skipped" } as Record<string, string>)[r.status] ?? r.status)}</td><td>{r.error ? message(r.error) : null}{r.existing && <div className="muted">{t("Already imported as")}: {r.existing.name} ({r.existing.target})</div>}<ul>{r.warnings.map((w) => <li key={w}>{message(w)}</li>)}</ul></td></tr>)}
        </tbody></table></div>
      </>}
    </div>
  </div>;
}
