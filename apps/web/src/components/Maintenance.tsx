import { useEffect, useState } from "react";
import { useBusy } from "../lib/use-busy";
import { api, type Maintenance as Window, type Monitor } from "../lib/api";
import { t } from "../lib/i18n";

const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export default function Maintenance() {
  const [items, setItems] = useState<Window[] | null>(null);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [f, setF] = useState({ name: "", startsAt: local(new Date()), endsAt: local(new Date(Date.now() + 3600_000)), monitorIds: [] as string[] });
  const [err, setErr] = useState("");
  const [busy, run] = useBusy();
  const [removing, setRemoving] = useState("");
  const load = () => api.maintenance().then(setItems);
  useEffect(() => { load(); api.monitors().then(setMonitors); }, []);

  async function add(e: React.SyntheticEvent) {
    e.preventDefault();
    setErr("");
    await run(async () => {
      try {
        await api.createMaintenance({ name: f.name, monitorIds: f.monitorIds, startsAt: new Date(f.startsAt).toISOString(), endsAt: new Date(f.endsAt).toISOString() });
        setF({ ...f, name: "", monitorIds: [] });
        await load();
      } catch (e) { setErr((e as Error).message); }
    });
  }
  const state = (w: Window) => {
    const now = Date.now();
    return now < +new Date(w.startsAt) ? "upcoming" : now > +new Date(w.endsAt) ? "ended" : "active";
  };
  const fmt = (s: string) => new Date(s).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const names = (w: Window) => (w.monitorIds.length ? w.monitorIds.map((id) => monitors.find((m) => m.id === id)?.name ?? "…").join(", ") : t("All monitors"));

  return (
    <>
      <div className="ph"><div><h1>{t("Maintenance")}</h1><p className="muted">{t("Checks keep running, but no incidents or alerts are created during a window.")}</p></div></div>
      <div className="card tbl" style={{ marginBottom: 24 }}>
        <div className="tr th" style={{ gridTemplateColumns: "minmax(0,1.8fr) minmax(0,1fr) 110px 100px" }}><span>{t("Window")}</span><span>{t("Covers")}</span><span>{t("State")}</span><span /></div>
        {items?.length === 0 && <div className="tr" style={{ gridTemplateColumns: "1fr" }}><span className="muted">{t("No maintenance windows.")}</span></div>}
        {items?.map((w) => (
          <div className="tr" key={w.id} style={{ gridTemplateColumns: "minmax(0,1.8fr) minmax(0,1fr) 110px 100px" }}>
            <div><b style={{ fontWeight: 600 }}>{w.name}</b><small><span style={{ whiteSpace: "nowrap" }}>{fmt(w.startsAt)}</span> <span style={{ whiteSpace: "nowrap" }}>→ {fmt(w.endsAt)}</span></small></div>
            <span className="muted">{names(w)}</span>
            <span><span className={`pill ${state(w) === "active" ? "degraded" : ""}`}>{t(state(w))}</span></span>
            <button className="btn sm" disabled={removing === w.id} onClick={async () => {
              if (!confirm(t("Remove this window?"))) return;
              setRemoving(w.id);
              try { await api.deleteMaintenance(w.id); await load(); } catch (e) { setErr((e as Error).message); } finally { setRemoving(""); }
            }}>{removing === w.id ? t("Removing…") : t("Remove")}</button>
          </div>
        ))}
      </div>
      <form className="card" style={{ padding: 24, display: "grid", gap: 14, maxWidth: 560 }} onSubmit={add}>
        <b>{t("Schedule maintenance")}</b>
        <label className="fld">{t("Name")}<input className="in" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={t("Database upgrade")} /></label>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10 }}>
          <label className="fld">{t("Starts")}<input className="in" type="datetime-local" required value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></label>
          <label className="fld">{t("Ends")}<input className="in" type="datetime-local" required value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} /></label>
        </div>
        {monitors.length > 0 && (
          <fieldset style={{ border: 0, padding: 0, display: "grid", gap: 6 }}>
            <legend style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 6 }}>{t("Monitors")} <span className="faint">({t("none selected = all monitors")})</span></legend>
            {monitors.map((m) => (
              <label key={m.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
                <input type="checkbox" checked={f.monitorIds.includes(m.id)}
                  onChange={(e) => setF({ ...f, monitorIds: e.target.checked ? [...f.monitorIds, m.id] : f.monitorIds.filter((x) => x !== m.id) })} />
                {m.name}
              </label>
            ))}
          </fieldset>
        )}
        {err && <p className="err">{err}</p>}
        <div><button className="btn primary" disabled={busy}>{busy ? t("Scheduling…") : t("Schedule")}</button></div>
      </form>
    </>
  );
}
