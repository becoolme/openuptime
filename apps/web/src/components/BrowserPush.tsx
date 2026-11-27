import { useEffect, useState } from "react";
import { useBusy } from "@openuptime/ui/use-busy";
import { api, type Channel } from "../lib/api";
import { t } from "../lib/i18n";

type Phase = "checking" | "unsupported" | "blocked" | "off" | "on";

const supported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const keyBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

/** "Chrome on macOS": a label to tell a person's browsers apart in the device list. */
function browserName() {
  const ua = navigator.userAgent;
  const b = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${b} on ${os}` : b;
}

const registration = () => navigator.serviceWorker.getRegistration();

/** This browser's push subscription, if it has one. */
async function localSubscription() {
  const reg = await registration();
  return reg ? await reg.pushManager.getSubscription() : null;
}

/**
 * The built-in way to get alerts as browser notifications: one switch for the browser you are using. It shows only when
 * the server has browser push set up. Turning it on registers this browser and, for a workspace owner or admin, adds the
 * workspace's push channel when it has none (the server does that), so alerts start without a visit to "Add channel".
 */
export default function BrowserPush({ webKey, channels, onChanged, onTest }: { webKey: string; channels: Channel[] | null; onChanged: () => void; onTest: (c: Channel) => void }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [err, setErr] = useState("");
  const [busy, run] = useBusy();

  const refresh = async () => {
    if (!supported()) return setPhase("unsupported");
    if (!(await registration())) return setPhase("unsupported"); // the worker only runs on the deployed site
    if (Notification.permission === "denied") return setPhase("blocked");
    const sub = await localSubscription().catch(() => null);
    if (!sub) return setPhase("off");
    const known = await api.pushDevices().then((d) => d.some((x) => x.token === sub.endpoint)).catch(() => false);
    setPhase(known ? "on" : "off");
  };
  useEffect(() => { refresh(); }, []);

  const turnOn = () => run(async () => {
    setErr("");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setPhase(permission === "denied" ? "blocked" : "off"); return; }
      const reg = await registration();
      if (!reg) { setPhase("unsupported"); return; }
      let sub = await reg.pushManager.getSubscription();
      // a subscription made for another server key can never receive from this one
      if (sub && !sameKey(sub, webKey)) { await sub.unsubscribe(); sub = null; }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(webKey) });
      const j = sub.toJSON();
      if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) throw new Error(t("This browser did not give us a usable push subscription."));
      await api.subscribeBrowser({ endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, locale: document.documentElement.lang === "zh-CN" ? "zh-CN" : "en", name: browserName() });
      setPhase("on");
      onChanged();
    } catch (e) { setErr((e as Error).message || t("Could not turn on browser notifications.")); }
  });

  const turnOff = () => run(async () => {
    setErr("");
    try {
      const sub = await localSubscription();
      if (sub) {
        await api.unsubscribeBrowser(sub.endpoint);
        await sub.unsubscribe().catch(() => {});
      }
      setPhase("off");
    } catch (e) { setErr((e as Error).message); }
  });

  if (phase === "checking") return null;
  const pushChannel = channels?.find((c) => c.type === "push" && c.enabled);
  return (
    <div className="card cc" style={{ marginBottom: 14 }}>
      <div className="cc-h">
        <h3>{t("Browser notifications")}</h3>
        {phase === "on" && <span className="pill up">{t("On")}</span>}
      </div>
      <p className="muted" style={{ margin: "0 0 12px" }}>
        {phase === "unsupported" ? t("This browser can't receive push notifications here. Open OpenUptime in a current Chrome, Edge, Firefox or Safari over HTTPS.")
          : phase === "blocked" ? t("Notifications are blocked for this site. Allow them in your browser's site settings, then come back.")
          : phase === "on" ? t("Down and recovery alerts appear as notifications on this device, even when OpenUptime is closed.")
          : t("Get down and recovery alerts as notifications on this device, even when OpenUptime is closed.")}
      </p>
      {err && <p className="err">{err}</p>}
      {(phase === "off" || phase === "on") && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {phase === "off" && <button className="btn primary" disabled={busy} onClick={turnOn}>{busy ? t("Turning on…") : t("Turn on")}</button>}
          {phase === "on" && pushChannel && <button className="btn" onClick={() => onTest(pushChannel)}>{t("Send a test")}</button>}
          {phase === "on" && <button className="btn" disabled={busy} onClick={turnOff}>{busy ? t("Turning off…") : t("Turn off")}</button>}
        </div>
      )}
    </div>
  );
}

/** Whether a subscription was made with this server's key. */
function sameKey(sub: PushSubscription, webKey: string) {
  const k = sub.options?.applicationServerKey;
  if (!k) return true;
  const have = new Uint8Array(k);
  const want = keyBytes(webKey);
  return have.length === want.length && have.every((b, i) => b === want[i]);
}
