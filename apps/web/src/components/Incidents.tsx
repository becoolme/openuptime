import Select from "./Select";
import { navigate } from "../lib/nav";
import { t } from "../lib/i18n";
import { useEffect, useState } from "react";
import { ago, api, type Incident, type Monitor } from "../lib/api";
import { useBusy } from "../lib/use-busy";

const DAY = 86400_000;
const dur = (a: string, b: string | null) => {
  const m = Math.max(0, Math.round(((b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime()) / 60000));
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d`;
};
const avgMin = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length / 60000 : null);
const fmtMin = (v: number | null) => (v == null ? "—" : v < 60 ? <>{v < 10 ? v.toFixed(1) : Math.round(v)}<u>min</u></> : <>{(v / 60).toFixed(1)}<u>h</u></>);

export default function Incidents() {
  const [items, setItems] = useState<Incident[] | null>(null);
  const [tab, setTab] = useState<"all" | "open" | "resolved">("all");
  const [q, setQ] = useState("");
  const [declaring, setDeclaring] = useState(false);
  const load = () => api.incidents().then(setItems);
  useEffect(() => { load(); }, []);

  const now = Date.now();
  const all = items ?? [];
  const open = all.filter((i) => i.status !== "resolved");
  const resolved = all.filter((i) => i.status === "resolved");
  const cur = all.filter((i) => now - new Date(i.startedAt).getTime() < 90 * DAY);
  const prev = all.filter((i) => { const a = now - new Date(i.startedAt).getTime(); return a >= 90 * DAY && a < 180 * DAY; });
  const mtta = avgMin(cur.filter((i) => i.acknowledgedAt).map((i) => new Date(i.acknowledgedAt!).getTime() - new Date(i.startedAt).getTime()));
  const mttr = avgMin(cur.filter((i) => i.resolvedAt).map((i) => new Date(i.resolvedAt!).getTime() - new Date(i.startedAt).getTime()));
  const byTab = tab === "open" ? open : tab === "resolved" ? resolved : all;
  const needle = q.trim().toLowerCase();
  const num = /^(?:inc-?)?(\d+)$/.exec(needle)?.[1];
  const shown = needle ? byTab.filter((i) => (num != null && String(i.number) === num) || i.title.toLowerCase().includes(needle)) : byTab;
  const delta = prev.length ? cur.length - prev.length : null;

  return (
    <>
      <div className="ph">
        <div><h1 className="serif">{t("Incidents")}</h1><p className="muted">{t("Everything that went wrong, and how fast we fixed it.")}</p></div>
        <div className="ph-actions">
          <a className="btn" href="/app/maintenance">{t("Schedule maintenance")}</a>
          <button className="btn primary" onClick={() => setDeclaring(true)}>
            <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>{t("Declare incident")}
          </button>
        </div>
      </div>

      <div className="kp">
        <div className="card"><small>{t("Open now")}</small><b>{open.length}</b><div className={`d ${open.length ? "bad" : ""}`}>{open[0]?.monitorName ?? (open.length ? t("Investigating") : t("All clear"))}</div></div>
        <div className="card"><small>MTTA</small><b>{fmtMin(mtta)}</b><div className="d faint">{t("time to acknowledge")}</div></div>
        <div className="card"><small>MTTR</small><b>{fmtMin(mttr)}</b><div className="d faint">{t("time to resolve")}</div></div>
        <div className="card"><small>{t("Incidents · 90 days")}</small><b>{cur.length}</b>
          <div className={`d ${delta == null ? "faint" : delta > 0 ? "bad" : ""}`}>{delta == null ? t("No previous period") : `${delta > 0 ? "▲" : delta < 0 ? "▼" : "="} ${Math.abs(delta)} ${t("vs. prev. period")}`}</div>
        </div>
      </div>

      <div className="tool">
        <div className="ftabs">
          {([["all", "All", all.length], ["open", "Open", open.length], ["resolved", "Resolved", resolved.length]] as const).map(([k, l, n]) => (
            <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{t(l)} <em>{n}</em></button>
          ))}
        </div>
        <input className="in" style={{ maxWidth: 220 }} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search or INC-12")} aria-label={t("Search incidents")} />
      </div>

      {items && shown.length === 0 ? (
        <div className="empty"><h3 style={{ fontSize: 28 }}>{t("No incidents")}</h3><p className="muted">{t("Quiet is good.")}</p></div>
      ) : (
        <div className="card tbl inc-tbl">
          <div className="tr th"><span>{t("Incident")}</span><span>{t("Status")}</span><span>{t("Started")}</span><span>{t("Duration")}</span><span>{t("Affected")}</span></div>
          {shown.map((i) => (
            <a className="tr" key={i.id} href={`/app/incidents/${i.id}`}>
              <div className="nm"><span className={`dot ${i.status === "resolved" ? "up" : i.severity === "minor" ? "warn" : "down"}`} /><div><b>{i.title}</b><small title={i.evaluationNote ?? undefined}>{i.number ? `INC-${i.number}` : `#${i.id.slice(0, 6)}`}{i.auto ? ` · ${t("auto")}` : ""}{i.evaluationNote ? ` · ${i.evaluationNote}` : ""}</small></div></div>
              <span><span className={`pill ${i.status === "resolved" ? "resolved" : "down"}`}>{t(i.status)}</span></span>
              <span className="muted">{ago(i.startedAt)}</span>
              <span className="num mono">{i.resolvedAt || i.status !== "resolved" ? dur(i.startedAt, i.resolvedAt) : "—"}</span>
              <span className="muted" style={{ fontSize: 13.5 }}>{i.monitorName ?? "—"}</span>
            </a>
          ))}
        </div>
      )}
      {declaring && <Declare onClose={() => setDeclaring(false)} onDone={(id) => navigate(`/app/incidents/${id}`)} />}
    </>
  );
}

function Declare({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sev, setSev] = useState<"minor" | "major">("major");
  const [mon, setMon] = useState("");
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [err, setErr] = useState("");
  const [busy, run] = useBusy();
  useEffect(() => { api.monitors().then(setMonitors).catch(() => {}); }, []);
  return (
    <div className="modal" onClick={onClose}>
      <form className="card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => {
        e.preventDefault();
        setErr("");
        run(async () => {
          try { const i = await api.declareIncident({ title, body: body || undefined, severity: sev, monitorId: mon || null }); onDone(i.id); }
          catch (x) { setErr((x as Error).message); }
        });
      }}>
        <h2 style={{ fontSize: 30 }}>{t("Declare incident")}</h2>
        <label className="fld">{t("Title")}<input className="in" required autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("Payments are failing")} /></label>
        <label className="fld">{t("Affected monitor")}
          <Select className="in" value={mon} onChange={setMon} options={[{ value: "", label: t("None") }, ...monitors.map((m) => ({ value: m.id, label: m.name }))]} />
        </label>
        <div className="fld">{t("Severity")}
          <div className="seg">{(["major", "minor"] as const).map((s) => <i key={s} className={sev === s ? "on" : ""} onClick={() => setSev(s)}>{t(s)}</i>)}</div>
        </div>
        <label className="fld">{t("What do customers need to know?")}<textarea className="in" style={{ height: 90, padding: 12 }} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        {err && <p className="err">{err}</p>}
        <div className="formact"><button type="button" className="btn" onClick={onClose}>{t("Cancel")}</button><button className="btn primary" disabled={busy}>{busy ? t("Declaring…") : t("Declare incident")}</button></div>
      </form>
    </div>
  );
}
