import { adoptProject, backToAll } from "../lib/nav";
import { t } from "../lib/i18n";
import { useEffect, useState } from "react";
import { useBusy } from "../lib/use-busy";
import { ago, api, type Incident } from "../lib/api";
import { deliveryReason, deliveryState, stateClass } from "../lib/delivery";

const KIND: Record<string, string> = { "incident.opened": "Down alert", "incident.resolved": "Recovery alert", "incident.reminder": "Reminder", "incident.escalated": "Escalation", "incident.muted": "Down alert muted" };

const STATES: Incident["status"][] = ["investigating", "identified", "monitoring", "resolved"];
const utc = (iso: string) => new Date(iso).toISOString().slice(11, 16) + " UTC";
const dur = (a: string, b: string | null) => {
  const m = Math.max(0, Math.round(((b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime()) / 60000));
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d`;
};

export default function IncidentDetail({ id }: { id: string }) {
  const [inc, setInc] = useState<Incident | null>(null);
  const [status, setStatus] = useState<Incident["status"]>("investigating");
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [rootCause, setRootCause] = useState("");
  const [postmortem, setPostmortem] = useState("");
  const [publish, setPublish] = useState(false);
  const [saving, save] = useBusy();
  const [saved, setSaved] = useState(false);
  const [busy, run] = useBusy();
  const [acking, ack] = useBusy();
  const [err, setErr] = useState("");
  const load = () => api.incident(id).then((i) => { adoptProject(i.projectId); setInc(i); setStatus(i.status === "resolved" ? "resolved" : i.status); setRootCause(i.rootCause ?? ""); setPostmortem(i.postmortem ?? ""); setPublish(!!i.postmortemPublishedAt); });
  useEffect(() => { load(); }, [id]);
  if (!inc) return <p className="muted">{t("Loading…")}</p>;

  const resolved = inc.status === "resolved";
  const post = (s: Incident["status"], text: string, hidden = false) =>
    run(async () => {
      setErr("");
      try { await api.postUpdate(id, { status: s, body: text, visibility: hidden ? "internal" : "public" }); setBody(""); setInternal(false); await load(); } catch (x) { setErr((x as Error).message); }
    });
  // a resolution is what subscribers are mailed about, so it is always public
  const hidden = internal && status !== "resolved";
  const events = [...(inc.updates ?? [])].reverse();

  return (
    <>
      <p className="crumb-back"><a href="/app/incidents" className="muted" onClick={backToAll}>{t("← Incidents")}</a></p>
      <div className="dh">
        <h1 className="serif">{inc.title}</h1>
        <span className={`pill ${resolved ? "resolved" : "down"}`}>{t(inc.status)}</span>
        <div className="dh-acts">
          {!inc.acknowledgedAt && !resolved && <button className="btn" disabled={acking} onClick={() => ack(() => api.ack(id).then(load).catch((e: Error) => setErr(e.message)))}>{acking ? t("Acknowledging…") : t("Acknowledge")}</button>}
          {!resolved && <button className="btn primary" disabled={busy} onClick={() => post("resolved", body.trim() || t("This incident has been resolved."))}>{t("Resolve")}</button>}
        </div>
      </div>
      <div className="url">
        <span>{inc.number ? `INC-${inc.number}` : `#${inc.id.slice(0, 6)}`}</span>
        <span className="chip">{t("started")} {utc(inc.startedAt)}</span>
        <span className="chip">{dur(inc.startedAt, inc.resolvedAt)} {resolved ? t("total") : t("elapsed")}</span>
        {inc.auto && <span className="chip">{t("Auto-detected")}</span>}
      </div>
      {err && <p className="err">{err}</p>}

      <div className="cols">
        <div className="col">
          <form className="card cc" onSubmit={(e) => { e.preventDefault(); post(status, body, hidden); }}>
            <div className="cc-h"><h3>{t("Post an update")}</h3><span className="faint" style={{ fontSize: 13 }}>{hidden ? t("Visible to your team only") : t("Sent to status page subscribers")}</span></div>
            <div className="seg">{STATES.map((s) => <i key={s} className={status === s ? "on" : ""} onClick={() => setStatus(s)}>{t(s)}</i>)}</div>
            <div className="seg" style={{ marginTop: 14 }}>
              {(["public", "internal"] as const).map((v) => <i key={v} className={(hidden ? "internal" : "public") === v ? "on" : ""} onClick={() => setInternal(v === "internal")}>{t(v === "public" ? "Public update" : "Internal note")}</i>)}
            </div>
            <textarea className="in" style={{ height: 96, padding: 12, marginTop: 14 }} required value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("What do customers need to know?")} />
            <div className="formact"><button className="btn primary sm" disabled={busy}>{busy ? t("Publishing…") : t("Publish update")}</button></div>
          </form>

          <div className="card cc">
            <div className="cc-h"><h3>{t("Timeline")}</h3></div>
            <div className="tl">
              {events.map((u, k) => (
                <div key={u.id} className={`ev ${k === 0 && !resolved ? "now" : u.status === "resolved" ? "ok" : ""}`}>
                  <b>{t(u.status)}</b>{u.visibility === "internal" && <span className="chip" style={{ marginLeft: 8 }}>{t("Internal")}</span>}<time>{utc(u.createdAt)}</time>
                  <p>{u.body}</p>
                </div>
              ))}
              {inc.acknowledgedAt && <div className="ev"><b>{t("Acknowledged")}</b><time>{utc(inc.acknowledgedAt)}</time>{inc.assignee && <p>{inc.assignee.name || inc.assignee.email}</p>}</div>}
              <div className="ev"><b>{t("Incident opened")}</b><time>{utc(inc.startedAt)}</time><p>{inc.auto ? t("Consecutive failed checks confirmed.") : t("Declared manually.")}</p>{inc.evaluationNote && <p className="faint">{t("Why")}: {inc.evaluationNote}</p>}</div>
            </div>
          </div>

          <form className="card cc" onSubmit={(e) => {
            e.preventDefault();
            setSaved(false);
            save(async () => {
              try { await api.saveWriteUp(id, { rootCause: rootCause.trim() || null, postmortem: postmortem.trim() || null, publishPostmortem: publish }); setSaved(true); await load(); } catch (x) { setErr((x as Error).message); }
            });
          }}>
            <div className="cc-h"><h3>{t("Root cause and postmortem")}</h3><span className="faint" style={{ fontSize: 13 }}>{t("Private until you publish it")}</span></div>
            <label className="fld">{t("Root cause")}<input className="in" maxLength={500} value={rootCause} onChange={(e) => setRootCause(e.target.value)} placeholder={t("One sentence on what went wrong")} /></label>
            <label className="fld">{t("Postmortem")}<textarea className="in" style={{ height: 160, padding: 12 }} maxLength={20000} value={postmortem} onChange={(e) => setPostmortem(e.target.value)} placeholder={t("What happened, the impact, and what we will change")} /></label>
            <label className="fld" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />{t("Publish to the status page")}</label>
            <small className="faint">{t("Shown on the status page once the incident is resolved. Resolving alone, automatic recovery included, never publishes it.")}</small>
            <div className="formact">{saved && <span className="faint" style={{ fontSize: 13 }}>{t("Saved")}</span>}<button className="btn primary sm" disabled={saving}>{saving ? t("Saving…") : t("Save")}</button></div>
          </form>

          {!!inc.deliveries?.length && (
            <div className="card cc">
              <div className="cc-h"><h3>{t("Notifications")}</h3><span className="faint" style={{ fontSize: 13 }}>{t("Who was told, and why not")}</span></div>
              {inc.deliveries.map((d) => {
                const state = deliveryState(d);
                const reason = deliveryReason(d);
                return (
                  <div className="route" key={d.id} style={{ alignItems: "flex-start" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <b style={{ fontWeight: 500 }}>{d.channelName}</b>
                      <small>{t(KIND[d.kind] ?? d.kind)} · {ago(d.createdAt)}{d.acknowledgedAt ? ` · ${t("acknowledged")} ${ago(d.acknowledgedAt)}` : ""}</small>
                      {reason && <small className="mono" style={{ color: state === "failed" ? "var(--down)" : "var(--muted)", wordBreak: "break-word" }}>{reason}</small>}
                    </div>
                    <span className={`pill ${stateClass(state)}`}>{t(state === "sent" ? "Sent" : state === "failed" ? "Failed" : state === "skipped" ? "Skipped" : state === "muted" ? "Muted" : "Sending")}</span>
                  </div>
                );
              })}
            </div>
          )}

          {!!inc.checks?.length && (
            <div className="card cc">
              <div className="cc-h"><h3>{t("Failing checks")}</h3></div>
              <div className="rr res th"><span>{t("Time (UTC)")}</span><span>{t("Result")}</span><span>{t("Code")}</span><span>{t("Latency")}</span><span>{t("Error")}</span></div>
              {inc.checks.map((r) => (
                <div className="rr res" key={r.id}>
                  <span className="mono muted">{new Date(r.checkedAt).toISOString().slice(11, 19)}</span>
                  <span><span className="pill down">{t("Failed")}</span></span>
                  <span className="mono">{r.statusCode ?? "—"}</span>
                  <span className="mono">{r.latencyMs ?? "—"} ms</span>
                  <span className="faint mono rr-err" title={r.error ?? ""}>{r.error ?? ""}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="col">
          <div className="card cc">
            <div className="cc-h"><h3>{t("Details")}</h3></div>
            <div className="kv">
              <div><span>{t("Severity")}</span><b>{t(inc.severity === "minor" ? "Minor" : "Major outage")}</b></div>
              <div><span>{t("Monitor")}</span><b>{inc.monitor ? <a href={`/app/monitors/${inc.monitor.id}`}>{inc.monitor.name}</a> : "—"}</b></div>
              <div><span>{t("Assignee")}</span><b>{inc.assignee ? inc.assignee.name || inc.assignee.email : "—"}</b></div>
              <div><span>{t("Acknowledged")}</span><b>{inc.acknowledgedAt ? ago(inc.acknowledgedAt) : "—"}</b></div>
              <div><span>{t("Resolved")}</span><b>{inc.resolvedAt ? ago(inc.resolvedAt) : "—"}</b></div>
            </div>
          </div>
          {inc.monitor && (
            <div className="card cc">
              <div className="cc-h"><h3>{t("Affected components")}</h3></div>
              <a className="route" href={`/app/monitors/${inc.monitor.id}`}>
                <span className={`dot ${inc.monitor.status === "up" ? "up" : inc.monitor.status === "down" ? "down" : "warn"}`} />
                <div style={{ minWidth: 0, flex: 1 }}>{inc.monitor.name}<small className="mono">{inc.monitor.target || inc.monitor.type}</small></div>
                <span className={`pill ${inc.monitor.status}`}>{t(inc.monitor.status)}</span>
              </a>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
