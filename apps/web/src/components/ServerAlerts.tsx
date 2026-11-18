import { useEffect, useState } from "react";
import { api, type Channel, type ServerAlerts } from "../lib/api";
import { t } from "../lib/i18n";
import { fmtDateTime } from "../lib/time";
import { toast } from "../lib/toast";
import { useHideIps } from "../lib/hide-ips";

/** The eye switch that hides every address on the servers pages, for screen shares and screenshots. */
export function HideIpsButton() {
  const [hidden, setHidden] = useHideIps();
  const label = hidden ? t("Show IPs") : t("Hide IPs");
  return (
    <button type="button" className={`btn srv-eye${hidden ? " on" : ""}`} aria-pressed={hidden} onClick={() => setHidden(!hidden)} title={label}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {hidden
          ? <><path d="M3 3l18 18" /><path d="M10.6 5.1A10.5 10.5 0 0 1 12 5c5 0 8.5 4.5 9.5 7a13 13 0 0 1-3 4.1M6.6 6.6C4.4 8 3 10.2 2.5 12c1 2.5 4.5 7 9.5 7 1.8 0 3.4-.6 4.8-1.4" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>
          : <><path d="M2.5 12C3.5 9.5 7 5 12 5s8.5 4.5 9.5 7c-1 2.5-4.5 7-9.5 7s-8.5-4.5-9.5-7z" /><circle cx="12" cy="12" r="3" /></>}
      </svg>
      {label}
    </button>
  );
}

let channelsOnce: Promise<Channel[]> | null = null;
const loadChannels = () => (channelsOnce ??= api.channels().catch((e) => { channelsOnce = null; throw e; }));

/**
 * Offline alerts of one server: on or off, which channels, and a one-hour mute.
 * They run on the server's heartbeat monitor, so switching off pauses it and the channels are its channels.
 */
export function OfflineAlerts({ serverId, monitorId, alerts, onChange, footerMute }: {
  serverId: string; monitorId: string | null; alerts: ServerAlerts | null; onChange: (a: ServerAlerts) => void;
  /** the mute button sits in the surrounding footer instead */
  footerMute?: boolean;
}) {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadChannels().then(setChannels).catch(() => setChannels([])); }, []);

  if (!monitorId || !alerts) return <p className="faint srv-al-note">{t("Offline alerts start after the server's first report.")}</p>;

  async function run(f: () => Promise<Partial<ServerAlerts>>) {
    if (busy) return;
    setBusy(true);
    try { onChange({ ...alerts!, ...(await f()) }); }
    catch (e) { toast((e as Error).message, "err"); }
    finally { setBusy(false); }
  }
  const setEnabled = (enabled: boolean) => run(async () => { await api.updateMonitor(monitorId, { paused: !enabled }); toast(enabled ? t("Offline alerts on") : t("Offline alerts off")); return { enabled }; });
  const setChannelIds = (channelIds: string[]) => run(async () => { await api.updateMonitor(monitorId, { channelIds }); return { channelIds }; });
  const mute = () => run(async () => { const r = await api.muteServer(serverId, 60); toast(t("Muted for 1 hour")); return r; });
  const unmute = () => run(async () => api.unmuteServer(serverId));

  const muted = alerts.mutedUntil && new Date(alerts.mutedUntil).getTime() > Date.now();
  const enabled = channels?.filter((c) => c.enabled) ?? [];

  return (
    <div className="srv-al">
      <button type="button" className="route tog" disabled={busy} onClick={() => setEnabled(!alerts.enabled)} aria-pressed={alerts.enabled}>
        <div>
          <b style={{ fontWeight: 500 }}>{t("Alert when the server goes offline")}</b>
          <small>{alerts.enabled ? t("Sent after three report intervals without data.") : t("Off: the server can go offline without anyone being told.")}</small>
        </div>
        <span className={`tg ${alerts.enabled ? "on" : ""}`} />
      </button>

      {alerts.enabled && muted && (
        <div className="srv-al-mute">
          <span>{alerts.mutedByMaintenance
            ? t("A maintenance window holds back alerts until {t}.").replace("{t}", fmtDateTime(alerts.mutedUntil!))
            : t("Muted until {t}.").replace("{t}", fmtDateTime(alerts.mutedUntil!))}</span>
          {!alerts.mutedByMaintenance && !footerMute && <button type="button" className="btn sm" disabled={busy} onClick={unmute}>{t("Unmute")}</button>}
        </div>
      )}
      {alerts.enabled && !muted && !footerMute && (
        <div className="srv-al-mute">
          <span className="muted">{t("Going to restart or move it? Mute its alerts for an hour.")}</span>
          <button type="button" className="btn sm" disabled={busy} onClick={mute}>{t("Mute 1 hour")}</button>
        </div>
      )}

      {alerts.enabled && (
        <div className="fld srv-al-ch">
          <span>{t("Send to")} <span className="faint">({t("none selected = all channels")})</span></span>
          {channels === null && <small className="faint">{t("Loading…")}</small>}
          {channels !== null && enabled.length === 0 && (
            <small className="faint">{t("This project has no alert channels yet.")} <a href="/app/alerting">{t("Add a channel")}</a></small>
          )}
          {enabled.map((c) => {
            const on = alerts.channelIds.includes(c.id);
            return (
              <button type="button" key={c.id} className="route tog" disabled={busy}
                onClick={() => setChannelIds(on ? alerts.channelIds.filter((x) => x !== c.id) : [...alerts.channelIds, c.id])}>
                <div><b style={{ fontWeight: 500 }}>{c.name}</b><small>{c.type}</small></div>
                <span className={`tg ${on ? "on" : ""}`} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Mute or unmute from the panel's footer. */
export function MuteButton({ serverId, alerts, onChange }: { serverId: string; alerts: ServerAlerts | null; onChange: (a: ServerAlerts) => void }) {
  const [busy, setBusy] = useState(false);
  if (!alerts || !alerts.enabled) return null;
  const muted = alerts.mutedUntil && new Date(alerts.mutedUntil).getTime() > Date.now();
  if (muted && alerts.mutedByMaintenance) return null;
  const go = async () => {
    setBusy(true);
    try {
      const r = muted ? await api.unmuteServer(serverId) : await api.muteServer(serverId, 60);
      if (!muted) toast(t("Muted for 1 hour"));
      onChange({ ...alerts, ...r });
    } catch (e) { toast((e as Error).message, "err"); }
    finally { setBusy(false); }
  };
  return <button type="button" className="btn" disabled={busy} onClick={go}>{muted ? t("Unmute") : t("Mute 1 hour")}</button>;
}
