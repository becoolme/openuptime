import { t } from "../lib/i18n";
import { fmtTime } from "../lib/time";
import type { DiagnosisKind, IncidentDiagnostics } from "../lib/api";

const KIND: Record<DiagnosisKind, string> = {
  dns: "Name lookup failed",
  connect: "Could not connect",
  tls: "TLS or certificate error",
  timeout: "Timed out",
  http: "Unexpected HTTP response",
  assertion: "Response content check failed",
  blocked: "Target not allowed",
  other: "Other error",
};

const pre = { maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, margin: "6px 0 0" } as const;

/** What each region saw on the check that opened the incident: the failure kind, redirects, timings, headers and body. */
export default function IncidentDiagnosis({ d }: { d: IncidentDiagnostics }) {
  const failing = d.regions.filter((r) => !r.ok);
  const shown = failing.length ? failing : d.regions;
  return (
    <div className="card cc">
      <div className="cc-h"><h3>{t("What the check saw")}</h3><span className="faint" style={{ fontSize: 13 }}>{fmtTime(d.checkedAt, { utc: true, seconds: true })} UTC</span></div>
      {d.regions.length > 1 && (
        <>
          <div className="rr res th"><span>{t("Region")}</span><span>{t("Result")}</span><span>{t("Code")}</span><span>{t("Latency")}</span><span>{t("Error")}</span></div>
          {d.regions.map((r) => (
            <div className="rr res" key={r.region}>
              <span className="mono">{r.region}</span>
              <span><span className={`pill ${r.ok ? "up" : "down"}`}>{t(r.ok ? "Passed" : "Failed")}</span></span>
              <span className="mono">{r.statusCode ?? "—"}</span>
              <span className="mono">{r.latencyMs != null ? `${r.latencyMs} ms` : "—"}</span>
              <span className="faint mono rr-err" title={r.error ?? ""}>{r.error ?? ""}</span>
            </div>
          ))}
        </>
      )}
      {shown.map((r) => {
        const g = r.diagnosis;
        return (
          <div key={r.region} style={{ marginTop: 14 }}>
            <p style={{ margin: 0 }}>
              <b>{g ? t(KIND[g.kind] ?? "Other error") : t(r.ok ? "Passed" : "Failed")}</b>
              {d.regions.length > 1 && <span className="chip" style={{ marginLeft: 8 }}>{r.region}</span>}
            </p>
            {r.error && <p className="faint mono" style={{ margin: "4px 0 0", fontSize: 13, wordBreak: "break-word" }}>{r.error}</p>}
            {g && (
              <div className="kv" style={{ marginTop: 10 }}>
                {g.timings?.firstByteMs != null && <div><span>{t("First byte")}</span><b className="mono">{g.timings.firstByteMs} ms</b></div>}
                {g.timings && <div><span>{t("Total time")}</span><b className="mono">{g.timings.totalMs} ms</b></div>}
                {g.redirects?.map((h, k) => (
                  <div key={k}><span>{k === 0 ? t("Redirects") : ""}</span><b className="mono">{h.status} {h.url}{h.location ? ` → ${h.location}` : ""} · {h.ms} ms</b></div>
                ))}
                {Object.entries(g.headers ?? {}).map(([k, v], i) => (
                  <div key={k}><span>{i === 0 ? t("Response headers") : ""}</span><b className="mono">{k}: {v}</b></div>
                ))}
              </div>
            )}
            {g?.body && (
              <>
                <small className="faint" style={{ display: "block", marginTop: 10 }}>{t("Start of the response body")}</small>
                <pre className="code2" style={pre}>{g.body}</pre>
              </>
            )}
          </div>
        );
      })}
      <small className="faint" style={{ display: "block", marginTop: 12 }}>{t("Kept with the incident for your team only. Request credentials, cookies and values that look like secrets are removed.")}</small>
    </div>
  );
}
