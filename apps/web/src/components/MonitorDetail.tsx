import { adoptProject, backToAll, navigate } from "../lib/nav";
import { t } from "../lib/i18n";
import { useEffect, useState } from "react";
import { ago, api, type Channel, type CheckResult, type Incident, type Monitor, type RegionStat, type SpotCheck } from "../lib/api";
import { pollWhileVisible } from "../lib/poll";
import { groupRuns } from "../lib/runs";
import { MonitorForm } from "./Monitors";

type Detail = Monitor & { results: CheckResult[]; regionStats: RegionStat[]; incidents: Incident[]; stats: { uptime24h: number | null; uptime7d: number | null; avg24h: number | null; p95: number | null } };
const every = (s: number) => (s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);

export default function MonitorDetail({ id }: { id: string }) {
  const [m, setM] = useState<Detail | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState("");
  const [err, setErr] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  // the answer to the last single-region request, shown under the regions table
  const [spot, setSpot] = useState<{ region: string; run: NonNullable<SpotCheck["result"]> } | null>(null);
  const [spotFrom, setSpotFrom] = useState("");
  const act = async (name: string, fn: () => Promise<unknown>) => {
    setPending(name);
    setErr("");
    try { await fn(); } catch (e) { setErr((e as Error).message); setPending(""); return; }
    setPending("");
  };
  // opened from the "All projects" view: from here on work in the monitor's own project, then read what depends on it
  const load = () => api.monitor(id).then((d) => { adoptProject(d.projectId); setM(d as Detail); });
  useEffect(() => {
    load().then(() => api.channels().then(setChannels)).catch(() => {});
    api.regions().then((r) => setNames(Object.fromEntries(r.regions.map((x) => [x.id, x.name])))).catch(() => {});
    return pollWhileVisible(load, 10000);
  }, [id]);
  if (!m) return <p className="muted">{t("Loading…")}</p>;

  const configured = m.regions?.length ? m.regions : ["auto"];
  // a multi-region check records one row per region at the same moment: the chart and the table treat those as one run
  const runs = groupRuns(m.results, configured);
  const chrono = [...runs].reverse();
  const max = Math.max(1, ...chrono.map((r) => r.latencyMs ?? 0));
  const lat = m.results.map((r) => r.latencyMs).filter((v): v is number => typeof v === "number");
  const routed = m.channelIds?.length ? channels.filter((c) => m.channelIds!.includes(c.id)) : channels.filter((c) => c.enabled);
  const regionName = (id: string) => (id === "auto" ? t("Auto") : (names[id] ?? id));
  // the card appears once a monitor checks from somewhere other than the default
  const multi = configured.some((r) => r !== "auto") || m.regionStats.some((r) => r.region !== "auto");
  // configured regions first, in the order the monitor lists them; then any region that only has history
  const stats: RegionStat[] = [
    ...configured.map((r) => m.regionStats.find((s) => s.region === r) ?? { region: r, checks24h: 0, uptime24h: null, avgLatency24h: null, last: null }),
    ...m.regionStats.filter((s) => !configured.includes(s.region)),
  ].filter((s, i, all) => all.findIndex((x) => x.region === s.region) === i);
  const probable = m.type === "http" || m.type === "tcp";
  const places = Object.keys(names);
  const showRegion = m.results.some((r) => r.region && r.region !== "auto");
  // the newest 30 rows, whole runs only where they fit; `lead` marks the first row of a run, which carries the time
  const rows = runs.flatMap((run) => run.rows.map((r, i) => ({ r, lead: i === 0, size: run.rows.length }))).slice(0, 30);
  const spotId = places.includes(spotFrom) ? spotFrom : places[0];
  const num = (v: number | null | undefined, unit: string, digits = 0) => (v == null ? "—" : <>{digits ? v.toFixed(digits) : v}<u>{unit}</u></>);
  return (
    <>
      <p className="crumb-back"><a href="/app" className="muted" onClick={backToAll}>{t("← Monitors")}</a></p>
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
          {m.type !== "heartbeat" && <button className="btn primary" disabled={!!pending} onClick={() => act("check", async () => { await api.checkNow(id); await load(); })}>{pending === "check" ? t("Checking…") : t("Check now")}</button>}
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
              {chrono.map((run) => (
                <div key={run.rows[0].id} className="rt-col">
                  <i className={run.state === "up" ? "" : run.state === "down" ? "d" : "w"} style={{ height: `${Math.max(4, ((run.latencyMs ?? max) / max) * 100)}%` }} />
                  <span className="rt-tip">
                    <b>{run.latencyMs != null ? `${run.rows.length > 1 ? "avg " : ""}${run.latencyMs} ms` : "—"}</b>
                    <small>{run.rows.length > 1 ? `${run.okCount}/${run.rows.length} OK` : run.rows[0].ok ? "OK" : run.rows[0].statusCode ?? "Failed"} · {new Date(run.at).toLocaleTimeString()}</small>
                    {run.rows.length > 1 && run.rows.map((r) => (
                      <small key={r.id} className={`rt-r${r.ok ? "" : " d"}`}>{regionName(r.region ?? "auto")} · {r.ok ? `${r.latencyMs ?? "—"} ms` : r.error ?? t("Failed")}</small>
                    ))}
                  </span>
                </div>
              ))}
            </div>
            {chrono.length > 1 && (
              <div className="ax"><span>{new Date(chrono[0].at).toLocaleTimeString()}</span><span>{new Date(chrono[chrono.length - 1].at).toLocaleTimeString()}</span></div>
            )}
          </div>

          <div className="card cc">
            <div className="cc-h"><h3>{t("Recent checks")}</h3><span className="faint" style={{ fontSize: 13 }}>{rows.length} {t("latest")}</span></div>
            <div className={`rr res th${showRegion ? " has-rg" : ""}`}><span>{t("Time")}</span>{showRegion && <span className="rr-rg">{t("Region")}</span>}<span>{t("Result")}</span><span>{t("Code")}</span><span>{t("Latency")}</span><span>{t("Error")}</span></div>
            {rows.map(({ r, lead, size }) => (
              <div className={`rr res${showRegion ? " has-rg" : ""}${size > 1 ? " grp" : ""}${lead ? "" : " in-run"}`} key={r.id}>
                <span className="mono muted">{lead || size === 1 ? new Date(r.checkedAt).toLocaleTimeString([], { hour12: false }) : ""}</span>
                {showRegion && <span className="rr-rg" title={regionName(r.region ?? "auto")}>{regionName(r.region ?? "auto")}</span>}
                <span><span className={`pill ${r.ok ? "up" : "down"}`}>{r.ok ? t("OK") : t("Failed")}</span></span>
                <span className="mono">{r.statusCode ?? "—"}</span>
                <span className="mono">{r.latencyMs != null ? `${r.latencyMs} ms` : "—"}</span>
                <span className="faint mono rr-err" title={r.error ?? ""}>{r.error ?? ""}</span>
              </div>
            ))}
            {m.results.length === 0 && <p className="muted">{t("No checks yet.")}</p>}
          </div>
        </div>

        <div className="col">
          {probable && (multi || places.length > 1) && (
            <div className="card cc">
              <div className="cc-h"><h3>{t("Regions")}</h3><span className="faint" style={{ fontSize: 13 }}>{t("last 24 h")}</span></div>
              {stats.map((s) => (
                <div className="rr reg" key={s.region} title={s.last?.error ?? undefined}>
                  <i className={`dot ${s.last ? (s.last.ok ? "up" : "down") : "n"}`} aria-label={s.last ? (s.last.ok ? t("OK") : t("Failed")) : undefined} />
                  <span className="reg-n">{regionName(s.region)}</span>
                  <span className="mono reg-v">
                    <b>{s.uptime24h == null ? "—" : `${s.uptime24h}%`}</b>
                    <small>{s.avgLatency24h == null ? "—" : `${s.avgLatency24h} ms`}</small>
                  </span>
                </div>
              ))}
              {places.length > 1 && (
                <div className="spot">
                  <span className="faint">{t("Test once from")}</span>
                  <div className="spot-pick">
                    <select className="in" value={spotId} aria-label={t("Test once from")} disabled={!!pending} onChange={(e) => { setSpotFrom(e.target.value); setSpot(null); }}>
                      {places.map((id) => <option key={id} value={id}>{regionName(id)}</option>)}
                    </select>
                    <button className="btn sm" disabled={!!pending} onClick={() => act(`spot:${spotId}`, async () => {
                      setSpot(null);
                      const r = await api.checkNow(m.id, spotId);
                      if (r.result) setSpot({ region: spotId, run: r.result });
                    })}>{pending.startsWith("spot:") ? t("Checking…") : t("Test")}</button>
                  </div>
                  {spot && (
                    <p className="spot-out">
                      <span className={`pill ${spot.run.ok ? "up" : "down"}`}>{spot.run.ok ? t("OK") : t("Failed")}</span>{" "}
                      <b>{regionName(spot.region)}</b>
                      <span className="mono muted"> {spot.run.statusCode ?? ""}{spot.run.latencyMs != null ? ` · ${spot.run.latencyMs} ms` : ""}</span>
                      {spot.run.error && <small className="faint mono"> {spot.run.error}</small>}
                    </p>
                  )}
                  <small className="faint">{t("One-off test: it is not recorded and does not change the monitor's status.")}</small>
                </div>
              )}
            </div>
          )}

          <div className="card cc">
            <div className="cc-h"><h3>{t("Configuration")}</h3></div>
            <div className="kv">
              <div><span>{t("Type")}</span><b className="mono">{m.type.toUpperCase()}</b></div>
              {m.type === "http" && <div><span>{t("Method")}</span><b className="mono">{m.method}</b></div>}
              {m.type === "http" && <div><span>{t("Expected status")}</span><b className="mono">{m.expectedStatus}</b></div>}
              {m.type === "http" && m.expectedLocation && [301, 302, 303, 307, 308].includes(m.expectedStatus) && <div><span>{t("Redirects to")}</span><b className="mono">{m.expectedLocation}</b></div>}
              <div><span>{t("Interval")}</span><b className="mono">{every(m.intervalSec)}</b></div>
              <div><span>{t("Timeout")}</span><b className="mono">{m.timeoutMs / 1000} s</b></div>
              <div><span>{t("Failures before incident")}</span><b className="mono">{m.failureThreshold}</b></div>
              {probable && <div><span>{t("Regions")}</span><b className="mono">{configured.map(regionName).join(", ")}</b></div>}
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
