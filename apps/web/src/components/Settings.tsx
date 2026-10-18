import { t } from "../lib/i18n";
import { useEffect, useState } from "react";
import { useBusy } from "../lib/use-busy";
import { api } from "../lib/api";
import { authClient } from "../lib/auth-client";

export default function Settings() {
  const [name, setName] = useState("");
  const [orig, setOrig] = useState("");
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  const [busy, run] = useBusy();
  const [days, setDays] = useState(30);
  const [daysOrig, setDaysOrig] = useState(30);
  const [daysSaved, setDaysSaved] = useState(false);
  const [daysErr, setDaysErr] = useState("");
  const [daysBusy, runDays] = useBusy();
  const [cdays, setCdays] = useState(90);
  const [cdaysOrig, setCdaysOrig] = useState(90);
  const [cSaved, setCSaved] = useState(false);
  const [cErr, setCErr] = useState("");
  const [cBusy, runC] = useBusy();
  const [report, setReport] = useState(false);
  const [reportErr, setReportErr] = useState("");
  useEffect(() => {
    api.settings().then((s) => { setReport(s.monthlyReport); setDays(s.alertLogRetentionDays); setDaysOrig(s.alertLogRetentionDays); setCdays(s.checkRetentionDays); setCdaysOrig(s.checkRetentionDays); }).catch(() => {});
    api.me().then((m) => { setName(m.organization.name); setOrig(m.organization.name); });
  }, []);
  async function save(e: React.SyntheticEvent) {
    e.preventDefault();
    setErr("");
    const res = await run(() => authClient.organization.update({ data: { name } }).catch((e: Error) => ({ error: { message: e.message } })));
    if (res?.error) return setErr(res.error.message ?? "Could not save");
    setSaved(true);
    setTimeout(() => location.reload(), 600);
  }
  return (
    <>
      <div className="ph"><div><h1>{t("Settings")}</h1><p className="muted">{t("Workspace-level preferences.")}</p></div></div>
      <div className="set-wrap">
        <form className="card sect" onSubmit={save}>
          <h3>{t("General")}</h3>
          <p className="muted">{t("The name your team sees across OpenUptime.")}</p>
          <label className="fld">{t("Workspace name")}<input className="in" required value={name} onChange={(e) => setName(e.target.value)} /></label>
          {err && <p className="err">{err}</p>}
          <div><button className="btn primary" disabled={busy || saved || name === orig}>{busy ? t("Saving…") : saved ? t("Saved ✓") : t("Save changes")}</button></div>
        </form>
        <form className="card sect" onSubmit={async (e) => {
          e.preventDefault();
          setDaysErr("");
          setDaysSaved(false);
          await runDays(async () => {
            try { const r = await api.updateSettings({ alertLogRetentionDays: days }); setDaysOrig(r.alertLogRetentionDays); setDaysSaved(true); setTimeout(() => setDaysSaved(false), 1500); }
            catch (x) { setDaysErr((x as Error).message); }
          });
        }}>
          <h3>{t("Alert log")}</h3>
          <p className="muted">{t("How long to keep the history of sent alerts. Older entries are deleted automatically.")}</p>
          <label className="fld">{t("Retention (days)")}<input className="in" type="number" min={1} max={365} required value={days} onChange={(e) => setDays(Number(e.target.value))} /></label>
          {daysErr && <p className="err">{daysErr}</p>}
          <div><button className="btn primary" disabled={daysBusy || days === daysOrig || !Number.isInteger(days) || days < 1 || days > 365}>{daysBusy ? t("Saving…") : daysSaved ? t("Saved ✓") : t("Save changes")}</button></div>
        </form>
        <form className="card sect" onSubmit={async (e) => {
          e.preventDefault();
          setCErr("");
          setCSaved(false);
          await runC(async () => {
            try { const r = await api.updateSettings({ checkRetentionDays: cdays }); setCdaysOrig(r.checkRetentionDays); setCSaved(true); setTimeout(() => setCSaved(false), 1500); }
            catch (x) { setCErr((x as Error).message); }
          });
        }}>
          <h3>{t("Check history")}</h3>
          <p className="muted">{t("How long to keep individual check results (the response log of each monitor). Uptime percentages are summarised hourly and kept for a year, so shortening this does not change them.")}</p>
          <label className="fld">{t("Retention (days)")}<input className="in" type="number" min={1} max={365} required value={cdays} onChange={(e) => setCdays(Number(e.target.value))} /></label>
          {cErr && <p className="err">{cErr}</p>}
          <div><button className="btn primary" disabled={cBusy || cdays === cdaysOrig || !Number.isInteger(cdays) || cdays < 1 || cdays > 365}>{cBusy ? t("Saving…") : cSaved ? t("Saved ✓") : t("Save changes")}</button></div>
        </form>
        <div className="card sect">
          <h3>{t("Monthly report")}</h3>
          <p className="muted">{t("On the first days of each month, email the workspace owners last month's uptime, downtime and incidents for every monitor. Off by default.")}</p>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={report} onChange={async (e) => {
              const on = e.target.checked;
              setReportErr("");
              setReport(on);
              try { setReport((await api.updateSettings({ monthlyReport: on })).monthlyReport); }
              catch (x) { setReport(!on); setReportErr((x as Error).message); }
            }} />
            {t("Email me a report every month")}
          </label>
          {reportErr && <p className="err">{reportErr}</p>}
        </div>
        <div className="card sect">
          <h3>{t("Runtime")}</h3>
          <div className="kv">
            <div><span>{t("Runs on")}</span><b>Cloudflare Workers + Postgres</b></div>
            <div><span>{t("Check schedule")}</span><b className="mono">* * * * *</b></div>
          </div>
        </div>
      </div>
    </>
  );
}
