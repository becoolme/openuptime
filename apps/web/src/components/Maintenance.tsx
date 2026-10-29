import { useEffect, useState } from "react";
import { useBusy } from "../lib/use-busy";
import { api, type Maintenance as Window, type Monitor } from "../lib/api";
import { t } from "../lib/i18n";

const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export default function Maintenance() {
  const [items, setItems] = useState<Window[] | null>(null);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [f, setF] = useState({ name: "", startsAt: local(new Date()), endsAt: local(new Date(Date.now() + 3600_000)), monitorIds: [] as string[], frequency: "none", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", until: local(new Date(Date.now() + 90 * 86400_000)) });
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
        await api.createMaintenance({ name: f.name, monitorIds: f.monitorIds, startsAt: new Date(f.startsAt).toISOString(), endsAt: new Date(f.endsAt).toISOString(), recurrence: f.frequency === "none" ? null : { frequency: f.frequency as "daily" | "weekly", timeZone: f.timeZone, until: new Date(f.until).toISOString() } });
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
        <div className="tr th" style={{ gridTemplateColumns: "minmax(0,1.8fr) minmax(0,1fr) 110px 150px" }}><span>{t("Window")}</span><span>{t("Covers")}</span><span>{t("State")}</span><span /></div>
        {items?.length === 0 && <div className="tr" style={{ gridTemplateColumns: "1fr" }}><span className="muted">{t("No maintenance windows.")}</span></div>}
        {items?.map((w) => (
          <div className="tr" key={w.id} style={{ gridTemplateColumns: "minmax(0,1.8fr) minmax(0,1fr) 110px 150px" }}>
            <div><b style={{ fontWeight: 600 }}>{w.name}</b><small><span style={{ whiteSpace: "nowrap" }}>{fmt(w.startsAt)}</span> <span style={{ whiteSpace: "nowrap" }}>→ {fmt(w.endsAt)}</span></small>{w.recurrence && <small>{t(w.recurrence.frequency === "daily" ? "Daily" : "Weekly")} · {w.recurrence.timeZone}</small>}</div>
            <span className="muted">{names(w)}</span>
            <span><span className={`pill ${state(w) === "active" ? "degraded" : ""}`}>{t(state(w))}</span></span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}><button className="btn sm" disabled={removing === w.id} onClick={async () => {
              if (!confirm(t("Remove this window?"))) return;
              setRemoving(w.id);
              try { await api.deleteMaintenance(w.id); await load(); } catch (e) { setErr((e as Error).message); } finally { setRemoving(""); }
            }}>{removing === w.id ? t("Removing…") : t(w.seriesId && state(w) === "upcoming" ? "Skip once" : "Remove")}</button>
            {state(w) === "active" && <button className="btn sm" disabled={removing === w.id} onClick={async () => {
              setRemoving(w.id); try { await api.endMaintenance(w.id); await load(); } catch (e) { setErr((e as Error).message); } finally { setRemoving(""); }
            }}>{t("End now")}</button>}
            {w.seriesId && state(w) !== "ended" && <button className="btn sm" disabled={removing === w.id} onClick={async () => {
              if (!confirm(t("Cancel future occurrences and end any active window in this series?"))) return;
              setRemoving(w.id); try { await api.cancelMaintenanceSeries(w.seriesId!); await load(); } catch (e) { setErr((e as Error).message); } finally { setRemoving(""); }
            }}>{t("Cancel series")}</button>}</div>
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
        <p className="muted">{t("Start, end and repeat-until inputs use your browser time zone.")}</p>
        <label className="fld">{t("Repeat")}<select className="in" value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}>
          <option value="none">{t("Does not repeat")}</option><option value="daily">{t("Daily")}</option><option value="weekly">{t("Weekly")}</option>
        </select></label>
        {f.frequency !== "none" && <>
          <label className="fld">{t("Recurrence time zone")}<input className="in" required value={f.timeZone} onChange={(e) => setF({ ...f, timeZone: e.target.value })} placeholder="America/Toronto" /></label>
          <p className="muted">{t("Repeats at the first start's local clock time in this zone. Duration stays fixed; skipped spring times move forward and repeated autumn times use the later occurrence.")}</p>
          <p className="mono">{(() => { try { return new Date(f.startsAt).toLocaleString([], { timeZone: f.timeZone, dateStyle: "medium", timeStyle: "short" }); } catch { return "—"; } })()}</p>
          <label className="fld">{t("Repeat until")}<input className="in" type="datetime-local" required value={f.until} onChange={(e) => setF({ ...f, until: e.target.value })} /></label>
          <p className="muted">{t("Choose an end within 366 days; each window may last up to 24 hours. Skip individual occurrences or cancel the series below.")}</p>
        </>}
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
