import { useEffect, useRef, useState } from "react";
import { ago, api, ApiError, type ServerDetail as Detail, type ServerMetricPoint, type ServerRange } from "../lib/api";
import { t } from "../lib/i18n";
import { navigate } from "../lib/nav";
import { pollWhileVisible } from "../lib/poll";
import { fmtDateTime, fmtTime } from "../lib/time";
import { toast } from "../lib/toast";
import { diskUse, fmtBytes, fmtRate, fmtUptime, pct, platformLabel } from "../lib/servers";
import { CommandBox, Meter, SERVER_DOCS, ServerStatus, UNINSTALL_CMD } from "./Servers";

const RANGES: { k: ServerRange; sec: number }[] = [{ k: "1h", sec: 3600 }, { k: "6h", sec: 6 * 3600 }, { k: "24h", sec: 86400 }, { k: "7d", sec: 7 * 86400 }];

type Series = { label: string; cls: string; get: (p: ServerMetricPoint) => number };

/** A line chart over the selected range, with a gap where reports are missing and a readout on hover. */
function Chart({ title, points, series, from, to, stepSec, fmt, max }: {
  title: string; points: ServerMetricPoint[]; series: Series[]; from: number; to: number; stepSec: number; fmt: (v: number) => string; max?: number;
}) {
  const W = 600, H = 150;
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const ts = points.map((p) => new Date(p.t).getTime());
  const top = max ?? Math.max(1, ...points.flatMap((p) => series.map((s) => s.get(p)))) * 1.15;
  const x = (tm: number) => ((tm - from) / Math.max(1, to - from)) * W;
  const y = (v: number) => H - (Math.min(top, Math.max(0, v)) / top) * (H - 4) - 2;
  const path = (s: Series) => {
    let d = "";
    points.forEach((p, i) => {
      const gap = i === 0 || ts[i] - ts[i - 1] > stepSec * 2500;
      d += `${gap ? "M" : "L"}${x(ts[i]).toFixed(1)},${y(s.get(p)).toFixed(1)}`;
    });
    return d;
  };
  const onMove = (e: React.MouseEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !points.length) return;
    const tm = from + ((e.clientX - r.left) / r.width) * (to - from);
    let best = 0;
    ts.forEach((v, i) => { if (Math.abs(v - tm) < Math.abs(ts[best] - tm)) best = i; });
    setHover(best);
  };
  const hp = hover !== null ? points[hover] : null;
  const last = points[points.length - 1];
  return (
    <div className="card cc srv-chart">
      <div className="srv-chart-h">
        <h4>{title}</h4>
        <div className="srv-legend">
          {series.map((s) => <span key={s.label}><i className={s.cls} />{s.label} <b className="mono">{(hp ?? last) ? fmt(s.get((hp ?? last)!)) : "—"}</b></span>)}
        </div>
      </div>
      {points.length === 0 ? <div className="srv-chart-empty faint">{t("No data in this range")}</div> : (
        <div className="srv-plot">
          <svg ref={ref} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} className="grid" vectorEffect="non-scaling-stroke" />)}
            {series.map((s) => <path key={s.label} d={path(s)} className={`ln ${s.cls}`} vectorEffect="non-scaling-stroke" />)}
            {hp && <line x1={x(ts[hover!])} x2={x(ts[hover!])} y1={0} y2={H} className="cursor" vectorEffect="non-scaling-stroke" />}
          </svg>
          <span className="srv-top faint mono">{fmt(top)}</span>
          {hp && <span className="srv-at faint mono">{fmtDateTime(hp.t)}</span>}
        </div>
      )}
      <div className="ax"><span>{fmtTime(from)}</span><span>{fmtTime(to)}</span></div>
    </div>
  );
}

export default function ServerDetail({ id }: { id: string }) {
  const [range, setRange] = useState<ServerRange>("1h");
  const [s, setS] = useState<Detail | null>(null);
  const [err, setErr] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [upgrade, setUpgrade] = useState<string | null>(null);

  const load = () => api.server(id, range).then((d) => { setS(d); setErr(""); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { load(); return pollWhileVisible(load, 30_000); }, [id, range]);
  useEffect(() => { if (s) setName(s.name); }, [s?.id, s?.name]);

  if (err && !s) return <><p className="crumb-back"><a href="/app/servers" className="muted">{t("← Servers")}</a></p><p className="err">{err}</p></>;
  if (!s) return <p className="muted">{t("Loading…")}</p>;

  const m = s.snapshot?.metrics;
  const disk = diskUse(s.snapshot?.disks ?? []);
  const to = Date.now();
  const from = to - (RANGES.find((r) => r.k === range)?.sec ?? 3600) * 1000;
  const common = { points: s.points, from, to, stepSec: s.stepSec };

  async function save(patch: { name?: string; intervalSec?: number }) {
    setSaving(true);
    setUpgrade(null);
    try {
      await api.updateServer(id, patch);
      toast(t("Saved"));
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === "interval_not_allowed") setUpgrade(e.upgradeUrl ?? "");
      else toast((e as Error).message, "err");
    } finally { setSaving(false); }
  }
  async function remove() {
    if (!confirm(t("Delete this server and its history? If the agent is still installed, the server comes back at its next report."))) return;
    try { await api.deleteServer(id); navigate("/app/servers"); }
    catch (e) { toast((e as Error).message, "err"); }
  }

  return (
    <>
      <p className="crumb-back"><a href="/app/servers" className="muted">{t("← Servers")}</a></p>
      <div className="ph">
        <div>
          <div className="ph-title"><h1>{s.name}</h1><ServerStatus s={s} /></div>
          <p className="muted mono" style={{ marginTop: 6 }}>{[s.hostname, platformLabel(s), s.arch, s.cpuModel].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="ph-actions">
          <div className="seg srv-range">{RANGES.map((r) => <i key={r.k} className={range === r.k ? "on" : ""} onClick={() => setRange(r.k)}>{r.k}</i>)}</div>
        </div>
      </div>

      {m ? (
        <div className="kp">
          <div className="card"><small>{t("CPU")}<span>{t("{n} cores").replace("{n}", String(s.cores))}</span></small><b>{m.cpu.toFixed(1)}<u>%</u></b><div className="d faint">{t("load")} {m.load1.toFixed(2)} · {m.load5.toFixed(2)} · {m.load15.toFixed(2)}</div></div>
          <div className="card"><small>{t("Memory")}<span>{fmtBytes(s.memTotal)}</span></small><b>{pct(m.memUsed, s.memTotal).toFixed(0)}<u>%</u></b><div className="d faint">{fmtBytes(m.memUsed)} {t("used")} · {fmtBytes(m.memCached)} {t("cache")}</div></div>
          <div className="card"><small>{t("Disk")}<span>{fmtBytes(disk.total)}</span></small><b>{pct(disk.used, disk.total).toFixed(0)}<u>%</u></b><div className="d faint">{fmtBytes(disk.total - disk.used)} {t("free")}</div></div>
          <div className="card"><small>{t("Uptime")}<span>{ago(s.lastSeenAt)}</span></small><b>{fmtUptime(s.snapshot?.uptimeSec)}</b><div className="d faint">{t("agent")} {s.agentVersion || "—"}</div></div>
        </div>
      ) : <div className="empty" style={{ marginBottom: 24 }}><p className="muted">{t("Waiting for the first report.")}</p></div>}

      <div className="srv-charts">
        <Chart title={t("CPU")} {...common} max={100} fmt={(v) => `${v.toFixed(1)}%`} series={[{ label: t("CPU"), cls: "c1", get: (p) => p.cpu }]} />
        <Chart title={t("Memory")} {...common} max={Math.max(1, s.memTotal)} fmt={fmtBytes} series={[{ label: t("Used"), cls: "c1", get: (p) => p.memUsed }, ...(s.swapTotal ? [{ label: t("Swap"), cls: "c2", get: (p: ServerMetricPoint) => p.swapUsed }] : [])]} />
        <Chart title={t("Network")} {...common} fmt={fmtRate} series={[{ label: t("In"), cls: "c1", get: (p) => p.netRxBps }, { label: t("Out"), cls: "c2", get: (p) => p.netTxBps }]} />
        <Chart title={t("Disk I/O")} {...common} fmt={fmtRate} series={[{ label: t("Read"), cls: "c1", get: (p) => p.diskReadBps }, { label: t("Write"), cls: "c2", get: (p) => p.diskWriteBps }]} />
        <Chart title={t("Disk usage")} {...common} max={Math.max(1, disk.total)} fmt={fmtBytes} series={[{ label: t("Used"), cls: "c1", get: (p) => p.diskUsed }]} />
        <Chart title={t("Load")} {...common} fmt={(v) => v.toFixed(2)} series={[{ label: "1m", cls: "c1", get: (p) => p.load1 }]} />
      </div>

      <div className="cols srv-cols">
        <div className="card cc">
          <div className="cc-h"><h3>{t("Disks")}</h3><span className="faint">{s.snapshot?.disks.length ?? 0}</span></div>
          <div className="tbl srv-sub">
            {(s.snapshot?.disks ?? []).map((d) => (
              <div key={d.mount} className="tr" style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr)" }}>
                <div><b className="mono">{d.mount}</b><small>{d.device} · {d.fs}</small></div>
                <Meter value={pct(d.used, d.total)} />
                <span className="mono muted">{fmtBytes(d.used)} / {fmtBytes(d.total)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card cc">
          <div className="cc-h"><h3>{t("Network interfaces")}</h3><span className="faint">{s.snapshot?.interfaces.length ?? 0}</span></div>
          <div className="tbl srv-sub">
            {(s.snapshot?.interfaces ?? []).map((i) => (
              <div key={i.name} className="tr" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.6fr)" }}>
                <div><b className="mono">{i.name}</b><small>{i.mac || "—"}</small><small>↓ {fmtRate(i.rxBps)} ↑ {fmtRate(i.txBps)}</small></div>
                <div className="srv-ips">
                  {i.ipv4.map((ip) => <div key={ip} className="srv-ip"><span className="faint">IPv4</span><span className="mono">{ip}</span></div>)}
                  {i.ipv6.map((ip) => <div key={ip} className="srv-ip"><span className="faint">IPv6</span><span className="mono">{ip}</span></div>)}
                  {!i.ipv4.length && !i.ipv6.length && <span className="faint">{t("No addresses")}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="cols srv-cols">
        <div className="card cc">
          <div className="cc-h"><h3>{t("System")}</h3></div>
          <div className="kv">
            <div><span>{t("Host name")}</span><b className="mono">{s.hostname || "—"}</b></div>
            <div><span>{t("Platform")}</span><b>{platformLabel(s) || "—"}</b></div>
            <div><span>{t("Kernel")}</span><b className="mono">{s.kernel || "—"}</b></div>
            <div><span>{t("Architecture")}</span><b className="mono">{s.arch || "—"}</b></div>
            <div><span>{t("CPU")}</span><b>{s.cpuModel || "—"} · {t("{n} cores").replace("{n}", String(s.cores))}</b></div>
            <div><span>{t("Memory")}</span><b>{fmtBytes(s.memTotal)}{s.swapTotal ? ` + ${fmtBytes(s.swapTotal)} ${t("swap")}` : ""}</b></div>
            <div><span>{t("Booted")}</span><b>{s.bootTime ? fmtDateTime(s.bootTime) : "—"}</b></div>
            <div><span>{t("Agent")}</span><b className="mono">{s.agentVersion || "—"}</b></div>
            <div title={t("Servers are told apart by this ID. Cloned machines that share it report as one server.")}><span>{t("Machine ID")}</span><b className="mono">{s.machineId}</b></div>
            <div><span>{t("Added")}</span><b>{fmtDateTime(s.createdAt)}</b></div>
          </div>
        </div>
        <div className="card cc">
          <div className="cc-h"><h3>{t("Settings")}</h3></div>
          <form className="srv-form" onSubmit={(e) => { e.preventDefault(); if (name.trim() && name !== s.name) save({ name: name.trim() }); }}>
            <label className="fld"><span>{t("Name")}</span>
              <div style={{ display: "flex", gap: 8 }}><input className="in" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /><button className="btn" disabled={saving || !name.trim() || name === s.name}>{t("Save")}</button></div>
            </label>
          </form>
          <div className="fld">
            <span>{t("Report every")}</span>
            <div className="seg">{s.intervals.map((sec) => (
              <i key={sec} className={s.intervalSec === sec ? "on" : ""} title={sec < s.minIntervalSec ? t("Needs a paid plan") : undefined}
                style={sec < s.minIntervalSec ? { opacity: 0.5 } : undefined}
                onClick={() => { if (!saving && sec !== s.intervalSec) save({ intervalSec: sec }); }}>{sec < 60 ? `${sec}s` : `${sec / 60}m`}</i>
            ))}</div>
            <p className="faint" style={{ fontSize: 13, marginTop: 6 }}>
              {s.minIntervalSec > 30 ? t("Reporting every 30 seconds needs a paid plan.") : t("The agent picks up a new interval at its next report.")}
              {upgrade !== null && <> <span className="err">{t("Your plan does not allow this interval.")}</span>{upgrade && <> <a href={upgrade}>{t("Upgrade")}</a></>}</>}
            </p>
          </div>
          {s.monitorStatus && <p className="faint" style={{ fontSize: 13 }}>{t("Offline alerts go through a heartbeat monitor, so this server's alerts follow the project's alert channels.")}{s.monitorId && <> <a href={`/app/monitors/${s.monitorId}`}>{t("Open monitor")}</a></>}</p>}
          <div className="fld" style={{ borderTop: "1px solid var(--line)", paddingTop: 16, marginTop: 8 }}>
            <span>{t("Remove this server")}</span>
            <p className="faint" style={{ fontSize: 13, margin: "0 0 8px" }}>
              {t("First uninstall the agent on the server, then delete the server here. Deleted while the agent still runs, the server comes back at its next report.")}{" "}
              <a href={`${SERVER_DOCS}#uninstall`} target="_blank" rel="noopener">{t("Guide")}</a>
            </p>
            <CommandBox cmd={UNINSTALL_CMD} label={t("Copy uninstall command")} />
            <div style={{ marginTop: 12 }}><button className="btn" style={{ color: "var(--down)" }} onClick={remove}>{t("Delete server")}</button></div>
          </div>
        </div>
      </div>
    </>
  );
}
