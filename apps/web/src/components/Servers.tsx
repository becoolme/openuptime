import { useEffect, useState } from "react";
import { ago, api, type Server, type ServerList } from "../lib/api";
import { t } from "../lib/i18n";
import { pollWhileVisible } from "../lib/poll";
import { toast } from "../lib/toast";
import { diskUse, fmtBytes, fmtRate, fmtUptime, level, pct, platformLabel, primaryIp } from "../lib/servers";

type Row = ServerList["servers"][number];

/** A horizontal usage bar with its percentage. */
export function Meter({ value, label }: { value: number; label?: string }) {
  const v = Math.round(value);
  return (
    <span className={`meter ${level(value)}`} title={label}>
      <i><u style={{ width: `${Math.max(2, Math.min(100, value))}%` }} /></i>
      <b>{v}%</b>
    </span>
  );
}

/** Tiny line of recent values, 0-100. */
export function Spark({ values, height = 28 }: { values: number[]; height?: number }) {
  if (values.length < 2) return <svg className="spark" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" />;
  const step = 100 / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(2)},${(height - (Math.min(100, Math.max(0, v)) / 100) * (height - 2) - 1).toFixed(2)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={`0,${height} ${pts} 100,${height}`} className="spark-fill" />
      <polyline points={pts} className="spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function ServerStatus({ s }: { s: Pick<Server, "online" | "lastSeenAt"> }) {
  if (!s.lastSeenAt) return <span className="pill">{t("Waiting")}</span>;
  return s.online ? <span className="pill up">{t("Online")}</span> : <span className="pill down">{t("Offline")}</span>;
}

const memPct = (s: Server) => pct(s.snapshot?.metrics.memUsed ?? 0, s.memTotal);
const diskPct = (s: Server) => { const d = diskUse(s.snapshot?.disks ?? []); return pct(d.used, d.total); };

export default function Servers() {
  const [data, setData] = useState<ServerList | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");

  const load = () => api.servers().then((d) => { setData(d); setErr(""); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { load(); return pollWhileVisible(load, 10_000); }, []);

  const list = (data?.servers ?? []).filter((s) => !q || `${s.name} ${s.hostname} ${primaryIp(s)} ${s.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase()));
  const online = data?.servers.filter((s) => s.online).length ?? 0;
  const offline = data?.servers.filter((s) => s.lastSeenAt && !s.online).length ?? 0;
  const current = data?.servers.find((s) => s.id === open) ?? null;
  const cols = "minmax(0,2fr) 92px minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr) 84px";

  return (
    <>
      <div className="ph">
        <div>
          <h1>{t("Servers")}</h1>
          <p className="muted">{t("CPU, memory, disks and network of your machines, reported by a small open-source agent.")}</p>
        </div>
        <div className="ph-actions"><button className="btn primary" onClick={() => setAdding(true)}>{t("Add server")}</button></div>
      </div>
      {err && <p className="err">{err}</p>}

      {data && data.servers.length === 0 && (
        <div className="empty">
          <h3>{t("No servers yet")}</h3>
          <p className="muted" style={{ margin: "8px auto 18px", maxWidth: 440 }}>{t("Run one command on a Linux server and it shows up here within a minute. The agent only sends data out; nothing listens on the server.")}</p>
          <button className="btn primary" onClick={() => setAdding(true)}>{t("Add server")}</button>
        </div>
      )}

      {data && data.servers.length > 0 && (
        <>
          <div className="srv-bar">
            <div className="chips">
              <span className="chip">{t("{n} servers").replace("{n}", String(data.servers.length))}</span>
              <span className="chip"><span className="dot up" />{t("{n} online").replace("{n}", String(online))}</span>
              {offline > 0 && <span className="chip"><span className="dot down" />{t("{n} offline").replace("{n}", String(offline))}</span>}
            </div>
            <input className="in" placeholder={t("Filter by name, IP or tag")} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="card tbl srv-tbl">
            <div className="tr th" style={{ gridTemplateColumns: cols }}>
              <span>{t("Server")}</span><span>{t("Status")}</span><span>{t("CPU")}</span><span>{t("Memory")}</span><span>{t("Disk")}</span><span>{t("Network")}</span><span>{t("Seen")}</span>
            </div>
            {list.length === 0 && <div className="tr" style={{ gridTemplateColumns: "1fr" }}><span className="muted">{t("No servers match.")}</span></div>}
            {list.map((s) => {
              const m = s.snapshot?.metrics;
              return (
                <div key={s.id} className={`tr srv-row${open === s.id ? " on" : ""}`} style={{ gridTemplateColumns: cols }} role="button" tabIndex={0}
                  onClick={() => setOpen(s.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(s.id); } }}>
                  <div>
                    <b style={{ fontWeight: 600 }}>{s.name}</b>
                    <small>{[platformLabel(s), primaryIp(s)].filter(Boolean).join(" · ") || s.hostname}</small>
                  </div>
                  <span><ServerStatus s={s} /></span>
                  {m ? <><Meter value={m.cpu} label={t("CPU")} /><Meter value={memPct(s)} label={t("Memory")} /><Meter value={diskPct(s)} label={t("Disk")} /></> : <><span className="faint">—</span><span className="faint">—</span><span className="faint">—</span></>}
                  <span className="mono srv-net">{m ? <>↓ {fmtRate(m.netRxBps)}<br />↑ {fmtRate(m.netTxBps)}</> : <span className="faint">—</span>}</span>
                  <span className="muted">{ago(s.lastSeenAt)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {current && <ServerDrawer s={current} onClose={() => setOpen(null)} />}
      {adding && <AddServer onClose={() => { setAdding(false); load(); }} />}
    </>
  );
}

function ServerDrawer({ s, onClose }: { s: Row; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const m = s.snapshot?.metrics;
  const disk = diskUse(s.snapshot?.disks ?? []);
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={s.name}>
        <div className="drawer-h">
          <div style={{ minWidth: 0 }}>
            <h2>{s.name} <ServerStatus s={s} /></h2>
            <p className="faint mono">{[s.hostname, platformLabel(s), s.arch].filter(Boolean).join(" · ")}</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t("Close")}>✕</button>
        </div>
        <div className="drawer-b">
          {m ? (
            <div className="srv-now">
              <div><small>{t("CPU")}</small><Meter value={m.cpu} /><span className="faint">{t("{n} cores").replace("{n}", String(s.cores))} · {t("load")} {m.load1.toFixed(2)}</span></div>
              <div><small>{t("Memory")}</small><Meter value={memPct(s)} /><span className="faint">{fmtBytes(m.memUsed)} / {fmtBytes(s.memTotal)}</span></div>
              <div><small>{t("Disk")}</small><Meter value={pct(disk.used, disk.total)} /><span className="faint">{fmtBytes(disk.used)} / {fmtBytes(disk.total)}</span></div>
              <div><small>{t("Swap")}</small><Meter value={pct(m.swapUsed, s.swapTotal)} /><span className="faint">{s.swapTotal ? `${fmtBytes(m.swapUsed)} / ${fmtBytes(s.swapTotal)}` : t("none")}</span></div>
            </div>
          ) : <p className="muted">{t("Waiting for the first report.")}</p>}

          {s.cpuSeries.length > 1 && (
            <section>
              <h4>{t("CPU, last hour")}</h4>
              <div className="srv-spark"><Spark values={s.cpuSeries} height={48} /></div>
            </section>
          )}

          {m && (
            <section className="kv">
              <div><span>{t("Network")}</span><b className="mono">↓ {fmtRate(m.netRxBps)} · ↑ {fmtRate(m.netTxBps)}</b></div>
              <div><span>{t("Disk I/O")}</span><b className="mono">R {fmtRate(m.diskReadBps)} · W {fmtRate(m.diskWriteBps)}</b></div>
              <div><span>{t("Uptime")}</span><b>{fmtUptime(s.snapshot?.uptimeSec)}</b></div>
              <div><span>{t("Reports every")}</span><b>{s.intervalSec}s</b></div>
              <div><span>{t("Last report")}</span><b>{ago(s.lastSeenAt)}</b></div>
            </section>
          )}

          {!!s.snapshot?.disks.length && (
            <section>
              <h4>{t("Disks")} <span className="faint">{s.snapshot.disks.length}</span></h4>
              <div className="srv-list">
                {s.snapshot.disks.map((d) => (
                  <div key={d.mount}>
                    <div className="srv-li-h"><b className="mono">{d.mount}</b><span className="faint mono">{d.fs}</span></div>
                    <Meter value={pct(d.used, d.total)} />
                    <small className="faint mono">{d.device} · {fmtBytes(d.used)} / {fmtBytes(d.total)}</small>
                  </div>
                ))}
              </div>
            </section>
          )}

          {!!s.snapshot?.interfaces.length && (
            <section>
              <h4>{t("Network interfaces")} <span className="faint">{s.snapshot.interfaces.length}</span></h4>
              <div className="srv-list">
                {s.snapshot.interfaces.map((i) => (
                  <div key={i.name}>
                    <div className="srv-li-h"><b className="mono">{i.name}</b><span className="faint mono">↓ {fmtRate(i.rxBps)} ↑ {fmtRate(i.txBps)}</span></div>
                    {[...i.ipv4.map((ip) => ["IPv4", ip]), ...i.ipv6.map((ip) => ["IPv6", ip])].map(([k, ip]) => (
                      <div key={ip} className="srv-ip"><span className="faint">{k}</span><span className="mono">{ip}</span></div>
                    ))}
                    {!i.ipv4.length && !i.ipv6.length && <small className="faint">{t("No addresses")}</small>}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
        <div className="drawer-f">
          <a className="btn primary" href={`/app/servers/${s.id}`}>{t("Open details")}</a>
        </div>
      </aside>
    </>
  );
}

/** Served from the repository, not from this deployment, so the script that runs as root is the published source. */
const INSTALL_SCRIPT = "https://raw.githubusercontent.com/becoolme/openuptime/main/apps/agent/install.sh";
const AGENT_SOURCE = "https://github.com/becoolme/openuptime/tree/main/apps/agent";
export const SERVER_DOCS = "/docs/servers";
export const UNINSTALL_CMD = `curl -fsSL ${INSTALL_SCRIPT} | sudo sh -s -- --uninstall`;

/** A shell command to copy, with its copy button. */
export function CommandBox({ cmd, label }: { cmd: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(cmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  return (
    <div className="srv-cmdbox">
      <pre className="srv-cmd mono">{cmd}</pre>
      <button type="button" className="btn sm" onClick={copy}>{copied ? t("Copied ✓") : (label ?? t("Copy"))}</button>
    </div>
  );
}

function AddServer({ onClose }: { onClose: () => void }) {
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);
  useEffect(() => { api.serverAgentKey().then((r) => setKey(r.key)).catch((e) => setErr((e as Error).message)); }, []);
  const cmd = key ? `curl -fsSL ${INSTALL_SCRIPT} | sudo sh -s -- --key ${key} --endpoint ${location.origin}` : "";

  async function rotate() {
    if (!confirm(t("Servers using the current key stop reporting until you reinstall them with the new one. Rotate the key?"))) return;
    setRotating(true);
    try { setKey((await api.rotateServerAgentKey()).key); toast(t("Agent key rotated")); }
    catch (e) { setErr((e as Error).message); }
    finally { setRotating(false); }
  }

  return (
    <div className="modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card" style={{ width: "min(640px,94vw)" }}>
        <div>
          <h3>{t("Add a server")}</h3>
          <p className="muted" style={{ marginTop: 6 }}>{t("Run this on the server as root. It installs the agent as a systemd service; the server appears here after its first report.")}</p>
        </div>
        {err && <p className="err">{err}</p>}
        {!err && <pre className="srv-cmd mono">{cmd || t("Loading…")}</pre>}
        <div className="srv-safe">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3z" /><path d="m8.8 12 2.2 2.2 4.4-4.4" /></svg>
          <div>
            <b>{t("Report-only agent")}</b>
            <p>{t("The agent only sends metrics out. It opens no port and cannot run commands, scripts or updates sent from the dashboard; the only setting it accepts back is how often to report. It runs as an unprivileged user.")}</p>
            <p><a href={AGENT_SOURCE} target="_blank" rel="noopener">{t("Read the agent and install script on GitHub")}</a></p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn primary" disabled={!cmd} onClick={() => { navigator.clipboard?.writeText(cmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}>{copied ? t("Copied ✓") : t("Copy command")}</button>
          <button className="btn" disabled={!key || rotating} onClick={rotate}>{rotating ? t("Rotating…") : t("Rotate key")}</button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>{t("Done")}</button>
        </div>
        <ul className="muted srv-notes">
          <li>{t("Linux on amd64 or arm64, with systemd. One key works for every server in this project.")}</li>
          <li>{t("Reports CPU, memory, swap, load, every mounted disk, disk I/O, and each network interface with all its IPv4 and IPv6 addresses.")}</li>
          <li>{t("The script and the agent binary download from GitHub, not from this site.")}</li>
          <li>{t("The key is a secret: anyone with it can add servers to this project and send false reports for them. Rotate it if it leaks.")}</li>
        </ul>
        <details className="srv-uninstall">
          <summary>{t("Uninstall the agent")}</summary>
          <p className="muted">{t("Run this on the server as root. It stops the service and removes the agent, its key file and the systemd unit. Then delete the server here.")}</p>
          <CommandBox cmd={UNINSTALL_CMD} />
        </details>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}><a href={SERVER_DOCS} target="_blank" rel="noopener">{t("Install and uninstall guide")}</a></p>
      </div>
    </div>
  );
}
