import { useEffect, useMemo, useState } from "react";
import { api, type Server, type ServerAlerts, type ServerDetail, type ServerList } from "../lib/api";
import { useHideIps } from "../lib/hide-ips";
import { t } from "../lib/i18n";
import { pollWhileVisible } from "../lib/poll";
import { toast } from "@openuptime/ui/toast";
import {
  filterServers, fmtBytes, fmtRate, fmtSpan, fullestDisk, hotReasons, ipRows, level, maskIp, memPct, pct, platformLabel,
  primaryIp, serverState, since, specLabel, type ServerFilter,
} from "../lib/servers";
import { HideIpsButton, MuteButton, OfflineAlerts } from "./ServerAlerts";
import { SkeletonRows } from "@openuptime/ui/skeleton";
import Modal from "@openuptime/ui/modal";
import EmptyState from "@openuptime/ui/empty-state";
import PageHeader from "@openuptime/ui/page-header";

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

/** The value above a thin bar, coloured at 75% and 90%: a cell of the servers table. */
function Gauge({ value, text }: { value: number; text?: string }) {
  return (
    <span className={`gauge ${level(value)}`}>
      <b>{text ?? `${Math.round(value)}%`}</b>
      <i><u style={{ width: `${Math.max(1, Math.min(100, value))}%` }} /></i>
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

export function ServerStatus({ s }: { s: Pick<Server, "online" | "lastSeenAt"> & Partial<Pick<Server, "snapshot" | "memTotal">> }) {
  const st = serverState({ snapshot: null, memTotal: 0, ...s });
  if (st === "waiting") return <span className="pill">{t("Waiting")}</span>;
  if (st === "offline") return <span className="pill down">{t("Offline")}</span>;
  if (st === "hot") return <span className="pill warn">{t("High usage")}</span>;
  return <span className="pill up">{t("Online")}</span>;
}

function Chevron() {
  return <svg className="srv-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>;
}

/** A server's tags, left out while addresses are hidden: a tag such as a customer or a region tells as much as an IP. */
const TagChips = ({ tags, hide }: { tags: string[]; hide: boolean }) => (hide ? null : <>{tags.map((x) => <span key={x} className="srv-tag">{x}</span>)}</>);

/** "Debian 12 · 4 cores · 16 GB · 203.0.113.7": what the machine is, in one line. */
const subtitle = (s: Server, hide: boolean) => {
  const ip = primaryIp(s);
  return [platformLabel(s), specLabel(s), ip && (hide ? maskIp(ip) : ip)].filter(Boolean).join(" · ") || s.hostname;
};

/** Under the status pill: when it last reported, or what runs hot. */
function statusLine(s: Server) {
  const st = serverState(s);
  if (st === "waiting") return t("No report yet");
  if (st === "hot") return hotReasons(s).join(" · ");
  if (st === "offline") return t("Last seen {d}").replace("{d}", since(s.lastSeenAt));
  return since(s.lastSeenAt);
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function Stats({ servers }: { servers: Row[] }) {
  const reporting = servers.filter((s) => s.online && s.snapshot);
  const hot = servers.filter((s) => serverState(s) === "hot");
  const offline = servers.filter((s) => serverState(s) === "offline")
    .sort((a, b) => new Date(b.lastSeenAt!).getTime() - new Date(a.lastSeenAt!).getTime());
  const latest = servers.reduce<string | null>((m, s) => (s.lastSeenAt && (!m || s.lastSeenAt > m) ? s.lastSeenAt : m), null);
  const more = (n: number) => (n > 0 ? ` · +${n}` : "");
  return (
    <div className="kp srv-kp">
      <div className="card">
        <small>{t("Online")}</small>
        <b>{servers.filter((s) => s.online).length}<u>/ {servers.length}</u></b>
        <div className="d faint">{latest ? t("Latest report {d}").replace("{d}", since(latest)) : t("No report yet")}</div>
      </div>
      <div className="card">
        <small>{t("High usage")}</small>
        <b className={hot.length ? "warn" : ""}>{hot.length}</b>
        <div className={`d ${hot.length ? "warn" : "faint"}`}>{hot.length ? hot.slice(0, 2).map((s) => `${s.name} ${hotReasons(s)[0].replace(/ \d+%$/, "")}`).join(" · ") + more(hot.length - 2) : t("CPU, memory and disks under 90%")}</div>
      </div>
      <div className="card">
        <small>{t("Offline")}</small>
        <b className={offline.length ? "bad" : ""}>{offline.length}</b>
        <div className={`d ${offline.length ? "bad" : "faint"}`}>{offline.length ? `${offline[0].name} · ${t("last seen {d}").replace("{d}", since(offline[0].lastSeenAt))}${more(offline.length - 1)}` : t("Every server is reporting")}</div>
      </div>
      <div className="card">
        <small>{t("Average load")}</small>
        <b>{reporting.length ? Math.round(avg(reporting.map((s) => s.snapshot!.metrics.cpu))) : "—"}<u>% {t("CPU")}</u></b>
        <div className="d faint">{reporting.length ? t("Memory {n}% on average · online servers").replace("{n}", String(Math.round(avg(reporting.map(memPct))))) : t("No server online")}</div>
      </div>
    </div>
  );
}

const TH = () => <>
  <span>{t("Server")}</span><span>{t("Status")}</span><span>{t("CPU")}</span><span>{t("Memory")}</span><span>{t("Disk")}</span>
  <span>{t("Network in / out")}</span><span>{t("Load")}</span><span>{t("Uptime")}</span><span />
</>;

/** The list's shape in grey while the first request is out. */
function ListSkeleton() {
  return (
    <>
      <div className="kp srv-kp" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => <div className="card" key={i}><i className="sk" style={{ width: 70, height: 13 }} /><i className="sk" /><i className="sk" style={{ width: "80%", height: 12 }} /></div>)}
      </div>
      <div className="srv-bar" aria-hidden="true"><i className="sk" style={{ width: 360, height: 40, borderRadius: 10 }} /><i className="sk" style={{ width: 220, height: 32, borderRadius: 99 }} /></div>
      <div className="card srv-tbl">
        <div className="srv-scroll">
          <div className="srv-tr srv-th"><TH /></div>
          <SkeletonRows cols={9} rows={4} rowClassName="srv-tr" />
        </div>
      </div>
    </>
  );
}

export default function Servers() {
  const [data, setData] = useState<ServerList | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<ServerFilter>("all");
  const [hide] = useHideIps();

  const load = () => api.servers().then((d) => { setData(d); setErr(""); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { load(); return pollWhileVisible(load, 10_000); }, []);

  const servers = data?.servers ?? [];
  // a tag filter would show the hidden tag in its pill, so hiding falls back to all servers
  const shown: ServerFilter = hide && filter.startsWith("tag:") ? "all" : filter;
  const list = filterServers(servers, q, shown);
  const tags = useMemo(() => {
    const n = new Map<string, number>();
    servers.forEach((s) => s.tags.forEach((x) => n.set(x, (n.get(x) ?? 0) + 1)));
    return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [servers]);
  const count = (f: ServerFilter) => filterServers(servers, "", f).length;
  const pills: { f: ServerFilter; label: string; n: number }[] = [
    { f: "all", label: t("All"), n: servers.length },
    { f: "hot", label: t("High usage"), n: count("hot") },
    { f: "offline", label: t("Offline"), n: count("offline") },
    ...(hide ? [] : tags.map(([x, n]) => ({ f: `tag:${x}` as ServerFilter, label: x, n }))),
  ];
  const full = data?.maxServers != null && (data.serverCount ?? 0) >= data.maxServers;

  return (
    <>
      <PageHeader title={t("Servers")} description={t("CPU, memory, disks and network of your machines, reported by a small open-source agent.")}
        actions={<button className="btn primary" onClick={() => setAdding(true)}>{t("Add server")}</button>}>
        {data && data.maxServers != null && <p className={`srv-quota ${full ? "full" : "faint"}`}>{t("{n} of {max} servers in this workspace").replace("{n}", String(data.serverCount ?? 0)).replace("{max}", String(data.maxServers))}</p>}
      </PageHeader>
      {err && <p className="err">{err}</p>}
      {!data && !err && <ListSkeleton />}

      {data && servers.length === 0 && (
        <EmptyState className="srv-empty" title={t("No servers yet")} description={t("Run one command on a Linux server and it shows up here within a minute. The agent only sends data out; nothing listens on the server.")}
          action={<button className="btn primary" onClick={() => setAdding(true)}>{t("Add server")}</button>} />
      )}

      {data && servers.length > 0 && (
        <>
          <Stats servers={servers} />
          <div className="srv-bar">
            <label className="srv-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
              <input type="search" placeholder={t("Search host name, IP or tag")} aria-label={t("Search servers")} value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <div className="srv-pills" role="group" aria-label={t("Filter servers")}>
              {pills.map((p) => (
                <button key={p.f} type="button" className={`srv-pill${shown === p.f ? " on" : ""}`} aria-pressed={shown === p.f} onClick={() => setFilter(p.f)}>
                  {p.label} <span>{p.n}</span>
                </button>
              ))}
            </div>
            <HideIpsButton />
          </div>
          <div className="card srv-tbl">
            <div className="srv-scroll">
              <div className="srv-tr srv-th"><TH /></div>
              {list.length === 0 && <div className="srv-tr srv-none"><span className="muted">{t("No servers match.")}</span></div>}
              {list.map((s) => {
                const m = s.snapshot?.metrics;
                const st = serverState(s);
                const disk = fullestDisk(s.snapshot?.disks ?? []);
                return (
                  <div key={s.id} className={`srv-tr srv-row${open === s.id ? " on" : ""}${st === "offline" ? " off" : ""}`} role="button" tabIndex={0}
                    onClick={() => setOpen(s.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(s.id); } }}>
                    <div className="srv-name">
                      <div><b>{s.name}</b><TagChips tags={s.tags} hide={hide} /></div>
                      <small>{subtitle(s, hide)}</small>
                    </div>
                    <div className="srv-st"><ServerStatus s={s} /><small>{statusLine(s)}</small></div>
                    {m ? <>
                      <Gauge value={m.cpu} />
                      <Gauge value={memPct(s)} />
                      {disk ? <Gauge value={disk.pct} /> : <span className="faint">—</span>}
                      <span className="mono srv-net"><span>↓ {fmtRate(m.netRxBps)}</span><span>↑ {fmtRate(m.netTxBps)}</span></span>
                      <span className="mono">{m.load1.toFixed(2)}</span>
                    </> : <><span className="faint">—</span><span className="faint">—</span><span className="faint">—</span><span className="faint">—</span><span className="faint">—</span></>}
                    <span className="mono">{fmtSpan(s.snapshot?.uptimeSec)}</span>
                    <Chevron />
                  </div>
                );
              })}
            </div>
            <div className="tbl-f">
              {t("Click a row to open its summary · CPU, memory and disk turn yellow at 75% and red at 90%.")}{" "}
              <a href={SERVER_DOCS}>{t("How the agent works")}</a>
            </div>
          </div>
        </>
      )}

      {open && servers.some((s) => s.id === open) && (
        <ServerDrawer id={open} list={list.some((s) => s.id === open) ? list : servers} onSelect={setOpen} onClose={() => setOpen(null)} />
      )}
      {adding && <AddServer limit={full ? { max: data!.maxServers!, upgradeUrl: data!.upgradeUrl } : null} onClose={() => { setAdding(false); load(); }} />}
    </>
  );
}

/** One metric of the last hour as a thin area line, with the latest value at the end. */
function SparkRow({ label, values, max, now, color }: { label: string; values: number[]; max: number; now: string; color: string }) {
  const W = 400, H = 44;
  const top = Math.max(max, 1e-9);
  const pts = values.map((v, i) => `${((i / Math.max(1, values.length - 1)) * W).toFixed(1)},${(H - 2 - (Math.min(top, Math.max(0, v)) / top) * (H - 6)).toFixed(1)}`);
  return (
    <div className="srv-sp">
      <span>{label}</span>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <line x1={0} x2={W} y1={H - 1} y2={H - 1} className="base" vectorEffect="non-scaling-stroke" />
        {values.length > 1 && <>
          <polygon points={`0,${H} ${pts.join(" ")} ${W},${H}`} style={{ fill: color, opacity: 0.12 }} />
          <polyline points={pts.join(" ")} style={{ stroke: color }} vectorEffect="non-scaling-stroke" />
        </>}
      </svg>
      <b className="mono">{now}</b>
    </div>
  );
}

/** A current value with its usage bar; without `bar` the value stands alone. */
export function Tile({ k, value, bar, sub }: { k: string; value: string; bar?: number; sub: string }) {
  return (
    <div className={`srv-tile ${bar === undefined ? "" : level(bar)}`}>
      <div><small>{k}</small><b className="mono">{value}</b></div>
      {bar !== undefined && <i><u style={{ width: `${Math.max(1, Math.min(100, bar))}%` }} /></i>}
      <p>{sub}</p>
    </div>
  );
}

function ServerDrawer({ id, list, onSelect, onClose }: { id: string; list: Row[]; onSelect: (id: string) => void; onClose: () => void }) {
  const [hide] = useHideIps();
  const [detail, setDetail] = useState<ServerDetail | null>(null);
  const idx = list.findIndex((s) => s.id === id);
  const s = list[idx];
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;

  useEffect(() => {
    setDetail(null);
    const get = () => api.server(id, "1h").then(setDetail).catch(() => {});
    get();
    return pollWhileVisible(get, 30_000);
  }, [id]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.key === "ArrowUp" || e.key === "k") && prev) onSelect(prev.id);
      if ((e.key === "ArrowDown" || e.key === "j") && next) onSelect(next.id);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, onSelect, prev?.id, next?.id]);
  if (!s) return null;

  const setAlerts = (alerts: ServerAlerts) => setDetail((d) => (d ? { ...d, alerts } : d));
  const m = s.snapshot?.metrics;
  const st = serverState(s);
  const disk = fullestDisk(s.snapshot?.disks ?? []);
  const ips = ipRows(s.snapshot);
  const v4 = ips.filter((r) => r.family === "IPv4").length;
  const points = detail?.id === id ? detail.points : [];
  const lastRate = m ? fmtRate(m.netRxBps) : "—";
  const head = [platformLabel(s), specLabel(s), s.snapshot?.uptimeSec && t("up {d}").replace("{d}", fmtSpan(s.snapshot.uptimeSec)), s.lastSeenAt && t("reported {d}").replace("{d}", since(s.lastSeenAt))].filter(Boolean).join(" · ");

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer srv-drawer" role="dialog" aria-label={s.name}>
        <div className="drawer-h">
          <div style={{ minWidth: 0 }}>
            <div className="srv-dh"><h2>{s.name}</h2><ServerStatus s={s} /><TagChips tags={s.tags} hide={hide} /></div>
            <p className="faint mono">{head || s.hostname}</p>
          </div>
          <div className="srv-dnav">
            <button className="icon-btn" disabled={!prev} onClick={() => prev && onSelect(prev.id)} aria-label={t("Previous server")} title={t("Previous server")}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m3.5 10 4.5-4.5 4.5 4.5" /></svg>
            </button>
            <button className="icon-btn" disabled={!next} onClick={() => next && onSelect(next.id)} aria-label={t("Next server")} title={t("Next server")}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m3.5 6 4.5 4.5 4.5-4.5" /></svg>
            </button>
            <button className="icon-btn" onClick={onClose} aria-label={t("Close")}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m4 4 8 8M12 4l-8 8" /></svg>
            </button>
          </div>
        </div>
        <div className="drawer-b">
          {st === "offline" && (
            <div className="srv-banner bad">
              <b>{t("Offline for {d}").replace("{d}", fmtSpan((Date.now() - new Date(s.lastSeenAt!).getTime()) / 1000))}</b>
              {" "}{t("No report for three intervals in a row. The values below are from the last one.")}
            </div>
          )}
          {st === "hot" && <div className="srv-banner warn"><b>{t("High usage")}</b> · {hotReasons(s).join(" · ")}</div>}
          {!m && <p className="muted">{t("Waiting for the first report.")}</p>}

          {m && (
            <div className="srv-tiles">
              <Tile k={t("CPU")} value={`${Math.round(m.cpu)}%`} bar={m.cpu} sub={s.cores ? t("{n} cores").replace("{n}", String(s.cores)) : "—"} />
              <Tile k={t("Memory")} value={`${Math.round(memPct(s))}%`} bar={memPct(s)} sub={t("{n} total").replace("{n}", fmtBytes(s.memTotal))} />
              <Tile k={t("Disk")} value={disk ? `${Math.round(disk.pct)}%` : "—"} bar={disk?.pct ?? 0} sub={disk ? t("Fullest mount {m}").replace("{m}", disk.mount) : t("No disks reported")} />
              <Tile k={t("Load")} value={m.load1.toFixed(2)} bar={s.cores ? (m.load1 / s.cores) * 100 : 0} sub={`${t("1-minute average")} · ↓ ${lastRate}`} />
            </div>
          )}

          {m && st !== "offline" && (
            <section>
              <div className="srv-sec-h"><h3>{t("Last hour")}</h3>{detail?.stepSec ? <span>{t("One point every {n}s").replace("{n}", String(detail.stepSec))}</span> : null}</div>
              <div className="srv-sps">
                <SparkRow label={t("CPU")} color="#0f9d58" max={100} values={points.length ? points.map((p) => p.cpu) : s.cpuSeries} now={`${Math.round(m.cpu)}%`} />
                <SparkRow label={t("Memory")} color="#2f6fdb" max={100} values={points.map((p) => pct(p.memUsed, s.memTotal))} now={`${Math.round(memPct(s))}%`} />
                <SparkRow label={t("Network")} color="#7a4fd1" max={Math.max(1, ...points.map((p) => p.netRxBps + p.netTxBps))} values={points.map((p) => p.netRxBps + p.netTxBps)} now={fmtRate(m.netRxBps + m.netTxBps)} />
              </div>
            </section>
          )}

          {ips.length > 0 && (
            <section>
              <div className="srv-sec-h"><h3>{t("IP addresses")}</h3><span>{t("{a} IPv4 · {b} IPv6").replace("{a}", String(v4)).replace("{b}", String(ips.length - v4))}</span></div>
              <div className="srv-iplist">
                {ips.map((r) => (
                  <div key={r.ip}><i className={r.family === "IPv4" ? "v4" : "v6"}>{r.family}</i><span>{hide ? maskIp(r.ip) : r.ip}</span><small>{r.iface}</small></div>
                ))}
              </div>
            </section>
          )}

          {!!s.snapshot?.disks.length && (
            <section>
              <div className="srv-sec-h"><h3>{t("Disks and mounts")}</h3><span>{t("{n} mounts").replace("{n}", String(s.snapshot.disks.length))}</span></div>
              <div className="srv-disks">
                {s.snapshot.disks.map((d) => {
                  const p = pct(d.used, d.total);
                  return (
                    <div key={d.mount} className={level(p)}>
                      <div><b>{d.mount}</b><small>{d.device} · {fmtBytes(d.used)} / {fmtBytes(d.total)}</small></div>
                      <i><u style={{ width: `${Math.max(1, p)}%` }} /></i>
                      <span>{Math.round(p)}%</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section>
            <div className="srv-sec-h"><h3>{t("Offline alerts")}</h3></div>
            {detail?.id === id
              ? <OfflineAlerts serverId={id} monitorId={detail.monitorId} alerts={detail.alerts} onChange={setAlerts} footerMute />
              : <p className="faint srv-al-note">{t("Loading…")}</p>}
          </section>
        </div>
        <div className="drawer-f srv-df">
          <a className="btn primary" href={`/app/servers/${s.id}`}>{t("Open details")}</a>
          {detail?.id === id && <MuteButton serverId={id} alerts={detail.alerts} onChange={setAlerts} />}
          <a className="btn" href={`/app/servers/${s.id}#settings`}>{t("Edit")}</a>
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

// install.sh refuses these in a name or tags, so the command never needs more than single quotes
const UNSAFE_TEXT = /["'$`\\\u0000-\u001f\u007f]/;
const shellWord = (v: string) => (/^[A-Za-z0-9._,:@%+=/-]+$/.test(v) ? v : `'${v}'`);

function AddServer({ onClose, limit }: { onClose: () => void; limit: { max: number; upgradeUrl: string | null } | null }) {
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  useEffect(() => { api.serverAgentKey().then((r) => setKey(r.key)).catch((e) => setErr((e as Error).message)); }, []);
  // a self-hosted dashboard on plain http (a LAN without TLS) needs the script's explicit opt-in
  const plainHttp = location.protocol === "http:" && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const tagList = [...new Set(tags.split(",").map((x) => x.trim()).filter(Boolean))];
  const optionErr = UNSAFE_TEXT.test(name) || UNSAFE_TEXT.test(tags) ? t("A name or tag may not hold quotes, $, backticks or backslashes.")
    : tagList.length > 20 || tagList.some((x) => x.length > 32) ? t("Use at most 20 tags, each up to 32 characters.") : "";
  const options = [name.trim() && `--name ${shellWord(name.trim())}`, tagList.length > 0 && `--tags ${shellWord(tagList.join(","))}`].filter(Boolean).join(" ");
  const cmd = key && !optionErr ? `curl -fsSL ${INSTALL_SCRIPT} | sudo sh -s -- --key ${key} --endpoint ${location.origin}${options ? ` ${options}` : ""}${plainHttp ? " --allow-http" : ""}` : "";

  async function rotate() {
    if (!confirm(t("Servers using the current key stop reporting until you reinstall them with the new one. Rotate the key?"))) return;
    setRotating(true);
    try { setKey((await api.rotateServerAgentKey()).key); toast(t("Agent key rotated")); }
    catch (e) { setErr((e as Error).message); }
    finally { setRotating(false); }
  }

  return (
    <Modal onClose={onClose} label={t("Add a server")} style={{ width: "min(640px,94vw)" }}>
      <div>
        <h3>{t("Add a server")}</h3>
        <p className="muted" style={{ marginTop: 6 }}>{t("Run this on the server as root. It installs the agent as a systemd service; the server appears here after its first report.")}</p>
      </div>
      {limit && (
        <p className="err" style={{ margin: 0 }}>
          {t("Your plan allows {n} servers in this workspace, and all of them are in use. A new server is refused until you delete one or upgrade.").replace("{n}", String(limit.max))}
          {limit.upgradeUrl && <> <a href={limit.upgradeUrl}>{t("Upgrade")}</a></>}
        </p>
      )}
      {err && <p className="err">{err}</p>}
      <div className="srv-opts">
        <label className="fld">{t("Name (optional)")}<input className="in" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("The server's hostname")} /></label>
        <label className="fld">{t("Tags (optional)")}<input className="in" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="prod, eu-west" /></label>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{optionErr ? <span className="err">{optionErr}</span> : t("Used when the server first reports. Without a name it shows its hostname; rename it here at any time.")}</p>
      {!err && <pre className="srv-cmd mono">{cmd || (optionErr ? "" : t("Loading…"))}</pre>}
      {!err && plainHttp && <p className="muted" style={{ margin: 0, fontSize: 13 }}>{t("This dashboard is on plain http, so the command adds --allow-http: the key and the metrics cross the network unencrypted. Serve OpenUptime over https to avoid that.")}</p>}
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
    </Modal>
  );
}
