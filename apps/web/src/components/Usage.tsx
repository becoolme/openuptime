import { useEffect, useState } from "react";
import { api, type Monitor, type Quota, type Usage as UsageData } from "../lib/api";
import { t } from "../lib/i18n";
import PageHeader from "@openuptime/ui/page-header";

const fmt = (n: number) => n.toLocaleString();
const zhUi = () => typeof document !== "undefined" && document.documentElement.lang === "zh-CN";
const day = (iso: string) => new Date(iso).toLocaleDateString(zhUi() ? "zh-CN" : undefined, { month: "short", day: "numeric" });

/** One allowance: used / limit, a bar, and what resets when. The bar turns amber from 80 %. */
function Meter({ label, q, note }: { label: string; q: Quota; note: string }) {
  const pct = q.limit > 0 ? Math.min(100, Math.round((q.used / q.limit) * 100)) : 0;
  const warn = pct >= 80;
  return (
    <div className="card qmeter">
      <div className="meter-h"><span className="k">{label}</span>{warn && <span className="pill warn">{pct >= 100 ? t("Used up") : `${t("Used")} ${pct}%`}</span>}</div>
      <div><span className="meter-n">{fmt(q.used)}</span><span className="muted mono"> / {fmt(q.limit)}</span></div>
      <div className="track" role="img" aria-label={`${label}: ${pct}%`}><div className={`fill${warn ? " warn" : ""}`} style={{ width: `${pct}%` }} /></div>
      <small className="muted">{note} {t("Resets on")} {day(q.periodEnd)}{zhUi() ? "。" : "."}</small>
    </div>
  );
}

/** Plan, allowances and what uses them. Shown only where the deployment has plans; self-hosted never links here. */
export default function Usage() {
  const [u, setU] = useState<UsageData | null>(null);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  useEffect(() => {
    api.usage().then(setU).catch(() => setU({ metered: false }));
    api.monitors().then(setMonitors).catch(() => {});
  }, []);
  if (!u) {
    return (
      <>
        <PageHeader title={t("Plan & usage")} description={t("Usage is counted per workspace and resets every billing period.")} />
        <div className="usage-wrap" role="status" aria-busy="true" aria-label={t("Loading…")}>
          <div className="card sect" aria-hidden="true"><i className="sk" style={{ width: 90, height: 11 }} /><i className="sk" style={{ width: 160, height: 30, marginTop: 12 }} /></div>
          <div className="meters" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div className="card qmeter" key={i}><i className="sk" style={{ width: 80, height: 11 }} /><i className="sk" style={{ width: 120, height: 34 }} /><i className="sk" style={{ height: 8 }} /><i className="sk" style={{ width: "80%", height: 12 }} /></div>
            ))}
          </div>
        </div>
      </>
    );
  }
  if (!u.metered) {
    return (
      <>
        <PageHeader title={t("Plan & usage")} />
        <div className="card sect"><p className="muted">{t("This deployment has no plans or usage limits.")}</p></div>
      </>
    );
  }
  const { plan, credits, emails, activeMonitors, servers } = u;
  // the checks each monitor makes in a month at its interval: where the allowance goes
  const perMonth = (m: Monitor) => (m.type === "heartbeat" || m.status === "paused" ? 0 : Math.round((30 * 86400) / Math.max(1, m.intervalSec)));
  const top = [...monitors].map((m) => ({ m, n: perMonth(m) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 5);
  const total = monitors.reduce((s, m) => s + perMonth(m), 0);
  const capPct = plan?.maxActiveMonitors ? Math.min(100, Math.round((activeMonitors / plan.maxActiveMonitors) * 100)) : 0;
  const serverPct = plan?.maxServers ? Math.min(100, Math.round((servers / plan.maxServers) * 100)) : 0;
  return (
    <>
      <PageHeader title={t("Plan & usage")} description={t("Usage is counted per workspace and resets every billing period.")} />
      <div className="usage-wrap">
        {plan && (
          <section className="card sect plan-card">
            <div>
              <span className="k">{t("Current plan")}</span>
              <h2>{plan.name}</h2>
              {credits && <small className="muted">{t("Next reset")} {day(credits.periodEnd)}</small>}
            </div>
            <div className="plan-actions">
              {plan.manageUrl && <a className="btn" href={plan.manageUrl}>{t("Manage billing")}</a>}
              {plan.upgradeUrl && <a className="btn primary" href={plan.upgradeUrl}>{t("Change plan")}</a>}
            </div>
          </section>
        )}
        <div className="meters">
          {credits && <Meter label={t("Checks")} q={credits} note={t("Heartbeat monitors do not count.")} />}
          {plan && (
            <div className="card qmeter">
              <div className="meter-h"><span className="k">{t("Active monitors")}</span>{capPct >= 100 && <span className="pill warn">{t("Limit reached")}</span>}</div>
              <div><span className="meter-n">{fmt(activeMonitors)}</span>{plan.maxActiveMonitors !== null && <span className="muted mono"> / {fmt(plan.maxActiveMonitors)}</span>}</div>
              {plan.maxActiveMonitors !== null && <div className="track"><div className={`fill${capPct >= 100 ? " warn" : ""}`} style={{ width: `${capPct}%` }} /></div>}
              <small className="muted">{t("Paused monitors do not count and use no checks.")}</small>
            </div>
          )}
          {plan && plan.maxServers != null && (
            <div className="card qmeter">
              <div className="meter-h"><span className="k">{t("Servers")}</span>{serverPct >= 100 && <span className="pill warn">{t("Limit reached")}</span>}</div>
              <div><span className="meter-n">{fmt(servers)}</span><span className="muted mono"> / {fmt(plan.maxServers)}</span></div>
              <div className="track"><div className={`fill${serverPct >= 100 ? " warn" : ""}`} style={{ width: `${serverPct}%` }} /></div>
              <small className="muted">{t("Machines reporting through the agent, in every project. They do not count as monitors.")}</small>
            </div>
          )}
          {emails && <Meter label={t("Email notifications")} q={emails} note={t("Alert emails and status page subscriber emails.")} />}
        </div>
        {top.length > 0 && (
          <section className="card sect">
            <h3>{t("Monitors that use the most checks")}</h3>
            <p className="muted">{t("Estimated from each monitor's interval. Lengthen the interval of monitors that matter less.")}</p>
            <table className="usage-tbl">
              <thead><tr><th>{t("Monitor")}</th><th>{t("Interval")}</th><th>{t("Checks / month")}</th><th>{t("Share")}</th></tr></thead>
              <tbody>
                {top.map(({ m, n }) => (
                  <tr key={m.id}><td>{m.name}</td><td className="mono">{m.intervalSec >= 60 ? `${Math.round(m.intervalSec / 60)} min` : `${m.intervalSec}s`}</td><td className="mono">{fmt(n)}</td><td className="mono">{total ? ((n / total) * 100).toFixed(1) : "0"}%</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </>
  );
}
