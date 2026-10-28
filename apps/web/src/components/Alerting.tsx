import { t } from "../lib/i18n";
import { useEffect, useState } from "react";
import { useBusy } from "../lib/use-busy";
import { api, ago, type AlertDelivery, type Channel, type ProjectAlerting } from "../lib/api";
import { deliveryReason, deliveryState, stateClass } from "../lib/delivery";

const TYPES: { id: Channel["type"]; label: string; desc: string }[] = [
  { id: "teams", label: "Microsoft Teams", desc: "Send Adaptive Cards to a Teams Workflow webhook." },
  { id: "slack", label: "Slack", desc: "Post to a channel with an incoming webhook." },
  { id: "lark", label: "Lark / Feishu", desc: "Post to a group with a custom bot." },
  { id: "email", label: "Email", desc: "Send alerts to an address or on-call alias." },
  { id: "telegram", label: "Telegram", desc: "Message a chat or group through your bot." },
  { id: "pagerduty", label: "PagerDuty", desc: "Trigger and resolve incidents on a service." },
  { id: "webhook", label: "Webhook", desc: "POST a JSON payload to any URL." },
  { id: "push", label: "Mobile app (push)", desc: "Notify the OpenUptime app on your team's phones." },
];
const svg = (d: React.ReactNode) => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
/** Generic glyphs per channel type (not brand logos). */
const ICONS: Record<Channel["type"], React.ReactNode> = {
  teams: svg(<><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M8 9h8M12 9v6" /></>),
  slack: svg(<path d="M9 4L7 20M17 4l-2 16M4 9h16M3.5 15h16" />),
  lark: svg(<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />),
  email: svg(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>),
  telegram: svg(<path d="M21 4L3 11l6 2.2L11 20l3-4.5 4.5 3.3L21 4zM9 13.2L21 4" />),
  pagerduty: svg(<><path d="M6 17V11a6 6 0 0 1 12 0v6" /><path d="M4 17h16M10 21h4" /></>),
  push: svg(<><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" /></>),
  webhook: svg(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" /></>),
};
const REPEATS = [5, 10, 15, 30, 60];
const dest = (c: Channel) => c.type === "push" ? t("App on members' phones") : c.config.url?.replace(/^https?:\/\//, "") ?? c.config.to ?? (c.config.chatId ? `chat ${c.config.chatId}` : c.config.routingKey ? "routing key ••••" : "");

export default function Alerting() {
  const [items, setItems] = useState<Channel[] | null>(null);
  const [f, setF] = useState({ type: "slack" as Channel["type"], name: "", url: "", to: "", botToken: "", chatId: "", routingKey: "", secret: "", auto: false });
  const [err, setErr] = useState("");
  const [busy, run] = useBusy();
  const [removing, setRemoving] = useState("");
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState("");
  const [testing, setTesting] = useState("");
  const [note, setNote] = useState("");
  const [log, setLog] = useState<AlertDelivery[] | null>(null);
  const [days, setDays] = useState(30);
  const [push, setPush] = useState(false);
  const [rules, setRules] = useState<ProjectAlerting | null>(null);
  const [projectId, setProjectId] = useState("");
  const [rulesErr, setRulesErr] = useState("");
  const [rulesNote, setRulesNote] = useState("");
  const [savingRules, saveRulesBusy] = useBusy();
  const saveRules = () => saveRulesBusy(async () => {
    setRulesErr(""); setRulesNote("");
    if (!rules) return;
    if (rules.escalation.some((x) => !x.channelIds.length)) { setRulesErr(t("Pick at least one channel for each level.")); return; }
    try { setRules(await api.saveProjectAlerting(projectId, rules)); setRulesNote(t("Saved")); } catch (e) { setRulesErr((e as Error).message); }
  });
  const loadLog = () => api.alertLog(30).then(setLog).catch(() => setLog([]));
  const load = () => api.channels().then(setItems);
  useEffect(() => { load(); loadLog(); api.config().then((c) => setPush(!!c.push?.apns)).catch(() => {}); api.settings().then((s) => setDays(s.alertLogRetentionDays)).catch(() => {}); api.me().then((m) => { setProjectId(m.projectId); return api.projectAlerting(m.projectId).then(setRules); }).catch(() => {}); }, []);

  const blank = { type: "slack" as Channel["type"], name: "", url: "", to: "", botToken: "", chatId: "", routingKey: "", secret: "", auto: false };
  const openAdd = () => { setErr(""); setEditId(""); setF(blank); setAdding(true); };
  const openEdit = (c: Channel) => {
    setErr("");
    setEditId(c.id);
    setF({ ...blank, type: c.type, name: c.name, url: c.config.url ?? "", to: c.config.to ?? "", botToken: c.config.botToken ?? "", chatId: c.config.chatId ?? "", routingKey: c.config.routingKey ?? "", secret: c.config.secret ?? "", auto: !!c.autoEnable });
    setAdding(true);
  };
  async function add(e: React.SyntheticEvent) {
    e.preventDefault();
    setErr("");
    await run(async () => { try {
      const config: Record<string, string> =
        f.type === "email" ? { to: f.to }
        : f.type === "telegram" ? { botToken: f.botToken, chatId: f.chatId }
        : f.type === "pagerduty" ? { routingKey: f.routingKey }
        : f.type === "push" ? {}
        : f.type === "lark" ? { url: f.url, ...(f.secret ? { secret: f.secret } : {}) }
        : { url: f.url };
      if (editId) await api.updateChannel(editId, { name: f.name, config, autoEnable: f.auto });
      else await api.createChannel({ type: f.type, name: f.name, config, autoEnable: f.auto });
      setF(blank);
      await load();
      setAdding(false);
    } catch (e) { setErr((e as Error).message); } });
  }
  const test = async (c: Channel) => {
    setTesting(c.id);
    setNote("");
    setErr("");
    try { await api.testChannel(c.id); setNote(`${t("Test sent to")} ${c.name}`); } catch (e) { setErr(`${c.name}: ${(e as Error).message}`); }
    setTesting("");
    loadLog();
  };
  const enabledN = items?.filter((c) => c.enabled).length ?? 0;
  return (
    <>
      <div className="ph">
        <div><h1>{t("Alerting")}</h1><p className="muted">{t("Where we tell you when something breaks, and when it’s back.")}</p></div>
        <button className="btn primary" onClick={openAdd}>{t("+ Add channel")}</button>
      </div>
      {err && !adding && <p className="err">{err}</p>}
      {note && <p className="ok-note">{note}</p>}
      <div className="cols">
        <div className="col">
          {items === null && <p className="muted">{t("Loading…")}</p>}
          {items?.length === 0 ? (
            <div className="empty"><h3 style={{ fontSize: 28 }}>{t("No channels yet")}</h3><p className="muted" style={{ margin: "6px 0 20px" }}>{t("Add one so you hear about problems first.")}</p>
              <button className="btn primary" onClick={openAdd}>{t("+ Add channel")}</button></div>
          ) : items && (
            <div className="card tbl">
              <div className="tr th ch-tr"><span>{t("Channel")}</span><span>{t("Destination")}</span><span>{t("Status")}</span><span /></div>
              {items.map((c) => (
                <div className="tr ch-tr" key={c.id}>
                  <div className="nm"><span className="ri ch-ic">{ICONS[c.type] ?? c.type.slice(0, 2).toUpperCase()}</span><div><b style={{ fontWeight: 600 }}>{c.name}</b><small>{c.type}{c.projectId ? ` · ${t("this project only")}` : ""}{c.autoEnable ? ` · ${t("on for new monitors")}` : ""}</small></div></div>
                  <span className="muted mono ch-dest" title={dest(c)}>{dest(c)}</span>
                  <span>
                    <button className="pill-btn" title={c.enabled ? t("Pause") : t("Resume")} onClick={async () => { try { await api.updateChannel(c.id, { enabled: !c.enabled }); await load(); } catch (e) { setErr((e as Error).message); } }}>
                      <span className={`pill ${c.enabled ? "up" : "pending"}`}>{c.enabled ? t("Active") : t("Paused")}</span>
                    </button>
                  </span>
                  <span className="ch-a">
                    <button className="btn sm" disabled={testing === c.id} onClick={() => test(c)}>{testing === c.id ? t("Sending…") : t("Test")}</button>
                    <button className="btn sm" onClick={() => openEdit(c)}>{t("Edit")}</button>
                    <button className="btn sm" disabled={removing === c.id} onClick={async () => {
                      if (!confirm(t("Remove this channel?"))) return;
                      setRemoving(c.id);
                      try { await api.deleteChannel(c.id); await load(); } catch (e) { setErr((e as Error).message); } finally { setRemoving(""); }
                    }}>{removing === c.id ? t("Removing…") : t("Remove")}</button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="col">
          <div className="card cc">
            <div className="cc-h"><h3>{t("How alerts are sent")}</h3></div>
            <div className="step"><div className="sn">1</div><div><b>{t("A monitor fails")}</b><small className="faint">{t("After the configured number of consecutive failures.")}</small></div></div>
            <div className="step"><div className="sn">2</div><div><b>{t("We notify your channels")}</b><small className="faint">{enabledN} {t("active channels receive it, unless a monitor routes to specific ones.")}</small></div></div>
            <div className="step"><div className="sn">3</div><div><b>{t("We tell you when it’s back")}</b><small className="faint">{t("A recovery message is sent when checks pass again.")}</small></div></div>
          </div>
        </div>
      </div>

      <div className="card cc" style={{ marginTop: 22 }}>
        <div className="cc-h">
          <h3>{t("Delivery log")}</h3>
          <span className="faint" style={{ fontSize: 13 }}>{t("Kept for")} {days} {t("days")} · <a href="/app/settings">{t("Change")}</a></span>
        </div>
        {log === null && <p className="muted">{t("Loading…")}</p>}
        {log?.length === 0 && <p className="muted">{t("No alerts sent yet.")}</p>}
        {log?.map((d) => {
          const state = deliveryState(d);
          const reason = deliveryReason(d);
          return (
            <div className="route" key={d.id} style={{ alignItems: "flex-start" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <b style={{ fontWeight: 500 }}>{d.channelName}</b>
                <small>
                  {d.kind === "test" ? t("Test alert") : d.kind === "incident.opened" ? t("Down alert") : d.kind === "incident.resolved" ? t("Recovery alert") : d.kind === "incident.reminder" ? t("Reminder") : d.kind === "incident.escalated" ? t("Escalation") : d.kind === "incident.muted" ? t("Down alert muted") : d.kind}
                  {d.monitorName && d.kind !== "test" ? ` · ${d.monitorName}` : ""} · {ago(d.createdAt)}
                </small>
                {reason && d.kind !== "incident.muted" && <small className="mono" style={{ color: state === "failed" ? "var(--down)" : "var(--muted)", wordBreak: "break-word" }}>{reason.startsWith("skipped: email allowance") ? t("Skipped: email allowance used up for this period") : reason}</small>}
              </div>
              <span className={`pill ${stateClass(state)}`}>{t(state === "sent" ? "Sent" : state === "failed" ? "Failed" : state === "skipped" ? "Skipped" : state === "muted" ? "Muted" : state === "pending" ? "Pending" : "Sending")}</span>
            </div>
          );
        })}
      </div>

      {rules && items && (
        <div className="card cc" style={{ marginTop: 22 }}>
          <div className="cc-h"><h3>{t("Repeat and escalate")}</h3><span className="faint" style={{ fontSize: 13 }}>{t("Until the incident is acknowledged or resolved")}</span></div>
          <label className="fld">{t("Repeat the alert")}
            <select className="in" value={rules.reminderIntervalMin ?? ""} onChange={(e) => setRules({ ...rules, reminderIntervalMin: e.target.value ? Number(e.target.value) : null })}>
              <option value="">{t("Off")}</option>
              {REPEATS.map((n) => <option key={n} value={n}>{t("Every")} {n} {t("min")}</option>)}
            </select>
          </label>
          <p className="muted" style={{ margin: "0 0 10px" }}>{t("Repeats go to mobile app channels, at most 10 times.")}</p>
          <button type="button" className="route tog" onClick={() => setRules({ ...rules, reminderEmail: !rules.reminderEmail })}>
            <div><b style={{ fontWeight: 500 }}>{t("Repeat by email too")}</b><small>{t("Email channels get the repeats as well.")}</small></div>
            <span className={`tg ${rules.reminderEmail ? "on" : ""}`} />
          </button>
          <h4 style={{ margin: "18px 0 6px" }}>{t("Escalation")}</h4>
          <p className="muted" style={{ margin: "0 0 10px" }}>{t("If nobody has acknowledged the incident after the delay, also notify these channels. Up to 3 levels.")}</p>
          {rules.escalation.map((st, i) => (
            <div className="route" key={i} style={{ alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span>{t("After")}</span>
              <input className="in" type="number" min={1} max={1440} style={{ width: 90 }} value={st.escalateAfterMin} onChange={(e) => setRules({ ...rules, escalation: rules.escalation.map((x, j) => j === i ? { ...x, escalateAfterMin: Number(e.target.value) } : x) })} />
              <span>{t("min, notify")}</span>
              <span style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1 }}>
                {items.map((c) => (
                  <button type="button" key={c.id} className={`btn sm ${st.channelIds.includes(c.id) ? "primary" : ""}`} onClick={() => setRules({ ...rules, escalation: rules.escalation.map((x, j) => j === i ? { ...x, channelIds: x.channelIds.includes(c.id) ? x.channelIds.filter((id) => id !== c.id) : [...x.channelIds, c.id] } : x) })}>{c.name}</button>
                ))}
              </span>
              <button type="button" className="btn sm" onClick={() => setRules({ ...rules, escalation: rules.escalation.filter((_, j) => j !== i) })}>{t("Remove")}</button>
            </div>
          ))}
          {rules.escalation.length < 3 && items.length > 0 && (
            <button type="button" className="btn sm" onClick={() => setRules({ ...rules, escalation: [...rules.escalation, { escalateAfterMin: (rules.escalation.at(-1)?.escalateAfterMin ?? 0) + 15, channelIds: [items[0].id] }] })}>{t("+ Add level")}</button>
          )}
          {rulesErr && <p className="err">{rulesErr}</p>}
          {rulesNote && <p className="ok-note">{rulesNote}</p>}
          <div className="formact"><button type="button" className="btn primary sm" disabled={savingRules} onClick={saveRules}>{savingRules ? t("Saving…") : t("Save changes")}</button></div>
        </div>
      )}

      {adding && (
        <div className="modal" onClick={() => setAdding(false)}>
          <form className="card" onClick={(e) => e.stopPropagation()} onSubmit={add}>
            <h2 style={{ fontSize: 30 }}>{editId ? t("Edit channel") : t("Add a channel")}</h2>
            {!editId && <div className="type-grid">
              {TYPES.filter((x) => x.id !== "push" || push).map((x) => (
                <button type="button" key={x.id} className={`type-c ${f.type === x.id ? "on" : ""}`} onClick={() => setF({ ...f, type: x.id })}>
                  <b>{x.label}</b><small>{t(x.desc)}</small>
                </button>
              ))}
            </div>}
            <label className="fld">{t("Name")}<input className="in" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={f.type === "push" ? t("Mobile app") : "#ops-alerts"} /></label>
            {(f.type === "slack" || f.type === "webhook" || f.type === "lark" || f.type === "teams") && (
              <label className="fld">{t("Webhook URL")}<input className="in mono" type="url" required value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder={f.type === "teams" ? "https://…/workflows/…" : f.type === "lark" ? "https://open.larksuite.com/open-apis/bot/v2/hook/…" : "https://hooks.slack.com/services/…"} /></label>
            )}
            {f.type === "lark" && (
              <label className="fld">{t("Signing secret (optional)")}<input className="in mono" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} /></label>
            )}
            {f.type === "email" && (
              <label className="fld">{t("Email address")}<input className="in" type="email" required value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} placeholder="oncall@example.com" /></label>
            )}
            {f.type === "telegram" && (
              <>
                <label className="fld">{t("Bot token")}<input className="in mono" required value={f.botToken} onChange={(e) => setF({ ...f, botToken: e.target.value })} placeholder="123456:ABC…" /></label>
                <label className="fld">{t("Chat ID")}<input className="in mono" required value={f.chatId} onChange={(e) => setF({ ...f, chatId: e.target.value })} placeholder="-1001234567890" /></label>
              </>
            )}
            {f.type === "pagerduty" && (
              <label className="fld">{t("Routing key")}<input className="in mono" required value={f.routingKey} onChange={(e) => setF({ ...f, routingKey: e.target.value })} /></label>
            )}
            {f.type === "push" && <p className="muted" style={{ margin: 0 }}>{t("Sent to the OpenUptime app of every member of this workspace")}</p>}
            <button type="button" className="route tog" onClick={() => setF({ ...f, auto: !f.auto })}>
              <div><b style={{ fontWeight: 500 }}>{t("Turn on for new monitors")}</b><small>{t("Every monitor you create alerts this channel from the start.")}</small></div>
              <span className={`tg ${f.auto ? "on" : ""}`} />
            </button>
            {err && <p className="err">{err}</p>}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={() => setAdding(false)}>{t("Cancel")}</button>
              <button className="btn primary" disabled={busy}>{busy ? (editId ? t("Saving…") : t("Adding…")) : editId ? t("Save changes") : t("Add channel")}</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
