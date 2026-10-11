import { navigate } from "../lib/nav";
import { t } from "../lib/i18n";
import { useEffect, useState } from "react";
import { ago, api, type Channel, type CheckResult, type Incident, type Monitor } from "../lib/api";
import { MonitorForm } from "./Monitors";

type Detail = Monitor & { results: CheckResult[]; incidents: Incident[]; stats: { uptime24h: number | null; uptime7d: number | null; avg24h: number | null; p95: number | null } };
const every = (s: number) => (s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);

export default function MonitorDetail({ id }: { id: string }) {
  const [m, setM] = useState<Detail | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState("");
  const [err, setErr] = useState("");
  const act = async (name: string, fn: () => Promise<unknown>) => {
    setPending(name);
    setErr("");
    try { await fn(); } catch (e) { setErr((e as Error).message); setPending(""); return; }
    setPending("");
  };
  const load = () => api.monitor(id).then((d) => setM(d as Detail));
  useEffect(() => {
    load();
    api.channels().then(setChannels).catch(() => {});
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [id]);
  if (!m) return <p className="muted">{t("Loading…")}</p>;

  const chrono = [...m.results].reverse();
  const max = Math.max(1, ...chrono.map((r) => r.latencyMs ?? 0));
  const lat = chrono.map((r) => r.latencyMs).filter((v): v is number => typeof v === "number");
  const routed = m.channelIds?.length ? channels.filter((c) => m.channelIds!.includes(c.id)) : channels.filter((c) => c.enabled);
  const num = (v: number | null | undefined, unit: string, digits = 0) => (v == null ? "—" : <>{digits ? v.toFixed(digits) : v}<u>{unit}</u></>);
  return (
    <>
      <p className="crumb-back"><a href="/app" className="muted">{t("← Monitors")}</a></p>
      <div className="ph">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1 className="ph-title">{m.name} <span className={`pill ${m.status}`}>{t(m.status)}</span></h1>
          <p className="muted mono ph-sub">
            <span className="ph-url" title={m.target || m.type}>{m.type === "http" ? `${m.method} ` : ""}{m.target || m.type}</span>
          </p>
          <div className="chips">
            <span className="chip">{m.type === "heartbeat" ? "CRON" : m.type.toUpperCase()}</span>
            <span className="chip">{t("Every")} {every(m.intervalSec)}</span>
            <span className="faint chip-t">{t("checked")} {ago(m.lastCheckedAt)}</span>
          </div>
        </div>
        <div className="ph-actions">
          <button className="btn" onClick={() => setEditing(true)}>{t("Edit")}</button>
          <button className="btn" disabled={!!pending} onClick={() => act("pause", async () => { await api.updateMonitor(id, { paused: !m.paused }); await load(); })}>{pending === "pause" ? t("Saving…") : m.paused ? t("Resume") : t("Pause")}</button>
          <button className="btn primary" disabled={!!pending} onClick={() => act("check", async () => { await api.checkNow(id); await load(); })}>{pending === "check" ? t("Checking…") : t("Check now")}</button>
        </div>
      </div>

      {err && <p className="err">{err}</p>}
      {editing && <MonitorForm monitor={m} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />}

      <div className="kp">
        <div className="card"><small>{t("Uptime 24h")}</small><b>{num(m.stats.uptime24h, "%", 2)}</b></div>
        <div className="card"><small>{t("Uptime 7d")}</small><b>{num(m.stats.uptime7d, "%", 2)}</b></div>
        <div className="card"><small>{t("Avg latency")}</small><b>{num(m.stats.avg24h, "ms")}</b></div>
        <div className="card"><small>p95</small><b>{num(m.stats.p95, "ms")}</b></div>
      </div>

      <div className="cols">
        <div className="col">
          {m.type === "heartbeat" && m.heartbeatToken && (
            <div className="card cc">
              <div className="cc-h"><h3>{t("Ping URL")}</h3></div>
              <p className="mono" style={{ wordBreak: "break-all", fontSize: 13.5 }}>curl {location.origin}/api/heartbeat/{m.heartbeatToken}</p>
            </div>
          )}
          <div className="card cc">
            <div className="cc-h">
              <h3>{t("Response time")}</h3>
              <span className="faint mono" style={{ fontSize: 12.5 }}>{lat.length ? `min ${Math.min(...lat)} · avg ${Math.round(lat.reduce((a, b) => a + b, 0) / lat.length)} · max ${Math.max(...lat)} ms` : ""}</span>
            </div>
            <div className="bars rt">
              {chrono.map((r) => (
                <div key={r.id} className="rt-col">
                  <i className={r.ok ? "" : "d"} style={{ height: `${Math.max(4, ((r.latencyMs ?? max) / max) * 100)}%` }} />
                  <span className="rt-tip">
                    <b>{r.latencyMs != null ? `${r.latencyMs} ms` : "—"}</b>
                    <small>{r.ok ? "OK" : r.statusCode ?? "Failed"} · {new Date(r.checkedAt).toLocaleTimeString()}</small>
                  </span>
                </div>
              ))}
            </div>
            {chrono.length > 1 && (
              <div className="ax"><span>{new Date(chrono[0].checkedAt).toLocaleTimeString()}</span><span>{new Date(chrono[chrono.length - 1].checkedAt).toLocaleTimeString()}</span></div>
            )}
          </div>

          <div className="card cc">
            <div className="cc-h"><h3>{t("Recent checks")}</h3><span className="faint" style={{ fontSize: 13 }}>{Math.min(30, m.results.length)} {t("latest")}</span></div>
            <div className="rr res th"><span>{t("Time")}</span><span>{t("Result")}</span><span>{t("Code")}</span><span>{t("Latency")}</span><span>{t("Error")}</span></div>
            {m.results.slice(0, 30).map((r) => (
              <div className="rr res" key={r.id}>
                <span className="mono muted">{new Date(r.checkedAt).toLocaleTimeString([], { hour12: false })}</span>
                <span><span className={`pill ${r.ok ? "up" : "down"}`}>{r.ok ? t("OK") : t("Failed")}</span></span>
                <span className="mono">{r.statusCode ?? "—"}</span>
                <span className="mono">{r.latencyMs ?? "—"} ms</span>
                <span className="faint mono rr-err" title={r.error ?? ""}>{r.error ?? ""}</span>
              </div>
            ))}
            {m.results.length === 0 && <p className="muted">{t("No checks yet.")}</p>}
          </div>
        </div>

        <div className="col">
          <div className="card cc">
            <div className="cc-h"><h3>{t("Configuration")}</h3></div>
            <div className="kv">
              <div><span>{t("Type")}</span><b className="mono">{m.type.toUpperCase()}</b></div>
              {m.type === "http" && <div><span>{t("Method")}</span><b className="mono">{m.method}</b></div>}
              {m.type === "http" && <div><span>{t("Expected status")}</span><b className="mono">{m.expectedStatus}</b></div>}
              <div><span>{t("Interval")}</span><b className="mono">{every(m.intervalSec)}</b></div>
              <div><span>{t("Timeout")}</span><b className="mono">{m.timeoutMs / 1000} s</b></div>
              <div><span>{t("Failures before incident")}</span><b className="mono">{m.failureThreshold}</b></div>
              {m.keyword && <div><span>{t("Keyword")}</span><b className="mono">{m.keywordMode === "absent" ? "≠ " : ""}{m.keyword}</b></div>}
              {m.type === "heartbeat" && <div><span>{t("Grace period")}</span><b className="mono">{every(m.graceSec ?? 0)}</b></div>}
            </div>
          </div>

          <div className="card cc">
            <div className="cc-h"><h3>{t("Alert routing")}</h3><a className="btn sm" href="/app/alerting">{t("Manage")}</a></div>
            {routed.length === 0 ? <p className="muted">{t("No alert channels yet.")}</p> : routed.map((c) => (
              <div className="route" key={c.id}>
                <span className="ri"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 17V11a6 6 0 1 1 12 0v6l1.5 2h-15L6 17z" /><path d="M10 21h4" /></svg></span>
                <div><b style={{ fontWeight: 500 }}>{c.name}</b><small>{c.type}</small></div>
                <span className={`tg ${c.enabled ? "on" : ""}`} />
              </div>
            ))}
          </div>

          <div className="card cc">
            <div className="cc-h"><h3>{t("Incidents")}</h3></div>
            {m.incidents.length === 0 ? <p className="muted">{t("No incidents.")}</p> : m.incidents.map((i) => (
              <a className="route" key={i.id} href={`/app/incidents/${i.id}`}>
                <div style={{ minWidth: 0, flex: 1 }}><b style={{ fontWeight: 500 }}>{i.title}</b><small>{ago(i.startedAt)}</small></div>
                <span className={`pill ${i.status === "resolved" ? "resolved" : "down"}`}>{t(i.status)}</span>
              </a>
            ))}
          </div>

          <button className="btn danger-l" disabled={!!pending} onClick={() => confirm(t("Delete this monitor?")) && act("delete", async () => { await api.deleteMonitor(id); navigate("/app"); })}>{pending === "delete" ? t("Deleting…") : t("Delete monitor")}</button>
        </div>
      </div>
    </>
  );
}
