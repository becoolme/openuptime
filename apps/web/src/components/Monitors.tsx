import Select from "./Select";
import { t } from "../lib/i18n";
import { useEffect, useState } from "react";
import { ago, api, type Channel, type Incident, type Monitor, type ProjectOverview } from "../lib/api";
import { regionLocked, toggleRegion } from "../lib/regions";
import { isAllProjects } from "../lib/scope";
import { ProjectBadge, ProjectStrip, ScopeChip, useProjects } from "./AllProjects";

const TYPE_LABEL: Record<Monitor["type"], string> = { http: "HTTP", tcp: "TCP", dns: "DNS", heartbeat: "CRON", postgres: "PG", mysql: "MYSQL", redis: "REDIS" };

export function Spark({ data, status }: { data: (number | null)[]; status: string }) {
  const pts = data.filter((v): v is number => v != null);
  const color = status === "down" ? "var(--down)" : status === "degraded" ? "var(--warn)" : "var(--accent)";
  // not enough for a line yet: a dashed baseline, with a dot for the one result there is
  if (pts.length < 2) return <svg className="sp" viewBox="0 0 140 30"><path d="M0 15h140" stroke="var(--line-2)" strokeWidth="1.5" strokeDasharray="3 4" fill="none" />{pts.length === 1 && <circle cx="132" cy="15" r="3.5" fill={color} />}</svg>;
  const lo = Math.min(...pts), hi = Math.max(...pts), span = Math.max(1, hi - lo);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${((i / (pts.length - 1)) * 140).toFixed(1)} ${(26 - ((v - lo) / span) * 22).toFixed(1)}`).join("");
  return <svg className="sp" viewBox="0 0 140 30" preserveAspectRatio="none"><path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

export default function Monitors() {
  const [items, setItems] = useState<Monitor[] | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [setup, setSetup] = useState({ channels: false, pages: false });
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"all" | "up" | "down" | "paused">("all");
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
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
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
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
  const down = all.filter((m) => m.status === "down");
  const paused = all.filter((m) => m.paused);
  const upN = all.filter((m) => m.status === "up" || m.status === "degraded").length;
  const withUp = all.filter((m) => m.uptime24h != null);
  const avgUp = withUp.length ? withUp.reduce((a, m) => a + (m.uptime24h as number), 0) / withUp.length : null;
  const withLat = all.filter((m) => m.avgLatency24h != null);
  const avgLat = withLat.length ? Math.round(withLat.reduce((a, m) => a + (m.avgLatency24h as number), 0) / withLat.length) : null;
  const openInc = incidents.filter((i) => i.status !== "resolved");
  const shown = all.filter((m) => {
    if (tab === "up" && !(m.status === "up" || m.status === "degraded")) return false;
    if (tab === "down" && m.status !== "down") return false;
    if (tab === "paused" && !m.paused) return false;
    const n = q.trim().toLowerCase();
    if (tag && !(m.tags ?? []).includes(tag)) return false;
    return !n || m.name.toLowerCase().includes(n) || m.target.toLowerCase().includes(n) || (m.tags ?? []).some((x) => x.toLowerCase().includes(n));
  });
  const allTags = [...new Set(all.flatMap((m) => m.tags ?? []))].sort();

  async function importFile(file: File) {
    setNote(null);
    try {
      const res = await fetch("/api/monitors/import", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: await file.text() });
      const j = (await res.json().catch(() => ({}))) as { created?: number; skipped?: { index: number; name: string | null; error: string }[]; error?: string };
      if (j.error) throw new Error(j.error);
      const sk = j.skipped ?? [];
      setNote({
        ok: (j.created ?? 0) > 0,
        text: `${t("Imported")} ${j.created ?? 0}${sk.length ? ` · ${t("skipped")} ${sk.length}: ${sk.slice(0, 3).map((s) => `#${s.index + 1} ${s.name ?? ""} (${s.error})`).join("; ")}${sk.length > 3 ? " …" : ""}` : ""}`,
      });
      load();
      window.dispatchEvent(new Event("ou:changed"));
    } catch (e) {
      setNote({ ok: false, text: `${t("Import failed")}: ${(e as Error).message}` });
    }
  }
  const tabs: ["all" | "up" | "down" | "paused", string, number][] = [["all", "All", all.length], ["up", "Up", upN], ["down", "Down", down.length], ["paused", "Paused", paused.length]];

  return (
    <>
      <div className="ph">
        <div>
          <h1>{t("Monitors")}{everything && <ScopeChip />}</h1>
          <p className="muted">
            {items === null ? t("Loading…") : down.length ? `${down.length} ${t("down right now")}` : all.length ? t("Everything is up.") : t("Nothing is being watched yet.")}
          </p>
        </div>
        {!everything && <div className="acts">
          <input id="mon-import" type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) importFile(f); }} />
          <button className="btn" onClick={() => document.getElementById("mon-import")?.click()}>{t("Import")}</button>
          {all.length > 0 && <a className="btn" href="/api/monitors/export" download="openuptime-monitors.json">{t("Export")}</a>}
          <button className="btn primary" onClick={() => setOpen(true)}>{t("+ New monitor")}</button>
        </div>}
      </div>
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

      {items?.length === 0 && everything ? (
        <div className="empty"><h3 style={{ fontSize: 28 }}>{t("No monitors yet")}</h3><p className="muted">{t("Choose a project to add the first one.")}</p></div>
      ) : items?.length === 0 ? (
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
          <div className="empty">
            <h3 style={{ fontSize: 26 }}>{t("No monitors yet")}</h3>
            <p className="muted" style={{ margin: "6px 0 18px" }}>{t("Add a URL and we’ll check it every minute.")}</p>
            <button className="btn primary" onClick={() => setOpen(true)}>{t("+ Add your first monitor")}</button>
          </div>
        </div>
      ) : (
        <>
          <div className="tool">
            <div className="ftabs">
              {tabs.map(([k, label, n]) => (
                <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{t(label)} <em>{n}</em></button>
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
          <div className="card tbl mon-tbl">
            <div className="tr th"><span>{t("Monitor")}</span><span>{t("Status")}</span><span>{t("Response")}</span><span>{t("Uptime 24h")}</span><span>{t("Latency")}</span><span>{t("Checked")}</span></div>
            {shown.map((m) => (
              <a className="tr" key={m.id} href={`/app/monitors/${m.id}`}>
                <div className="nm">
                  <span className="chip">{TYPE_LABEL[m.type]}</span>
                  <div style={{ minWidth: 0 }}><b>{m.name}</b><small>{everything && <ProjectBadge id={m.projectId} projects={projects} />}{m.target || m.type}{(m.tags ?? []).length > 0 && ` · ${(m.tags ?? []).map((x) => `#${x}`).join(" ")}`}</small></div>
                </div>
                <span><span className={`pill ${m.status}`}>{t(m.status)}</span></span>
                <span className="spk"><Spark data={m.spark ?? []} status={m.status} /></span>
                <span className="num">{m.uptime24h == null ? "—" : `${m.uptime24h}%`}</span>
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

/** Create a monitor, or edit one when `monitor` is given (its type is fixed). */
export function MonitorForm({ monitor, onClose, onSaved }: { monitor?: Monitor; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: monitor?.name ?? "", type: monitor?.type ?? ("http" as Monitor["type"]), target: monitor?.target ?? "https://",
    method: monitor?.method ?? "GET", intervalSec: monitor?.intervalSec ?? 60, expectedStatus: monitor?.expectedStatus ?? 200, failureThreshold: monitor?.failureThreshold ?? 3,
    keyword: monitor?.keyword ?? "", keywordMode: monitor?.keywordMode ?? ("contains" as "contains" | "absent"),
    graceSec: monitor?.graceSec ?? 0, channelIds: monitor?.channelIds ?? ([] as string[]),
    slowThresholdMs: monitor?.slowThresholdMs ?? 1500, slowAlertAfter: monitor?.slowAlertAfter ?? 0,
    regions: monitor?.regions?.length ? monitor.regions : ["auto"],
    dependsOnMonitorId: monitor?.dependsOnMonitorId ?? (null as string | null), minRegionsFailing: monitor?.minRegionsFailing ?? 0,
  });
  // the project's other monitors, to pick the one this depends on
  const [others, setOthers] = useState<Monitor[]>([]);
  useEffect(() => { api.monitors().then((l) => setOthers(l.filter((x) => x.id !== monitor?.id))).catch(() => {}); }, []);
  const [tagText, setTagText] = useState((monitor?.tags ?? []).join(", "));
  const [hdrs, setHdrs] = useState<{ k: string; v: string }[]>(Object.entries(monitor?.headers ?? {}).map(([k, v]) => ({ k, v })));
  const setHdr = (i: number, p: Partial<{ k: string; v: string }>) => setHdrs((h) => h.map((r, j) => (j === i ? { ...r, ...p } : r)));
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
  // where checks can run from on this deployment; with only `auto` the whole section stays out of the form
  const [places, setPlaces] = useState<{ id: string; name: string }[]>([]);
  const [maxRegions, setMaxRegions] = useState(1);
  useEffect(() => {
    api.regions().then((r) => { setPlaces(r.regions); setMaxRegions(r.maxPerMonitor ?? Infinity); }).catch(() => {});
  }, []);
  const [regionsOpen, setRegionsOpen] = useState(false);
  const known = new Set(places.map((p) => p.id));
  // a saved region this deployment no longer offers stays listed so it can be switched off
  const choices = [...places, ...(monitor?.regions ?? []).filter((r) => !known.has(r)).map((id) => ({ id, name: id }))];
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));

  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    setUpgrade(undefined);
    try {
      const headers = f.type === "http" ? Object.fromEntries(hdrs.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v])) : {};
      const tags = [...new Set(tagText.split(/[,，\n]/).map((x) => x.trim().replace(/^#/, "")).filter(Boolean))];
      const { regions, ...rest } = f;
      // only http and tcp checks can run from a region; leaving the field out keeps the stored value
      const probed = (f.type === "http" || f.type === "tcp") && places.length > 1;
      const payload = { ...rest, ...(probed ? { regions } : {}), tags, headers, keyword: f.type === "http" && f.keyword ? f.keyword : null };
      if (monitor) {
        const { type: _t, ...patch } = payload;
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
    <div className="modal" onClick={onClose}>
      <form className="card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 style={{ fontSize: 30 }}>{monitor ? t("Edit monitor") : t("New monitor")}</h2>
        <label className="fld">{t("Name")}<input className="in" required autoFocus value={f.name} onChange={(e) => set("name", e.target.value)} placeholder={t("Production API")} /></label>
        <div className="fld">{t("Type")}
          <div className="type-grid">
            {([["http", "HTTP(S)", "Status code and keyword checks on a URL."], ["tcp", "TCP port", "Open a connection to host:port."], ["dns", "DNS", "Resolve a hostname."], ["postgres", "PostgreSQL", "Checks that a PostgreSQL server answers."], ["mysql", "MySQL / MariaDB", "Checks that the server sends its handshake."], ["redis", "Redis", "Sends PING and expects PONG."], ["heartbeat", "Heartbeat (cron)", "Your job pings us on schedule."]] as const).map(([id, label, desc]) => (
              <button type="button" key={id} disabled={!!monitor && monitor.type !== id} className={`type-c ${f.type === id ? "on" : ""}`} onClick={() => { set("type", id); if (!monitor && (f.target === "https://" || f.target === "")) set("target", id === "http" ? "https://" : ""); }}>
                <b>{t(label)}</b><small>{t(desc)}</small>
              </button>
            ))}
          </div>
        </div>
        {f.type !== "heartbeat" && (
          <label className="fld">{t(f.type === "http" ? "URL" : ["tcp", "postgres", "mysql", "redis"].includes(f.type) ? "Host:port" : "Hostname")}
            <input className="in mono" required value={f.target} onChange={(e) => set("target", e.target.value)} placeholder={({ postgres: "db.example.com:5432", mysql: "db.example.com:3306", redis: "cache.example.com:6379", tcp: "example.com:443" } as Record<string, string>)[f.type] ?? ""} />
          </label>
        )}
        <div className="fld">{t("Check every")}
          <div className="seg">
            {![60, 300, 900].includes(f.intervalSec) && <i className="on">{f.intervalSec}s</i>}
            {([[60, "1 minute"], [300, "5 minutes"], [900, "15 minutes"]] as const).map(([v, l]) => {
              const locked = f.type !== "heartbeat" && v < floor && v < (monitor?.intervalSec ?? Infinity);
              return <i key={v} className={`${f.intervalSec === v ? "on" : ""}${locked ? " locked" : ""}`} title={locked ? t("Not available on your plan") : undefined} onClick={() => !locked && set("intervalSec", v)}>{t(l)}</i>;
            })}
          </div>
        </div>
        {f.type !== "heartbeat" && (
          <div style={{ display: "grid", gridTemplateColumns: f.type === "http" ? "1fr 1fr" : "1fr", gap: 10 }}>
            {f.type === "http" && (
              <label className="fld">{t("Method")}
                <Select className="in mono" value={f.method} onChange={(v) => set("method", v)} options={["GET", "HEAD", "POST"].map((m) => ({ value: m, label: m }))} />
              </label>
            )}
            {f.type === "http" && (
              <label className="fld">{t("Expected status")}
                <input className="in mono" type="number" min={100} max={599} value={f.expectedStatus} onChange={(e) => set("expectedStatus", Number(e.target.value) || 200)} />
              </label>
            )}
            <label className="fld">{t("Failures before incident")}
              <Select className="in" value={f.failureThreshold} onChange={(v) => set("failureThreshold", v)} options={[1, 2, 3, 5, 10].map((n) => ({ value: n, label: String(n) }))} />
            </label>
          </div>
        )}
        {f.type === "http" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 130px", gap: 10 }}>
            <label className="fld">{t("Response must contain (optional)")}
              <input className="in mono" value={f.keyword} onChange={(e) => set("keyword", e.target.value)} placeholder="OK" />
            </label>
            <label className="fld">{t("Mode")}
              <Select className="in" value={f.keywordMode as string} onChange={(v) => set("keywordMode", v as "contains" | "absent")} options={[{ value: "contains", label: t("must contain") }, { value: "absent", label: t("must not contain") }]} />
            </label>
          </div>
        )}
        {f.type === "http" && (
          <div className="fld">
            {t("Request headers")}
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
        <label className="fld">{t("Tags")} <span className="faint">({t("comma separated")})</span>
          <input className="in" value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="production, api, eu" />
        </label>
        {f.type === "heartbeat" && (
          <label className="fld">{t("Grace period")}
            <Select className="in" value={f.graceSec} onChange={(v) => set("graceSec", v)} options={[{ value: 0, label: t("None") }, { value: 60, label: t("1 minute") }, { value: 300, label: t("5 minutes") }, { value: 900, label: t("15 minutes") }]} />
          </label>
        )}
        {others.length > 0 && (
          <label className="fld">{t("Depends on")}
            <Select className="in" value={f.dependsOnMonitorId ?? ""} onChange={(v) => set("dependsOnMonitorId", v || null)}
              options={[{ value: "", label: t("Nothing") }, ...others.map((o) => ({ value: o.id, label: o.name }))]} />
            <small className="faint">{t("While that monitor is down, this one opens no incidents and sends no alerts.")}</small>
          </label>
        )}
        {channels.length > 0 && (
          <div className="fld">{t("Alert")} <span className="faint">({t("none selected = all channels")})</span>
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
        {(f.type === "http" || f.type === "tcp") && places.length > 1 && f.regions.length > 1 && (
          <label className="fld">{t("Go down when")}
            <Select className="in" value={Math.min(f.minRegionsFailing, f.regions.length)} onChange={(v) => set("minRegionsFailing", v)}
              options={[{ value: 0, label: t("Most regions fail") }, ...Array.from({ length: f.regions.length }, (_, i) => ({ value: i + 1, label: t(i === 0 ? "Any region fails" : "{n} regions fail").replace("{n}", String(i + 1)) }))]} />
            <small className="faint">{t("Fewer failing regions are recorded but do not open an incident.")}</small>
          </label>
        )}
        {(f.type === "http" || f.type === "tcp") && places.length > 1 && (
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
        <div className="est"><b>≈ {Math.round((30 * 86400) / Math.max(1, f.intervalSec) * ((f.type === "http" || f.type === "tcp") ? Math.max(1, new Set(f.regions).size) : 1)).toLocaleString()} {t("checks / month")}</b>{(f.type === "http" || f.type === "tcp") && new Set(f.regions).size > 1 && <small> · {t("each region counts as a check")}</small>}</div>
        {err && <p className="err">{err}{upgrade && <> <a href={upgrade}>{t("Upgrade")}</a></>}</p>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>{t("Cancel")}</button>
          <button className="btn primary" disabled={busy}>{busy ? t(monitor ? "Saving…" : "Creating…") : monitor ? t("Save") : t("Create monitor")}</button>
        </div>
      </form>
    </div>
  );
}
