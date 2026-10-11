import { t } from "../lib/i18n";
import { LOCALES, type Locale } from "../lib/i18n";
import { go, switchLocale } from "../lib/locale-path";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { authClient } from "../lib/auth-client";
import QRCode from "qrcode";
import { toast } from "../lib/toast";

type Me = { name?: string; email?: string; locale?: string | null; emailVerified?: boolean; twoFactorEnabled?: boolean | null };

/** Email verification, two-step sign-in, data export and account deletion. */
function Security({ me, reload }: { me: Me; reload: () => void }) {
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [pw, setPw] = useState("");
  const [setup, setSetup] = useState<{ uri: string; secret: string; qr: string; codes: string[] } | null>(null);
  const [code, setCode] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const fail = (m?: string) => { const text = m ?? t("Something went wrong"); setErr(text); toast(text, "err"); setBusy(false); };
  const ok = (m: string) => { setMsg(m); toast(m); };
  const reset = () => { setErr(""); setMsg(""); };

  async function resend() {
    reset(); setSending(true);
    const r = await authClient.sendVerificationEmail({ email: me.email!, callbackURL: "/app/account?verified=1" }).catch(() => null);
    setSending(false);
    if (!r || r.error) return fail(r?.error?.message);
    ok(t("Verification email sent. Check your inbox."));
  }
  async function enable(e: React.SyntheticEvent) {
    e.preventDefault(); reset(); setBusy(true);
    const r = await authClient.twoFactor.enable({ password: pw });
    if (r.error || !r.data || !("totpURI" in r.data)) return fail(r.error?.message);
    const uri = r.data.totpURI;
    setSetup({ uri, secret: new URL(uri).searchParams.get("secret") ?? "", qr: await QRCode.toDataURL(uri, { margin: 1, width: 180 }), codes: r.data.backupCodes });
    setPw(""); setBusy(false);
  }
  async function confirm(e: React.SyntheticEvent) {
    e.preventDefault(); reset(); setBusy(true);
    const r = await authClient.twoFactor.verifyTotp({ code });
    if (r.error) return fail(t("That code is not valid. Try the current one from your app."));
    setSetup(null); setCode(""); setBusy(false); ok(t("Two-step verification is on.")); reload();
  }
  async function disable(e: React.SyntheticEvent) {
    e.preventDefault(); reset(); setBusy(true);
    const r = await authClient.twoFactor.disable({ password: pw });
    if (r.error) return fail(r.error.message);
    setPw(""); setBusy(false); ok(t("Two-step verification is off.")); reload();
  }
  async function remove(e: React.SyntheticEvent) {
    e.preventDefault(); reset(); setBusy(true);
    const r = await authClient.deleteUser(pw ? { password: pw } : {});
    if (r.error) return fail(r.error.message);
    go("/");
  }
  return (
    <>
      <div className="card sect">
        <h3>{t("Email verification")}</h3>
        {me.emailVerified
          ? <p className="state-ok"><span className="show-tick" aria-hidden="true">✓</span>{t("Your email address is verified.")}</p>
          : <><p className="muted" style={{ marginBottom: 12 }}>{t("Your email address is not verified yet. We use it for alerts and to help you recover your account.")}</p>
            <div><button className="btn" disabled={sending} onClick={resend}>{sending ? t("Sending…") : t("Send verification email")}</button></div></>}
      </div>
      <div className="card sect">
        <h3>{t("Two-step verification")}</h3>
        <p className="muted" style={{ marginBottom: 12 }}>{t("Ask for a code from an authenticator app (Google Authenticator, 1Password, Authy…) when you sign in with your password.")}</p>
        {setup ? (
          <form onSubmit={confirm} className="auth-fields">
            <p>{t("Scan this QR code with your authenticator app, then enter the 6-digit code it shows.")}</p>
            <img src={setup.qr} alt="" width={180} height={180} style={{ background: "#fff", borderRadius: 8 }} />
            <p className="faint" style={{ fontSize: 13 }}>{t("Or enter this key manually")}: <span className="mono">{setup.secret}</span></p>
            <div className="callout backup">
              <b>{t("Backup codes")}</b>
              <ul className="backup-codes mono">{setup.codes.map((c) => <li key={c}>{c}</li>)}</ul>
              <small>{t("Save these somewhere safe. Each one signs you in once if you lose your device.")}</small>
            </div>
            <label className="fld">{t("Verification code")}<input className="in mono" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" /></label>
            {err && <p className="err">{err}</p>}
            <div><button className="btn primary" disabled={busy}>{t("Turn on")}</button></div>
          </form>
        ) : me.twoFactorEnabled ? (
          <form onSubmit={disable} className="auth-fields">
            <p className="state-ok"><span className="show-tick" aria-hidden="true">✓</span>{t("Two-step verification is on.")}</p>
            <label className="fld">{t("Password")}<input className="in" type="password" required value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></label>
            <div><button className="btn" disabled={busy}>{t("Turn off")}</button></div>
          </form>
        ) : (
          <form onSubmit={enable} className="auth-fields">
            <label className="fld">{t("Password")}<input className="in" type="password" required value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></label>
            <div><button className="btn primary" disabled={busy}>{t("Set up")}</button></div>
          </form>
        )}
      </div>
      <div className="card sect">
        <h3>{t("Your data")}</h3>
        <p className="muted" style={{ marginBottom: 12 }}>{t("Download a JSON copy of your profile, sessions and the workspaces you manage.")}</p>
        <div><a className="btn" href="/api/me/export" download="openuptime-account-export.json">{t("Download my data")}</a></div>
      </div>
      <div className="card sect">
        <h3 style={{ color: "var(--down)" }}>{t("Delete account")}</h3>
        <p className="muted" style={{ marginBottom: 12 }}>{t("Permanently deletes your account, and any workspace where you are the only member, with its monitors, incidents and status pages. This cannot be undone.")}</p>
        {!confirmDel ? <div><button className="btn" onClick={() => { reset(); setConfirmDel(true); }}>{t("Delete my account…")}</button></div> : (
          <form onSubmit={remove} className="auth-fields">
            <label className="fld">{t("Password")}<input className="in" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></label>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn primary" style={{ background: "var(--down)" }} disabled={busy}>{t("Delete permanently")}</button>
              <button type="button" className="btn" onClick={() => { setConfirmDel(false); setPw(""); }}>{t("Cancel")}</button>
            </div>
          </form>
        )}
      </div>
      {msg && <p className="muted">{msg}</p>}
    </>
  );
}

/** Personal settings: who you are and which language emails (and the app) use. API keys live on their own page. */
export default function Account() {
  const [me, setMe] = useState<Me | null>(null);
  const [saved, setSaved] = useState(false);
  const load = () => api.me().then((m) => setMe(m.user)).catch(() => {});
  useEffect(() => { load(); }, []);
  const current: Locale = me?.locale === "zh-CN" ? "zh-CN" : me?.locale === "en" ? "en" : document.documentElement.lang === "zh-CN" ? "zh-CN" : "en";
  async function pick(l: Locale) {
    setSaved(false);
    await api.setLocale(l);
    // the app itself follows the same choice (cookie read by every page)
    if (l !== document.documentElement.lang) { switchLocale(l); return; }
    setMe((m) => (m ? { ...m, locale: l } : m));
    setSaved(true);
  }
  return (
    <>
      <div className="ph"><div><h1>{t("Account")}</h1><p className="muted">{t("Personal settings, shared across all your projects.")}</p></div></div>
      <div className="set-wrap">
        {me?.email && (
          <div className="card sect" >
            <h3>{t("Profile")}</h3>
            <div className="kv">
              <div><span>{t("Name")}</span><b>{me.name}</b></div>
              <div><span>{t("Email")}</span><b className="mono">{me.email}</b></div>
            </div>
          </div>
        )}
        {me && (
          <div className="card sect">
            <h3>{t("Language")}</h3>
            <p className="muted" style={{ marginBottom: 12 }}>{t("Used for the app and for emails we send you, such as alerts, invitations and password resets.")}</p>
            <div className="seg" style={{ maxWidth: 360 }}>
              {(Object.keys(LOCALES) as Locale[]).map((l) => <i key={l} className={current === l ? "on" : ""} onClick={() => pick(l)}>{LOCALES[l]}</i>)}
            </div>
            {saved && <p className="faint" style={{ marginTop: 10, fontSize: 13 }}>{t("Saved")}</p>}
          </div>
        )}
        {me && <Security me={me} reload={load} />}
      </div>
    </>
  );
}
