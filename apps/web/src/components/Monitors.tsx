import { SkeletonRows } from "@openuptime/ui/skeleton";
import MonitorImport from "./MonitorImport";
import { monitorState } from "../lib/domain-expiry";
import Select from "@openuptime/ui/select";
import { McpFields, initialMcpForm, mcpConfigForSave, mcpDiscoveryConfig, McpConnectionFields, McpToolCatalog, mcpConnectionKey } from "./McpFields";
import { t } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import { ago, api, everyShort, type Channel, type Incident, type ApiFlow, type JsonAssertion, type KeywordMode, type McpPreview, type Monitor, type ProjectOverview } from "../lib/api";
import { pollWhileVisible } from "../lib/poll";
import { toast } from "@openuptime/ui/toast";
import { regionLocked, toggleRegion } from "../lib/regions";
import { isAllProjects } from "../lib/scope";
import { ProjectBadge, ProjectStrip, ScopeChip, useProjects } from "./AllProjects";
import Modal from "@openuptime/ui/modal";
import Segmented from "@openuptime/ui/segmented";
import EmptyState from "@openuptime/ui/empty-state";
import PageHeader from "@openuptime/ui/page-header";
import Hint from "./Hint";

const TYPE_LABEL: Record<Monitor["type"], string> = { http: "HTTP", tcp: "TCP", dns: "DNS", heartbeat: "CRON", postgres: "PG", mysql: "MYSQL", redis: "REDIS", websocket: "WS", domain: "DOMAIN", mcp: "MCP", evm: "EVM", solana: "SOLANA", ping: "PING" };

/** Monitor types in the order the picker lists them: id, label, one-line description. */
const TYPES: readonly (readonly [Monitor["type"], string, string])[] = [
  ["http", "HTTP(S)", "Status code and keyword checks on a URL."],
  ["evm", "EVM", "Check EVM node sync status."],
  ["solana", "Solana", "Check Solana node health."],
  ["mcp", "MCP", "Initialize an MCP server and discover its tools."],
  ["websocket", "WebSocket", "Handshake, with an optional message and reply check."],
  ["tcp", "TCP port", "Open a connection to host:port."],
  ["ping", "Ping (ICMP)", "Send an ICMP echo request to a host."],
  ["dns", "DNS", "Resolve a hostname."],
  ["domain", "Domain expiry", "Check the registry expiration date of an explicit registered domain."],
  ["postgres", "PostgreSQL", "Checks that a PostgreSQL server answers."],
  ["mysql", "MySQL / MariaDB", "Checks that the server sends its handshake."],
  ["redis", "Redis", "Sends PING and expects PONG."],
  ["heartbeat", "Heartbeat (cron)", "Your job pings us on schedule."],
];

export function Spark({ data, status }: { data: (number | null)[]; status: string }) {
  const pts = data.filter((v): v is number => v != null);
  const color = status === "down" ? "var(--down)" : status === "degraded" ? "var(--warn)" : "var(--accent)";
  // not enough for a line yet: a dashed baseline, with a dot for the one result there is
  if (pts.length < 2) return <svg className="sp" viewBox="0 0 140 30"><path d="M0 15h140" stroke="var(--line-2)" strokeWidth="1.5" strokeDasharray="3 4" fill="none" />{pts.length === 1 && <circle cx="132" cy="15" r="3.5" fill={color} />}</svg>;
  const lo = Math.min(...pts), hi = Math.max(...pts), span = Math.max(1, hi - lo);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${((i / (pts.length - 1)) * 140).toFixed(1)} ${(26 - ((v - lo) / span) * 22).toFixed(1)}`).join("");
  return <svg className="sp" viewBox="0 0 140 30" preserveAspectRatio="none"><path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

const INTERVALS = [[60, "1 minute"], [300, "5 minutes"], [900, "15 minutes"]] as const;

/** The interval tag in the monitor list: click to pick another interval, then confirm to save it. */
function IntervalTag({ monitor, onChanged }: { monitor: Monitor; onChanged: (sec: number) => void }) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<number | null>(null);
  const [floor, setFloor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const close = () => { setOpen(false); setPick(null); setMsg(null); };
  useEffect(() => {
    if (!open) return;
    api.usage().then((u) => setFloor(u.metered ? (u.plan?.minIntervalSec ?? 0) : 0)).catch(() => {});
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const label = (sec: number) => t(INTERVALS.find(([v]) => v === sec)?.[1] ?? `${sec}s`);
  const save = async () => {
    if (pick == null) return;
    setBusy(true);
    try {
      const updated = await api.updateMonitor(monitor.id, { intervalSec: pick });
      onChanged(updated.intervalSec);
      setPick(null);
      setMsg({ ok: true, text: t("Interval updated") });
      setTimeout(close, 1200);
    } catch (e) {
      const x = e as Error & { code?: string };
      setMsg({ ok: false, text: x.code === "interval_not_allowed" ? t("This check interval is not available on your plan.") : x.message });
    }
    setBusy(false);
  };
  return (
    // the row is a link: clicks in here must not open the monitor
    <span className="iv" ref={ref} onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <button type="button" className="chip iv-tag" title={t("Click to change the check interval")} onClick={() => (open ? close() : setOpen(true))}>{everyShort(monitor.intervalSec)}</button>
      {open && (
        <div className="iv-pop" role="dialog" aria-label={t("Check every")}>
          {pick == null && !msg?.ok ? (
            <>
              <b>{t("Check every")}</b>
              {INTERVALS.map(([v, l]) => {
                const locked = (monitor.type === "domain" && (v < 3600 || v > 86400)) || (v < floor && v < monitor.intervalSec);
                return <button type="button" key={v} className={`iv-opt${v === monitor.intervalSec ? " on" : ""}`} disabled={locked || v === monitor.intervalSec} title={locked ? t("Not available on your plan") : undefined} onClick={() => { setMsg(null); setPick(v); }}>{t(l)}</button>;
              })}
            </>
          ) : pick != null ? (
            <>
              <span>{t("Check every")} {label(pick)}?</span>
              <span className="iv-acts"><button type="button" className="btn sm primary" disabled={busy} onClick={save}>{busy ? t("Saving…") : t("Confirm")}</button><button type="button" className="btn sm" disabled={busy} onClick={() => setPick(null)}>{t("Cancel")}</button></span>
            </>
          ) : null}
          {msg && <span className={msg.ok ? "iv-ok" : "err"}>{msg.ok ? "✓ " : ""}{msg.text}</span>}
        </div>
      )}
    </span>
  );
}

type BulkAction = "pause" | "resume" | "delete" | "add_channels" | "remove_channels";

/** The bar above the list while monitors are ticked: one action for all of them, with a report of the ones it missed. */
function BulkBar({ ids, onDone, onClear }: { ids: string[]; onDone: () => void; onClear: () => void }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.channels().then(setChannels).catch(() => {}); }, []);
  async function run(action: BulkAction, channelIds?: string[]) {
    if (action === "delete" && !confirm(t("Delete {n} monitors and their history? This cannot be undone.").replace("{n}", String(ids.length)))) return;
    setBusy(true);
    try {
      const r = await api.bulkMonitors({ ids, action, ...(channelIds ? { channelIds } : {}) });
      const done = t("{n} monitors updated").replace("{n}", String(r.done.length));
      if (r.failed.length) toast(`${done} · ${t("{n} failed").replace("{n}", String(r.failed.length))}: ${[...new Set(r.failed.map((f) => f.error))].join("; ")}`, "err", { sticky: true });
      else toast(done);
      onDone();
    } catch (e) {
      const x = e as Error & { code?: string };
      toast(x.code === "monitor_limit" ? t("You have reached your plan's active monitor limit. Pause a monitor or upgrade your plan.") : x.message, "err");
    }
    setBusy(false);
  }
  const channelOptions = [{ value: "", label: "" }, ...channels.map((c) => ({ value: c.id, label: c.name }))];
  return (
    <div className="bulk" role="toolbar" aria-label={t("Selected monitors")}>
      <b>{t("{n} selected").replace("{n}", String(ids.length))}</b>
      <button className="btn sm" disabled={busy} onClick={() => run("pause")}>{t("Pause")}</button>
      <button className="btn sm" disabled={busy} onClick={() => run("resume")}>{t("Resume")}</button>
      {channels.length > 0 && <>
        <Select compact className="in" value="" label={t("Add alert channel")} options={channelOptions.map((o) => (o.value ? o : { ...o, label: t("Add alert channel") }))} onChange={(v) => v && run("add_channels", [v])} />
        <Select compact className="in" value="" label={t("Remove alert channel")} options={channelOptions.map((o) => (o.value ? o : { ...o, label: t("Remove alert channel") }))} onChange={(v) => v && run("remove_channels", [v])} />
      </>}
      <button className="btn sm danger-l" disabled={busy} onClick={() => run("delete")}>{t("Delete")}</button>
      <button className="btn sm" disabled={busy} onClick={onClear}>{t("Clear selection")}</button>
    </div>
  );
}

// The list's sort is the viewer's own preference, kept in this browser only.
type SortKey = "name" | "status" | "uptime" | "latency" | "checked";
type Sort = { key: SortKey; desc: boolean } | null;
const SORT_STORE = "ou_monitor_sort";
const SORT_KEYS: SortKey[] = ["name", "status", "uptime", "latency", "checked"];
function readSort(): Sort {
  try {
    const [key, dir] = (localStorage.getItem(SORT_STORE) ?? "").split(":");
    return SORT_KEYS.includes(key as SortKey) ? { key: key as SortKey, desc: dir === "desc" } : null;
  } catch { return null; }
}
function saveSort(s: Sort) {
  try { if (s) localStorage.setItem(SORT_STORE, `${s.key}:${s.desc ? "desc" : "asc"}`); else localStorage.removeItem(SORT_STORE); } catch {}
}
// what needs attention first: down, then degraded, up, waiting for a first check, paused
const statusRank = (m: Monitor) => (m.paused ? 4 : m.status === "down" ? 0 : m.status === "degraded" ? 1 : m.status === "up" ? 2 : 3);
const sortValue = (m: Monitor, key: SortKey): string | number | null =>
  key === "name" ? m.name.toLowerCase() : key === "status" ? statusRank(m) : key === "uptime" ? m.uptime24h ?? null : key === "latency" ? m.avgLatency24h ?? null : m.lastCheckedAt ? Date.parse(m.lastCheckedAt) : null;
/** Sorted copy; monitors without a value (no checks yet) stay at the end in either direction. */
export function sortMonitors(list: Monitor[], sort: Sort): Monitor[] {
  if (!sort) return list;
  return [...list].sort((a, b) => {
    const x = sortValue(a, sort.key), y = sortValue(b, sort.key);
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    const c = x < y ? -1 : x > y ? 1 : 0;
    return sort.desc ? -c : c;
  });
}

export default function Monitors() {
  const [items, setItems] = useState<Monitor[] | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [setup, setSetup] = useState({ channels: false, pages: false });
  const [open, setOpen] = useState(false);
  const [importText, setImportText] = useState<string | null>(null);
  const [tab, setTab] = useState<"all" | "up" | "down" | "paused">("all");
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<Sort>(null);
  useEffect(() => setSort(readSort()), []);
  // a click sorts by the column, a second click reverses it, a third goes back to the default order
  const sortBy = (key: SortKey) => {
    const next: Sort = sort?.key !== key ? { key, desc: key === "checked" } : sort.desc === (key === "checked") ? { key, desc: !sort.desc } : null;
    setSort(next);
    saveSort(next);
  };
  // "All projects": every project of the workspace in one read-only list, with a summary per project on top
  const everything = isAllProjects();
  const projects = useProjects();
  const [overview, setOverview] = useState<ProjectOverview[]>([]);

  const load = () => {
    api.monitors().then(setItems);
    api.incidents().then(setIncidents).catch(() => {});
    if (everything) api.projectOverview().then(setOverview).catch(() => {});
  };
  useEffect(() => {
    if (!everything) Promise.all([api.channels(), api.statusPages()]).then(([c, p]) => setSetup({ channels: c.length > 0, pages: p.length > 0 })).catch(() => {});
    load();
    return pollWhileVisible(load, 15000);
  }, []);
  // ⌘K / Ctrl+K focuses the search box
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); document.getElementById("mon-search")?.focus(); }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);

  const all = items ?? [];
  const domainAttention = (m: Monitor) => m.type === "domain" && !m.paused && m.status !== "pending" && monitorState(m).tone !== "up";
  const down = all.filter((m) => m.status === "down" || domainAttention(m));
  const paused = all.filter((m) => m.paused);
  const upN = all.filter((m) => (m.status === "up" || m.status === "degraded") && !domainAttention(m)).length;
  const withUp = all.filter((m) => m.uptime24h != null);
  const avgUp = withUp.length ? withUp.reduce((a, m) => a + (m.uptime24h as number), 0) / withUp.length : null;
  const withLat = all.filter((m) => m.avgLatency24h != null);
  const avgLat = withLat.length ? Math.round(withLat.reduce((a, m) => a + (m.avgLatency24h as number), 0) / withLat.length) : null;
  const openInc = incidents.filter((i) => i.status !== "resolved");
  const shown = sortMonitors(all.filter((m) => {
    if (tab === "up" && (!(m.status === "up" || m.status === "degraded") || domainAttention(m))) return false;
    if (tab === "down" && m.status !== "down" && !domainAttention(m)) return false;
    if (tab === "paused" && !m.paused) return false;
    const n = q.trim().toLowerCase();
    if (tag && !(m.tags ?? []).includes(tag)) return false;
    return !n || m.name.toLowerCase().includes(n) || m.target.toLowerCase().includes(n) || (m.tags ?? []).some((x) => x.toLowerCase().includes(n));
  }), sort);
  const head = (key: SortKey, label: string) => (
    <button type="button" className={`sort-h ${sort?.key === key ? "on" : ""}`} onClick={() => sortBy(key)}>
      {t(label)}{sort?.key === key && <i aria-hidden="true">{sort.desc ? "↓" : "↑"}</i>}
    </button>
  );
  const allTags = [...new Set(all.flatMap((m) => m.tags ?? []))].sort();
  // only ticked monitors the list shows count: one hidden by a search or tag, or deleted elsewhere, is never acted on
  const pickedIds = shown.filter((m) => picked.has(m.id)).map((m) => m.id);
  const allShownPicked = shown.length > 0 && shown.every((m) => picked.has(m.id));
  const pick = (id: string, on: boolean) => setPicked((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });

  async function importFile(file: File) {
    setNote(null);
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error(t("Import files must be at most 4 MiB"));
      const raw = await file.text();
      JSON.parse(raw);
      setImportText(raw);
    } catch (e) { setNote({ ok: false, text: `${t("Import failed")}: ${(e as Error).message}` }); }
  }
  const tabs: ["all" | "up" | "down" | "paused", string, number][] = [["all", "All", all.length], ["up", "Up", upN], ["down", "Down", down.length], ["paused", "Paused", paused.length]];

  return (
    <>
      <PageHeader title={<>{t("Monitors")}{everything && <ScopeChip />}</>}
        description={items === null ? <i className="sk" style={{ width: 180, height: 14, marginTop: 4 }} aria-label={t("Loading…")} /> : down.length ? `${down.length} ${t(down.some((m) => m.type === "domain") ? "checks need attention" : "down right now")}` : all.length ? t("Everything is up.") : t("Nothing is being watched yet.")}
        actions={!everything && <>
          <input id="mon-import" type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) importFile(f); }} />
          <button className="btn" onClick={() => document.getElementById("mon-import")?.click()}>{t("Import")}</button>
          {all.length > 0 && <a className="btn" href="/api/monitors/export" download="openuptime-monitors.json">{t("Export")}</a>}
          <button className="btn primary" onClick={() => setOpen(true)}>{t("+ New monitor")}</button>
        </>} />
      {importText !== null && <MonitorImport raw={importText} onClose={() => setImportText(null)} onImported={() => { load(); window.dispatchEvent(new Event("ou:changed")); }} />}
      {everything && <p className="muted" style={{ marginTop: -10, marginBottom: 16 }}>{t("Read-only overview. Choose a project to make changes.")}</p>}
      {everything && <ProjectStrip rows={overview} />}

      {note && <p className={note.ok ? "muted" : "err"} style={{ marginBottom: 12 }}>{note.text} <button className="btn sm" onClick={() => setNote(null)}>{t("Dismiss")}</button></p>}

      {openInc.length > 0 && (
        <div className="alert">
          <span className="ai"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3.5 2.8 19.5h18.4L12 3.5z" /><path d="M12 10v4.5M12 17.4v.1" /></svg></span>
          <div className="alert-t">
            <b>{openInc.length > 1 ? `${openInc.length} ${t("open incidents")}` : openInc[0].title}</b>
            <span> {openInc.length === 1 && openInc[0].monitorName ? `${openInc[0].monitorName} · ` : ""}{t("started")} {ago(openInc[0].startedAt)}</span>
          </div>
          <a className="btn sm" href={openInc.length === 1 ? `/app/incidents/${openInc[0].id}` : "/app/incidents"}>{t("View incident")}</a>
        </div>
      )}

      {items && items.length > 0 && (
        <div className="kp">
          <div className="card"><small>{t("Monitors up")}</small><b>{upN}<u>/ {all.length}</u></b><div className={`d ${down.length ? "bad" : ""}`}>{down.length ? `${down.length} ${t("down")}` : t("All operational")}</div></div>
          <div className="card"><small>{t("Uptime 24h")}</small><b>{avgUp == null ? "—" : avgUp.toFixed(2)}<u>%</u></b><div className="d faint">{t("Average across monitors")}</div></div>
          <div className="card"><small>{t("Avg latency")}</small><b>{avgLat ?? "—"}<u>ms</u></b><div className="d faint">{t("Last 24 hours")}</div></div>
          <div className="card"><small>{t("Open incidents")}</small><b>{openInc.length}</b><div className={`d ${openInc.length ? "bad" : ""}`}>{openInc.length ? t("Needs attention") : t("None")}</div></div>
        </div>
      )}

      {items === null ? (
        <div className="card tbl mon-tbl">
          <div className="tr th"><span>{t("Monitor")}</span><span>{t("Status")}</span><span>{t("Response")}</span><span>{t("Uptime 24h")}</span><span>{t("Latency")}</span><span>{t("Checked")}</span></div>
          <SkeletonRows cols={6} />
        </div>
      ) : items.length === 0 && everything ? (
        <EmptyState title={t("No monitors yet")} description={t("Choose a project to add the first one.")} />
      ) : items.length === 0 ? (
        <div className="onb">
          <div className="onb-h">
            <div>
              <h2 className="onb-t">{t("Welcome to OpenUptime.")}</h2>
              <p className="muted">{t("Four steps to a monitor that wakes you up before your customers notice.")}</p>
            </div>
            <span className="chip">{1 + (setup.channels ? 1 : 0) + (setup.pages ? 1 : 0)} / 4</span>
          </div>
          <div className="onb-steps">
            {[
              { done: true, title: t("Create your workspace"), sub: t("Your workspace is ready."), cta: null as null | [string, string | (() => void)] },
              { done: false, title: t("Add your first monitor"), sub: t("HTTP, TCP, DNS, heartbeat — about 30 seconds."), cta: [t("Add monitor"), () => setOpen(true)] as [string, () => void] },
              { done: setup.channels, title: t("Connect an alert channel"), sub: t("Slack, email, Telegram or PagerDuty."), cta: [t("Connect"), "/app/alerting"] as [string, string] },
              { done: setup.pages, title: t("Publish a status page"), sub: t("Give customers one place to check."), cta: [t("Create page"), "/app/status-pages"] as [string, string] },
            ].map((st, i) => (
              <div className={`onb-step ${st.done ? "done" : ""}`} key={i}>
                <span className="onb-n">{st.done ? "✓" : i + 1}</span>
                <div className="onb-b"><b>{st.title}</b><small>{st.sub}</small></div>
                {!st.done && st.cta && (typeof st.cta[1] === "string"
                  ? <a className="btn sm" href={st.cta[1]}>{st.cta[0]}</a>
                  : <button className="btn sm primary" onClick={st.cta[1] as () => void}>{st.cta[0]}</button>)}
              </div>
            ))}
          </div>
          <EmptyState className="onb-empty" title={t("No monitors yet")} description={t("Add a URL and we’ll check it every minute.")}
            action={<button className="btn primary" onClick={() => setOpen(true)}>{t("+ Add your first monitor")}</button>} />
        </div>
      ) : (
        <>
          <div className="tool">
            <div className="ftabs">
              {tabs.map(([k, label, n]) => (
                <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{t(label)} {items !== null && <em>{n}</em>}</button>
              ))}
            </div>
            <label className="search">
              <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
              <input id="mon-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search monitors…")} />
              <kbd>⌘K</kbd>
            </label>
          </div>
          {allTags.length > 0 && (
            <div className="ftabs" style={{ marginBottom: 12, flexWrap: "wrap" }}>
              <button className={`tab ${tag === "" ? "on" : ""}`} onClick={() => setTag("")}>{t("All tags")}</button>
              {allTags.map((x) => <button key={x} className={`tab ${tag === x ? "on" : ""}`} onClick={() => setTag(tag === x ? "" : x)}>{x}</button>)}
            </div>
          )}
          {!everything && pickedIds.length > 0 && <BulkBar ids={pickedIds} onClear={() => setPicked(new Set())} onDone={() => { setPicked(new Set()); load(); window.dispatchEvent(new Event("ou:changed")); }} />}
          <div className="card tbl mon-tbl">
            <div className="tr th"><span className="nm">{!everything && <input type="checkbox" className="pick" aria-label={t("Select all shown monitors")} checked={allShownPicked} onChange={(e) => setPicked((s) => { const n = new Set(s); for (const m of shown) { if (e.target.checked) n.add(m.id); else n.delete(m.id); } return n; })} />}{head("name", "Monitor")}</span><span>{head("status", "Status")}</span><span>{t("Response")}</span><span>{head("uptime", "Uptime 24h")}</span><span>{head("latency", "Latency")}</span><span>{head("checked", "Checked")}</span></div>
            {shown.map((m) => (
              <a className="tr" key={m.id} href={`/app/monitors/${m.id}`}>
                <div className="nm">
                  {/* the row is a link: ticking the box must not open the monitor */}
                  {!everything && <span className="pick-w" onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) e.preventDefault(); }}><input type="checkbox" className="pick" aria-label={t("Select {name}").replace("{name}", m.name)} checked={picked.has(m.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => pick(m.id, e.target.checked)} /></span>}
                  <span className="chip">{TYPE_LABEL[m.type]}</span>
                  {everything || m.type === "heartbeat" ? <span className="chip" title={t("Check interval")}>{everyShort(m.intervalSec)}</span> : <IntervalTag monitor={m} onChanged={(sec) => setItems((xs) => xs && xs.map((x) => (x.id === m.id ? { ...x, intervalSec: sec } : x)))} />}
                  <div style={{ minWidth: 0 }}><b>{m.name}</b><small>{everything && <ProjectBadge id={m.projectId} projects={projects} />}{m.target || m.type}{(m.tags ?? []).length > 0 && ` · ${(m.tags ?? []).map((x) => `#${x}`).join(" ")}`}</small></div>
                </div>
                <span><span className={`pill ${monitorState(m).tone}`}>{t(monitorState(m).label)}</span></span>
                <span className="spk"><Spark data={m.spark ?? []} status={m.status} /></span>
                <span className="num">{m.uptime24h == null ? "—" : `${m.uptime24h.toFixed(2)}%`}</span>
                <span className="num">{m.avgLatency24h == null ? "—" : `${m.avgLatency24h} ms`}</span>
                <span className="muted">{ago(m.lastCheckedAt)}</span>
              </a>
            ))}
            {items && shown.length === 0 && <div className="tr"><span className="muted">{t("No monitors match.")}</span></div>}
            <div className="tbl-f"><span>{shown.length} / {all.length} {t("monitors")}</span></div>
          </div>
        </>
      )}
      {open && !everything && <MonitorForm onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); window.dispatchEvent(new Event("ou:changed")); }} />}
    </>
  );
}

const REDIRECTS = [301, 302, 303, 307, 308];
const STATUS_NAMES: Record<number, string> = {
  200: "OK (any 2xx)", 201: "Created", 202: "Accepted", 204: "No Content",
  301: "Moved Permanently", 302: "Found", 303: "See Other", 307: "Temporary Redirect", 308: "Permanent Redirect",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 410: "Gone", 429: "Too Many Requests",
  500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
};
/** The common statuses, plus whatever an existing monitor already expects (it may predate the list). */
const statusOptions = (current: number) =>
  [...new Set([...Object.keys(STATUS_NAMES).map(Number), current])].sort((a, b) => a - b).map((n) => ({ value: n, label: STATUS_NAMES[n] ? `${n} ${STATUS_NAMES[n]}` : String(n) }));

const JSON_OPS: [JsonAssertion["op"], string][] = [["equals", "equals"], ["not_equals", "does not equal"], ["contains", "contains"], ["exists", "exists"], ["not_exists", "does not exist"], ["greater_than", "greater than"], ["less_than", "less than"]];
const VALUELESS: JsonAssertion["op"][] = ["exists", "not_exists"];
/** Whether a status list can accept more than one status: a comma, a range, a class such as 2xx, or an exclusion. */
export const acceptsSeveral = (list: string) => /[,\-!]|xx/i.test(list);
const TYPED: JsonAssertion["op"][] = ["equals", "not_equals", "contains"];
const JSON_TYPES: [NonNullable<JsonAssertion["type"]>, string][] = [["any", "Any type"], ["string", "Text"], ["number", "Number"], ["boolean", "Boolean"]];
const API_FLOW_EXAMPLE = JSON.stringify({
  extract: [{ name: "token", from: "json", path: "$.access_token" }],
  steps: [{ name: "List orders", method: "GET", url: "https://api.example.com/v1/orders?limit=1", headers: { Authorization: "Bearer {{token}}" }, expectedStatus: 200, jsonAssertions: [{ path: "$.data", op: "exists", value: "" }] }],
}, null, 2);

/** Types whose checks can run from a probe region (the API's PROBE_TYPES). */
const PROBED: readonly Monitor["type"][] = ["http", "tcp", "websocket", "mcp", "ping"];

/** Create a monitor, or edit one when `monitor` is given (its type is fixed). */
export function MonitorForm({ monitor, onClose, onSaved }: { monitor?: Monitor; onClose: () => void; onSaved: () => void }) {
  // a list or range of statuses instead of one; the server checks the syntax
  const [customStatus, setCustomStatus] = useState(!!monitor?.acceptedStatuses);
  const [f, setF] = useState({
    name: monitor?.name ?? "", type: monitor?.type ?? ("http" as Monitor["type"]), target: monitor?.target ?? "https://",
    requestBody: monitor?.requestBody ?? "", domainExpiryWarnDays: monitor?.domainExpiryWarnDays ?? 30, method: monitor?.method ?? "GET", intervalSec: monitor?.intervalSec ?? 60, expectedStatus: monitor?.expectedStatus ?? 200, acceptedStatuses: monitor?.acceptedStatuses ?? "", expectedLocation: monitor?.expectedLocation ?? "", failureThreshold: monitor?.failureThreshold ?? 3,
    keyword: monitor?.keyword ?? "", wsMessage: monitor?.wsMessage ?? "", keywordMode: monitor?.keywordMode ?? ("contains" as KeywordMode),
    dnsRecordType: monitor?.dnsRecordType ?? "A", dnsExpectedValue: monitor?.dnsExpectedValue ?? "", dnsMatchMode: monitor?.dnsMatchMode ?? "exact",
    recoveryThreshold: monitor?.recoveryThreshold ?? 1, timeoutMs: monitor?.timeoutMs ?? 10000,
    graceSec: monitor?.graceSec ?? 0, channelIds: monitor?.channelIds ?? ([] as string[]),
    slowThresholdMs: monitor?.slowThresholdMs ?? 1500, slowAlertAfter: monitor?.slowAlertAfter ?? 0,
    regions: monitor?.regions?.length ? monitor.regions : ["auto"],
    dependsOnMonitorId: monitor?.dependsOnMonitorId ?? (null as string | null), minRegionsFailing: monitor?.minRegionsFailing ?? 0,
  });
  // the project's other monitors, to pick the one this depends on
  const [others, setOthers] = useState<Monitor[]>([]);
  useEffect(() => { api.monitors().then((l) => setOthers(l.filter((x) => x.id !== monitor?.id))).catch(() => {}); }, []);
  const savedMcpConfig = monitor?.mcpConfig;
  const [initialMcp] = useState(() => initialMcpForm(monitor?.mcpConfig));
  const [mcp, setMcp] = useState(initialMcp);
  const [mcpPreview, setMcpPreview] = useState<{ key: string; result: McpPreview } | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState("");
  const [tagText, setTagText] = useState((monitor?.tags ?? []).join(", "));
  const [hdrs, setHdrs] = useState<{ k: string; v: string }[]>(Object.entries(monitor?.headers ?? {}).map(([k, v]) => ({ k, v })));
  const setHdr = (i: number, p: Partial<{ k: string; v: string }>) => setHdrs((h) => h.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const [asserts, setAsserts] = useState<JsonAssertion[]>(monitor?.jsonAssertions ?? []);
  const setAssert = (i: number, p: Partial<JsonAssertion>) => setAsserts((a) => a.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const [initialFlow] = useState(() => (monitor?.apiFlow ? JSON.stringify(monitor.apiFlow, null, 2) : ""));
  const [flowText, setFlowText] = useState(initialFlow);
  const [channels, setChannels] = useState<Channel[]>([]);
  useEffect(() => {
    api.channels().then((list) => {
      setChannels(list);
      // a new monitor starts out with the channels that are turned on for new monitors; they can be switched off here
      if (!monitor) setF((x) => ({ ...x, channelIds: [...new Set([...x.channelIds, ...list.filter((c) => c.autoEnable && c.enabled).map((c) => c.id)])] }));
    }).catch(() => {});
  }, []);
  const [err, setErr] = useState("");
  const [upgrade, setUpgrade] = useState<string | undefined>();
  // the plan's shortest interval (0 = no plans, nothing locked): faster presets are shown locked
  const [floor, setFloor] = useState(0);
  useEffect(() => {
    api.usage().then((u) => {
      const min = u.metered ? (u.plan?.minIntervalSec ?? 0) : 0;
      setFloor(min);
      if (!monitor && min > 60) setF((x) => ({ ...x, intervalSec: Math.max(x.intervalSec, min) }));
    }).catch(() => {});
  }, []);
  // ping only where this deployment can send ICMP, or for a ping monitor being edited
  const [canPing, setCanPing] = useState(false);
  const types = TYPES.filter(([id]) => id !== "ping" || canPing || monitor?.type === "ping");
  // where checks can run from on this deployment; with only `auto` the whole section stays out of the form
  const [places, setPlaces] = useState<{ id: string; name: string }[]>([]);
  const [maxRegions, setMaxRegions] = useState(1);
  useEffect(() => {
    api.regions().then((r) => { setPlaces(r.regions); setMaxRegions(r.maxPerMonitor ?? Infinity); setCanPing(Boolean(r.ping)); }).catch(() => {});
  }, []);
  const [regionsOpen, setRegionsOpen] = useState(false);
  const known = new Set(places.map((p) => p.id));
  // a saved region this deployment no longer offers stays listed so it can be switched off
  const choices = [...places, ...(monitor?.regions ?? []).filter((r) => !known.has(r)).map((id) => ({ id, name: id }))];
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  // one expected status leaves nothing to tell apart, so per-assertion status limits only show for a list that takes several
  const several = customStatus && acceptsSeveral(f.acceptedStatuses);
  const isPattern = f.keywordMode === "matches" || f.keywordMode === "not_matches";

  const previewRegion = f.regions[0] ?? "auto";
  const previewRegionName = places.find((place) => place.id === previewRegion)?.name ?? (previewRegion === "auto" ? t("Auto") : previewRegion);
  const connectionKey = mcpConnectionKey(f.target, f.timeoutMs, hdrs, mcp, previewRegion);
  const currentPreview = mcpPreview?.key === connectionKey ? mcpPreview.result : null;
  const savedConnectionKey = monitor ? mcpConnectionKey(monitor.target, monitor.timeoutMs, Object.entries(monitor.headers ?? {}).map(([k, v]) => ({ k, v })), initialMcp, monitor.regions?.[0] ?? "auto") : null;
  const discoveredTools = currentPreview?.mcp.tools ?? (connectionKey === savedConnectionKey ? monitor?.mcpObservation?.tools ?? [] : []);
  async function discoverMcp() {
    setDiscovering(true); setDiscoveryError(""); setMcpPreview(null);
    const key = connectionKey;
    try {
      // Preview never submits an enabled call, even when the saved monitor runs tools.
      const config = mcpDiscoveryConfig(mcp, monitor ? { config: savedMcpConfig, initial: initialMcp } : undefined);
      // A rotated refresh token is stored by the server and never returned, so the form never holds a stale copy.
      const result = await api.previewMcp({ region: previewRegion, ...(monitor ? { monitorId: monitor.id } : {}), target: f.target, timeoutMs: f.timeoutMs, headers: Object.fromEntries(hdrs.filter((h) => h.k.trim()).map((h) => [h.k.trim(), h.v])), mcpConfig: config });
      setMcpPreview({ key, result });
    } catch (error) { setDiscoveryError((error as Error).message); }
    finally { setDiscovering(false); }
  }
  const bodyBytes = new TextEncoder().encode(f.requestBody).byteLength;
  const bodyTooLarge = f.type === "http" && !["GET", "HEAD"].includes(f.method) && bodyBytes > 16384;

  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (bodyTooLarge) { setErr(t("Request body exceeds 16 KiB.")); return; }
    let apiFlow: ApiFlow | null = null;
    if (f.type === "http" && flowText.trim()) {
      try { apiFlow = JSON.parse(flowText); } catch { setErr(t("API steps are not valid JSON.")); return; }
    }
    setBusy(true);
    setErr("");
    setUpgrade(undefined);
    try {
      const headers = f.type === "http" || f.type === "websocket" || f.type === "mcp" || f.type === "evm" || f.type === "solana" ? Object.fromEntries(hdrs.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v])) : {};
      const tags = [...new Set(tagText.split(/[,，\n]/).map((x) => x.trim().replace(/^#/, "")).filter(Boolean))];
      const { regions, dnsRecordType, dnsExpectedValue, dnsMatchMode, timeoutMs, ...rest } = f;
      const mcpConfig = f.type === "mcp" && !monitor?.mcpConfigRedacted ? mcpConfigForSave(mcp, monitor ? initialMcp : undefined) : undefined;
      // only http, tcp and websocket checks can run from a region; leaving the field out keeps the stored value
      const probed = PROBED.includes(f.type) && places.length > 1;
      const payload = { ...rest, ...(mcpConfig === undefined ? {} : { mcpConfig }), ...(f.type === "mcp" ? { timeoutMs } : {}), requestBody: f.type === "http" && !["GET", "HEAD"].includes(f.method) && f.requestBody ? f.requestBody : null, ...(f.type === "dns" ? { dnsRecordType, dnsExpectedValue, dnsMatchMode } : {}), ...(probed ? { regions } : {}), tags, headers, keyword: (f.type === "http" || f.type === "websocket") && f.keyword ? f.keyword : null, wsMessage: f.type === "websocket" && f.wsMessage ? f.wsMessage : null, acceptedStatuses: f.type === "http" && customStatus && f.acceptedStatuses.trim() ? f.acceptedStatuses.trim() : null, expectedLocation: f.type === "http" && (customStatus || REDIRECTS.includes(f.expectedStatus)) && f.expectedLocation.trim() ? f.expectedLocation.trim() : null, jsonAssertions: f.type === "http" ? asserts.filter((a) => a.path.trim()).map((a) => ({ ...a, path: a.path.trim(), value: VALUELESS.includes(a.op) ? "" : a.value })) : [],
        // left out when untouched, so the stored steps (and their hidden values) stay as they are
        ...(flowText !== initialFlow || (f.type !== "http" && monitor?.apiFlow) ? { apiFlow } : {}) };
      if (monitor) {
        const { type: _t, ...patch } = payload;
        if (monitor.mcpConfigRedacted) { delete (patch as Partial<typeof patch>).target; delete (patch as Partial<typeof patch>).headers; }
        await api.updateMonitor(monitor.id, patch);
      } else await api.createMonitor(payload);
      onSaved();
    } catch (e) {
      const x = e as Error & { code?: string; upgradeUrl?: string };
      // plan limits read in the UI's language; the server message stays English for API clients
      setErr(x.code === "monitor_limit" ? t("You have reached your plan's active monitor limit. Pause a monitor or upgrade your plan.") : x.code === "interval_not_allowed" ? t("This check interval is not available on your plan.") : x.code === "regions_not_allowed" ? t("Your plan cannot check from that many regions.") : x.code === "unknown_region" ? t("One of the selected regions is not available.") : x.message);
      setUpgrade(x.code ? x.upgradeUrl : undefined);
      setBusy(false);
    }
  }
  return (
    <Modal as="form" onClose={onClose} onSubmit={submit} backdropClose={false} title={monitor ? t("Edit monitor") : t("New monitor")} closeLabel={t("Close")} footer={<>
          {err && <p className="err">{err}{upgrade && <> <a href={upgrade}>{t("Upgrade")}</a></>}</p>}
          <div className="mact">
            <div className="est"><b>≈ {Math.round((30 * 86400) / Math.max(1, f.intervalSec) * (PROBED.includes(f.type) ? Math.max(1, new Set(f.regions).size) : 1)).toLocaleString()} {t("checks / month")}</b>{PROBED.includes(f.type) && new Set(f.regions).size > 1 && <small> · {t("each region counts as a check")}</small>}</div>
            <div className="mbtns">
              <button type="button" className="btn" onClick={onClose}>{t("Cancel")}</button>
              <button className="btn primary" disabled={busy || bodyTooLarge}>{busy ? t(monitor ? "Saving…" : "Creating…") : monitor ? t("Save") : t("Create monitor")}</button>
            </div>
          </div>
        </>}>
        <label className="fld">{t("Name")}<input className="in" required autoFocus value={f.name} onChange={(e) => set("name", e.target.value)} placeholder={t("Production API")} /></label>
        <div className="fld">{t("Type")}
          <div className="type-grid">
            {types.map(([id, label, desc]) => (
              <button type="button" key={id} disabled={!!monitor && monitor.type !== id} className={`type-c ${f.type === id ? "on" : ""}`} onClick={() => { set("type", id); if (id === "domain") { set("intervalSec", 86400); set("failureThreshold", 1); } if (!monitor && (f.target === "https://" || f.target === "wss://" || f.target === "")) set("target", (id === "http" || id === "mcp" || id === "evm" || id === "solana") ? "https://" : id === "websocket" ? "wss://" : ""); }}>
                <b>{t(label)}</b><small>{t(desc)}</small>
              </button>
            ))}
          </div>
        </div>
        {f.type === "domain" && <label className="fld"><span>{t("Warn before expiry (days)")} <Hint text={t("Enter the registered domain, not a URL or subdomain. Missing registry dates are unknown, never healthy. Daily checks are recommended; intervals below one hour are raised.")} /></span>
          <input className="in mono" type="number" min={1} max={365} value={f.domainExpiryWarnDays} onChange={(e) => set("domainExpiryWarnDays", Number(e.target.value))} />
        </label>}
        {f.type !== "heartbeat" && (
          <label className="fld">{t(f.type === "http" || f.type === "websocket" || f.type === "mcp" || f.type === "evm" || f.type === "solana" ? "URL" : ["tcp", "postgres", "mysql", "redis"].includes(f.type) ? "Host:port" : f.type === "ping" ? "Hostname or IP address" : "Hostname")}
            <input className="in mono" required disabled={monitor?.mcpConfigRedacted} value={f.target} onChange={(e) => set("target", e.target.value)} placeholder={({ postgres: "db.example.com:5432", mysql: "db.example.com:3306", redis: "cache.example.com:6379", tcp: "example.com:443", websocket: "wss://example.com/socket", mcp: "https://example.com/mcp", ping: "example.com" } as Record<string, string>)[f.type] ?? ""} />
          </label>
        )}
        {f.type === "mcp" && (monitor?.mcpConfigRedacted ? <p className="muted">{t("Only owners and admins can view or edit MCP connection and tool settings.")}</p> : <McpConnectionFields value={mcp} onChange={setMcp} savedRefreshToken={initialMcp.oauthMode === "refresh_token"} />)}
        {f.type === "mcp" && <label className="fld"><span>{t("Timeout (ms)")} <Hint text={t("One timeout covers initialization, all tool-list pages and the optional tool call.")} /></span>
          <input className="in mono" type="number" min={1000} max={30000} step={1} required value={f.timeoutMs} onChange={(e) => set("timeoutMs", Number(e.target.value))} />
        </label>}
        <div className="fld">{t("Check every")}
          <Segmented label={t("Check every")} value={f.intervalSec} onChange={(v) => set("intervalSec", v)} options={[
            ...(![60, 300, 900].includes(f.intervalSec) ? [{ value: f.intervalSec, label: `${f.intervalSec}s` }] : []),
            ...([[60, "1 minute"], [300, "5 minutes"], [900, "15 minutes"]] as const).map(([v, l]) => {
              const locked = f.type !== "heartbeat" && v < floor && v < (monitor?.intervalSec ?? Infinity);
              return { value: v as number, label: t(l), locked, title: locked ? t("Not available on your plan") : undefined };
            }),
          ]} />
        </div>
        {f.type !== "heartbeat" && (
          <div style={{ display: "grid", gridTemplateColumns: f.type === "http" ? "1fr 1fr" : "1fr", gap: 10 }}>
            {f.type === "http" && (
              <label className="fld">{t("Method")}
                <Select className="in mono" value={f.method} onChange={(v) => set("method", v)} options={["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].map((m) => ({ value: m, label: m }))} />
              </label>
            )}
            {f.type === "http" && (
              <label className="fld">{t("Expected status")}
                <Select className="in mono" value={customStatus ? 0 : f.expectedStatus} onChange={(v) => { setCustomStatus(v === 0); if (v !== 0) set("expectedStatus", v); }} options={[...statusOptions(f.expectedStatus), { value: 0, label: t("Custom list or range…") }]} />
              </label>
            )}
            {f.type === "http" && customStatus && (
              <label className="fld" style={{ gridColumn: "1 / -1" }}><span>{t("Healthy statuses")} <Hint text={t("Codes, ranges and classes separated by commas, such as 200-299,401 or 2xx,3xx. Prefix ! to exclude one: 200-499,!404. Exclusions alone accept every other status: !5xx.")} /></span>
                <input className="in mono" value={f.acceptedStatuses} onChange={(e) => set("acceptedStatuses", e.target.value)} maxLength={200} placeholder="200-299,401" required />
              </label>
            )}
            {f.type === "http" && (customStatus || REDIRECTS.includes(f.expectedStatus)) && (
              <label className="fld" style={{ gridColumn: "1 / -1" }}><span>{t("Redirect must lead to (optional)")} <Hint text={customStatus ? t("Used when the list accepts a redirect status (301, 302, 303, 307 or 308): redirects are then not followed, and their Location is checked. Leave empty to accept any destination.") : t("The redirect is not followed: its status and Location are checked. Leave empty to accept any destination.")} /></span>
                <input className="in mono" value={f.expectedLocation} onChange={(e) => set("expectedLocation", e.target.value)} placeholder="https://www.example.com/" />
              </label>
            )}
            <label className="fld">{t("Failures before incident")}
              <Select className="in" value={f.failureThreshold} onChange={(v) => set("failureThreshold", v)} options={[1, 2, 3, 5, 10].map((n) => ({ value: n, label: String(n) }))} />
            </label>
          </div>
        )}
        {f.type === "http" && !["GET", "HEAD"].includes(f.method) && (
          <label className="fld"><span>{t("Request body (optional)")} <Hint text={t("Up to 16 KiB of UTF-8 text. Set Content-Type in request headers. Bodies are masked for members and viewers. Use a safe test endpoint: this request runs repeatedly.")} /></span>
            <textarea className="in mono" value={f.requestBody} onChange={(e) => set("requestBody", e.target.value)} rows={5} maxLength={16384} aria-invalid={bodyTooLarge} />
            <span className={bodyTooLarge ? "err" : "muted"}>{t("{n} / 16384 UTF-8 bytes").replace("{n}", String(bodyBytes))}</span>
          </label>
        )}
        <label className="fld"><span>{t("Successes before recovery")} <Hint text={t("Consecutive successful checks or heartbeat pings before ending an outage. Each multi-region run counts once and every ping counts, even when several arrive together; slow responses may recover to degraded.")} /></span>
          <Select className="in" value={f.recoveryThreshold} onChange={(v) => set("recoveryThreshold", v)} options={Array.from({ length: 10 }, (_, i) => ({ value: i + 1, label: String(i + 1) }))} />
        </label>
        {f.type === "dns" && <>
          <label className="fld">{t("DNS record type")}
            <Select className="in" value={f.dnsRecordType} onChange={(v) => set("dnsRecordType", v)} options={(["A", "AAAA", "CNAME", "MX", "TXT", "NS"] as const).map((v) => ({ value: v, label: v }))} />
          </label>
          <label className="fld"><span>{t("Expected DNS value (optional)")} <Hint text={t("Leave empty to accept any record of this type. TXT includes quotes; MX includes priority, e.g. 10 mail.example.com.")} /></span>
            <input className="in mono" value={f.dnsExpectedValue} onChange={(e) => set("dnsExpectedValue", e.target.value)} maxLength={2000} />
          </label>
          <label className="fld">{t("DNS value match")}
            <Select className="in" value={f.dnsMatchMode} onChange={(v) => set("dnsMatchMode", v)} options={[{ value: "exact", label: t("Exact value") }, { value: "contains", label: t("Contains text") }]} />
          </label>
        </>}
        {f.type === "websocket" && (
          <label className="fld"><span>{t("Message to send (optional)")} <Hint text={t("Sent once the connection is open; a message must then come back. Leave empty to check the handshake only. Put credentials in headers, not here.")} /></span>
            <input className="in mono" value={f.wsMessage} onChange={(e) => set("wsMessage", e.target.value)} placeholder='{"type":"ping"}' maxLength={2000} />
          </label>
        )}
        {(f.type === "http" || f.type === "websocket") && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 170px", gap: 10 }}>
            <label className="fld"><span>{isPattern ? t("Pattern (optional)") : t(f.type === "websocket" ? (f.wsMessage ? "Reply must contain (optional)" : "First message must contain (optional)") : "Response must contain (optional)")}{isPattern && <> <Hint text={t("RE2 syntax, matched anywhere in the text. Start with (?i) to ignore case. Backreferences and lookarounds are not supported.")} /></>}</span>
              <input className="in mono" value={f.keyword} onChange={(e) => set("keyword", e.target.value)} placeholder={isPattern ? "(?i)status:\\s*ok" : "OK"} spellCheck={false} />
            </label>
            <label className="fld">{t("Mode")}
              <Select className="in" value={f.keywordMode as string} onChange={(v) => set("keywordMode", v as KeywordMode)} options={[{ value: "contains", label: t("must contain") }, { value: "absent", label: t("must not contain") }, { value: "matches", label: t("must match pattern") }, { value: "not_matches", label: t("must not match pattern") }]} />
            </label>
          </div>
        )}
        {f.type === "http" && (
          <div className="fld">
<span>{t("JSON assertions (optional)")} <Hint text={t("Each one reads a value from the JSON body, e.g. $.data.items[0].status, and must hold for the check to pass. Without a value type, 200 also matches the text \"200\" and true matches \"true\"; pick Text, Number or Boolean to compare strictly. When the monitor accepts several statuses, fill Only when the status is (such as 2xx) to skip an assertion for the others. Up to 10.")} /></span>
            {asserts.map((a, i) => (
              <div key={i} style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                <input className="in mono" style={{ flex: "2 1 160px", minWidth: 0 }} value={a.path} placeholder="$.data.status" aria-label={t("JSON path")} maxLength={256} onChange={(e) => setAssert(i, { path: e.target.value })} />
                <Select className="in" value={a.op as string} onChange={(v) => setAssert(i, { op: v as JsonAssertion["op"], ...(TYPED.includes(v as JsonAssertion["op"]) ? {} : { type: undefined }) })} label={t("Comparison")} options={JSON_OPS.map(([value, label]) => ({ value, label: t(label) }))} />
                {TYPED.includes(a.op) && <Select className="in" value={a.type ?? "any"} onChange={(v) => setAssert(i, { type: v as NonNullable<JsonAssertion["type"]> })} label={t("Value type")} options={JSON_TYPES.map(([value, label]) => ({ value, label: t(label) }))} />}
                {!VALUELESS.includes(a.op) && <input className="in mono" style={{ flex: "1 1 100px", minWidth: 0 }} value={a.value} placeholder="ok" aria-label={t("Expected value")} maxLength={500} onChange={(e) => setAssert(i, { value: e.target.value })} />}
                {f.type === "http" && (several || a.status) ? <input className="in mono" style={{ flex: "1 1 110px", minWidth: 0 }} value={a.status ?? ""} placeholder="2xx" aria-label={t("Only when the status is")} title={t("Only check responses with these statuses, such as 2xx or 200. Empty checks every healthy status.")} maxLength={200} onChange={(e) => setAssert(i, { status: e.target.value })} /> : null}
                <button type="button" className="btn" onClick={() => setAsserts((x) => x.filter((_, j) => j !== i))}>{t("Remove")}</button>
              </div>
            ))}
            {asserts.length < 10 && <div><button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => setAsserts((x) => [...x, { path: "", op: "equals", value: "" }])}>{t("Add assertion")}</button></div>}
          </div>
        )}
        {f.type === "http" && (
          <details className="fld" open={Boolean(flowText.trim())}>
            <summary style={{ cursor: "pointer" }}>{t("API steps (optional)")} <Hint text={t("After the request above, up to 5 more requests run in order. extract reads a value from an answer (a $.path in JSON, or a header); later steps use it as {{name}} in the path, query, headers or body. The check fails at the first step that fails, and the timeout covers all steps.")} /></summary>
            <textarea className="in mono" rows={flowText.trim() ? 12 : 4} spellCheck={false} value={flowText} onChange={(e) => setFlowText(e.target.value)} placeholder={API_FLOW_EXAMPLE} aria-label={t("API steps as JSON")} style={{ marginTop: 6, fontSize: 12.5 }} />
            {!flowText.trim() && <div><button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => setFlowText(API_FLOW_EXAMPLE)}>{t("Start from an example")}</button></div>}
            <small className="faint" style={{ display: "block", marginTop: 6 }}><a href="/docs/api-steps">{t("How API steps work")}</a></small>
          </details>
        )}
        {(f.type === "http" || f.type === "websocket" || f.type === "evm" || f.type === "solana" || (f.type === "mcp" && !monitor?.mcpConfigRedacted)) && (
          <div className="fld">
            {t(f.type === "websocket" ? "Handshake headers" : "Request headers")}
            {hdrs.map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <input className="in mono" style={{ flex: 1, minWidth: 0 }} value={r.k} placeholder="Authorization" aria-label={t("Header name")} onChange={(e) => setHdr(i, { k: e.target.value })} />
                <input className="in mono" style={{ flex: 2, minWidth: 0 }} value={r.v} placeholder="Bearer …" aria-label={t("Header value")} onChange={(e) => setHdr(i, { v: e.target.value })} />
                <button type="button" className="btn" onClick={() => setHdrs((h) => h.filter((_, j) => j !== i))}>{t("Remove")}</button>
              </div>
            ))}
            <div><button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => setHdrs((h) => [...h, { k: "", v: "" }])}>{t("Add header")}</button></div>
          </div>
        )}
        {f.type === "mcp" && !monitor?.mcpConfigRedacted && <div className="fld">
          <p>{t("Discovery preview region")}: <strong>{previewRegionName}</strong> <code>({previewRegion})</code></p>
          <small className="muted">{t("Preview uses the first selected check region. Change Check from below before previewing a private endpoint.")}</small>
          <button type="button" className="btn" disabled={discovering || !f.target.trim()} onClick={discoverMcp}>{discovering ? t("Discovering…") : t("Discover tools without calling them")}</button>
          <small className="muted">{t("Preview does not create a monitor, call tools or send alerts. OAuth credentials may be refreshed; save changed OAuth settings before previewing an existing monitor.")}</small>
          {discoveryError && <p className="err" role="alert">{discoveryError}</p>}
          {currentPreview && <p className={currentPreview.ok ? "muted" : "err"}>{currentPreview.ok ? t("Discovery completed") : currentPreview.error} · {currentPreview.mcp.tools.length} {t("tools")} · {currentPreview.latencyMs ?? "—"} ms</p>}
        </div>}
        {f.type === "mcp" && !monitor?.mcpConfigRedacted && <>
          <McpToolCatalog tools={discoveredTools} onSelect={(name) => setMcp((state) => ({ ...state, toolName: name }))} />
          <McpFields value={mcp} onChange={setMcp} tools={discoveredTools} monthlyCalls={Math.round(30 * 86400 / Math.max(1, f.intervalSec) * Math.max(1, new Set(f.regions).size))} />
        </>}
        {f.type !== "heartbeat" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label className="fld">{t("Slow above (ms)")}
              <input className="in mono" type="number" min={100} max={60000} value={f.slowThresholdMs} onChange={(e) => set("slowThresholdMs", Number(e.target.value) || 1500)} />
            </label>
            <label className="fld">{t("Alert when slow")}
              <Select className="in" value={f.slowAlertAfter} onChange={(v) => set("slowAlertAfter", v)} options={[{ value: 0, label: t("Never") }, ...[3, 5, 10].map((n) => ({ value: n, label: t("After {n} slow checks").replace("{n}", String(n)) }))]} />
            </label>
          </div>
        )}
        <label className="fld"><span>{t("Tags")} <Hint text={t("comma separated")} /></span>
          <input className="in" value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="production, api, eu" />
        </label>
        {f.type === "heartbeat" && (
          <label className="fld">{t("Grace period")}
            <Select className="in" value={f.graceSec} onChange={(v) => set("graceSec", v)} options={[{ value: 0, label: t("None") }, { value: 60, label: t("1 minute") }, { value: 300, label: t("5 minutes") }, { value: 900, label: t("15 minutes") }]} />
          </label>
        )}
        {others.length > 0 && (
          <label className="fld"><span>{t("Depends on")} <Hint text={`${t("A dependency is another monitor this one relies on, such as a gateway or your network. While it is down, this monitor stays quiet instead of alerting you about the same outage twice.")} ${t("While that monitor is down, this one opens no incidents and sends no alerts.")}`} /></span>
            <Select className="in" value={f.dependsOnMonitorId ?? ""} onChange={(v) => set("dependsOnMonitorId", v || null)}
              options={[{ value: "", label: t("Nothing") }, ...others.map((o) => ({ value: o.id, label: o.name }))]} />
          </label>
        )}
        {channels.length > 0 && (
          <div className="fld"><span>{t("Alert")} <Hint text={t("none selected = all channels")} /></span>
            {channels.map((c) => {
              // a new monitor always gets the channels that are on for new monitors; remove one from the monitor afterwards
              const locked = !monitor && !!c.autoEnable && c.enabled;
              const on = locked || f.channelIds.includes(c.id);
              return (
                <button type="button" key={c.id} className="route tog" disabled={locked} onClick={() => set("channelIds", on ? f.channelIds.filter((x) => x !== c.id) : [...f.channelIds, c.id])}>
                  <div><b style={{ fontWeight: 500 }}>{c.name}</b><small>{c.type}{locked ? ` · ${t("on for new monitors")}` : ""}</small></div>
                  <span className={`tg ${on ? "on" : ""}`} />
                </button>
              );
            })}
          </div>
        )}
        {PROBED.includes(f.type) && places.length > 1 && f.regions.length > 1 && (
          <label className="fld"><span>{t("Go down when")} <Hint text={t("Fewer failing regions are recorded but do not open an incident.")} /></span>
            <Select className="in" value={Math.min(f.minRegionsFailing, f.regions.length)} onChange={(v) => set("minRegionsFailing", v)}
              options={[{ value: 0, label: t("Most regions fail") }, ...Array.from({ length: f.regions.length }, (_, i) => ({ value: i + 1, label: t(i === 0 ? "Any region fails" : "{n} regions fail").replace("{n}", String(i + 1)) }))]} />
          </label>
        )}
        {PROBED.includes(f.type) && places.length > 1 && (
          <div className="fld region-fld">{t("Check from")} {Number.isFinite(maxRegions) && <span className="faint">({t("up to {n}").replace("{n}", String(maxRegions))})</span>}
            {/* collapsed to what is selected; the full list only opens on request */}
            <button type="button" className="region-sum" aria-expanded={regionsOpen} onClick={() => setRegionsOpen((o) => !o)}>
              <span className="names">{choices.filter((p) => f.regions.includes(p.id)).map((p) => p.name).join(", ") || t("Auto")}</span>
              <span className="faint">{regionsOpen ? t("Done") : t("Change")}</span>
            </button>
            {regionsOpen && (
              <>
                <div className="region-grid">
                  {choices.map((p) => {
                    const on = f.regions.includes(p.id);
                    const full = regionLocked(f.regions, p.id, maxRegions);
                    return (
                      <button type="button" key={p.id} className={`region-opt ${on ? "on" : ""}`} aria-pressed={on} disabled={full}
                        title={full ? t("Your plan cannot check from that many regions.") : p.id === "auto" ? t("Auto is this deployment's own location") : known.has(p.id) ? undefined : t("No longer available")}
                        onClick={() => set("regions", toggleRegion(f.regions, p.id, maxRegions))}>
                        <span className="region-opt-mark">{on ? "✓" : ""}</span>{p.name}
                      </button>
                    );
                  })}
                </div>
                <small className="faint">{t("Auto is this deployment's own location")}</small>
              </>
            )}
          </div>
        )}
    </Modal>
  );
}
