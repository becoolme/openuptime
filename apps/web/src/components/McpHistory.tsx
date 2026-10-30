import { useEffect, useState } from "react";
import { api, type McpHistory as History } from "../lib/api";
import { t } from "../lib/i18n";

const ms = (value: number | null) => value == null ? "—" : `${Math.round(value)} ms`;
export function McpTimingChart({ rows, stage }: { rows: History["results"]; stage: string }) {
  const points = rows.slice(0, 120).reverse();
  const value = (row: History["results"][number]) => stage === "total" ? row.latencyMs : row.mcp.timings[stage];
  const values = points.map(value).filter((n): n is number => typeof n === "number");
  if (!values.length) return <p className="muted">{t("No timings for this stage.")}</p>;
  const max = Math.max(1, ...values);
  const regions = [...new Set(points.map((row) => row.region ?? "auto"))];
  const colors = ["var(--accent)", "var(--warn)", "#9575cd", "#42a5f5", "#ef5350"];
  const x = (i: number) => 20 + i * 660 / Math.max(1, points.length - 1);
  return <>
    <svg viewBox="0 0 700 170" role="img" aria-label={t("MCP stage latency history")} style={{ width: "100%", height: 180 }}>
      <title>{t("MCP stage latency history")} · {stage}</title>
      <path d="M20 10V145H685" fill="none" stroke="var(--line)" />
      <text x={24} y={14} fontSize={11} fill="currentColor">{ms(max)}</text>
      {regions.map((region, regionIndex) => {
        let started = false;
        const path = points.map((row, i) => {
          if ((row.region ?? "auto") !== region) return "";
          const n = value(row);
          if (typeof n !== "number") { started = false; return ""; }
          const command = started ? "L" : "M"; started = true;
          return `${command}${x(i).toFixed(1)} ${(145 - n / max * 120).toFixed(1)}`;
        }).join(" ");
        return <g key={region} stroke={colors[regionIndex % colors.length]} fill={colors[regionIndex % colors.length]}>
          <path d={path} fill="none" strokeWidth={2} />
          {points.map((row, i) => (row.region ?? "auto") === region && typeof value(row) === "number" ? <circle key={row.id} cx={x(i)} cy={145 - value(row)! / max * 120} r={2}><title>{new Date(row.checkedAt).toLocaleString()} · {region} · {ms(value(row)!)} · {row.ok ? t("OK") : t("Failed")}</title></circle> : null)}
        </g>;
      })}
    </svg>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>{regions.map((region, i) => <span key={region} style={{ color: colors[i % colors.length] }}>● {region}</span>)}</div>
    <p className="muted">{t("Up to 120 latest recorded checks, ordered by time. Missing stage samples leave gaps.")}</p>
  </>;
}

export default function McpHistory({ id }: { id: string }) {
  const [days, setDays] = useState<7 | 30>(7);
  const [report, setReport] = useState<History | null>(null);
  const [stage, setStage] = useState("total");
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let active = true; setBusy(true); setError(""); setReport(null);
    api.mcpHistory(id, days).then((data) => { if (active) setReport(data); }).catch((e) => { if (active) setError((e as Error).message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [id, days, reload]);
  const stages = Object.keys(report?.metrics.stages ?? {});
  const shownStage = stage === "total" || stages.includes(stage) ? stage : "total";
  return <section className="card sect">
    <h3>{t("MCP stage history")}</h3>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
      <select className="in" style={{ width: "auto" }} aria-label={t("History window")} value={days} onChange={(e) => setDays(Number(e.target.value) as 7 | 30)}><option value={7}>{t("7 days")}</option><option value={30}>{t("30 days")}</option></select>
      <button className="btn" disabled={busy} onClick={() => setReload((n) => n + 1)}>{busy ? t("Loading…") : t("Refresh history")}</button>
    </div>
    {error && <p className="err" role="alert">{error}</p>}
    {report && <>
      <p className="muted">{t("Metrics use all retained samples in this window, not an SLA. Raw tool results and credentials are never included.")}</p>
      <label className="fld">{t("Timing stage")}<select className="in" value={shownStage} onChange={(e) => setStage(e.target.value)}><option value="total">{t("Total")}</option>{stages.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
      <McpTimingChart rows={report.results} stage={shownStage} />
      <div style={{ overflowX: "auto" }}><table style={{ width: "100%" }}><thead><tr><th>{t("Stage")}</th><th>{t("Samples")}</th><th>p50</th><th>p95</th></tr></thead><tbody>
        <tr><td>{t("Total")}</td><td>{report.metrics.samples}</td><td>{ms(report.metrics.p50)}</td><td>{ms(report.metrics.p95)}</td></tr>
        {Object.entries(report.metrics.stages).map(([name, metric]) => <tr key={name}><td><code>{name}</code></td><td>{metric.samples}</td><td>{ms(metric.p50)}</td><td>{ms(metric.p95)}</td></tr>)}
      </tbody></table></div>
      <details style={{ marginTop: 12 }}><summary>{t("Historical stage timings")}</summary><div style={{ maxHeight: 360, overflow: "auto" }}><table style={{ width: "100%" }}><thead><tr><th>{t("Time")}</th><th>{t("Region")}</th><th>{t("Result")}</th><th>{t("Stage timings")}</th></tr></thead><tbody>{report.results.map((row) => <tr key={row.id}><td>{new Date(row.checkedAt).toLocaleString()}</td><td>{row.region ?? "auto"}</td><td>{row.ok ? t("OK") : row.error}</td><td>{Object.entries(row.mcp.timings).map(([name, n]) => <div key={name}><code>{name}</code>: {ms(n)}</div>)}</td></tr>)}</tbody></table></div></details>
      <h4 style={{ marginTop: 16 }}>{t("Schema change timeline")}</h4>
      {report.changes.length ? <ol>{report.changes.map((event) => <li key={event.id}><time>{new Date(event.checkedAt).toLocaleString()}</time> <span className="chip">{t(event.severity)}</span><ul>{(event.drift.length ? event.drift.map((d) => `${d.tool}${d.path ?? ""}: ${d.message}`) : event.changes).map((change, i) => <li key={i}>{change}</li>)}</ul></li>)}</ol> : <p className="muted">{t("No schema changes in this history window.")}</p>}
    </>}
  </section>;
}
