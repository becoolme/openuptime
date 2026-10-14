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

type Linked = { id: string; providerId: string };
type GithubProfile = { login?: string; name?: string; email?: string | null; image?: string };

/** GitHub (when the server has it configured) as a second way to sign in, never the only way removed. */
function ConnectedAccounts() {
  const [github, setGithub] = useState(false);
  const [accounts, setAccounts] = useState<Linked[] | null>(null);
  const [profile, setProfile] = useState<GithubProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = () => authClient.listAccounts().then((r) => setAccounts((r.data as Linked[] | null) ?? [])).catch(() => setAccounts([]));
  useEffect(() => {
    fetch("/api/auth-providers").then((r) => r.json()).then((d: { github?: boolean }) => setGithub(!!d.github)).catch(() => {});
    load();
    const q = new URLSearchParams(location.search);
    if (q.has("link_error")) setErr(t("GitHub could not be connected. It may already be linked to another account."));
    if (q.has("linked")) toast(t("GitHub connected."));
    if (q.has("linked") || q.has("link_error")) history.replaceState(null, "", location.pathname);
  }, []);
  const linkedId = accounts?.find((a) => a.providerId === "github")?.id;
  useEffect(() => {
    setProfile(null);
    if (!linkedId) return;
    // asks GitHub who the linked account is; the card still works if that fails
    authClient.accountInfo({ query: { accountId: linkedId } }).then((r) => {
      const d = r.data as { user?: { name?: string; email?: string | null; image?: string }; data?: { login?: string } } | null;
      if (d) setProfile({ login: d.data?.login, name: d.user?.name, email: d.user?.email, image: d.user?.image });
    }).catch(() => {});
  }, [linkedId]);
  if (!github || !accounts) return null;
  const linked = accounts.find((a) => a.providerId === "github");
  // the account must keep another way in: a password or another provider
  const onlyWay = accounts.length <= 1;
  async function connect() {
    setErr(""); setBusy(true);
    const r = await authClient.linkSocial({ provider: "github", callbackURL: "/app/account?linked=1", errorCallbackURL: "/app/account?link_error=1" });
    if (r.error) { setErr(r.error.message ?? t("Something went wrong")); toast(t("Something went wrong"), "err"); setBusy(false); }
  }
  async function disconnect() {
    if (!linked) return;
    setErr(""); setBusy(true);
    const r = await authClient.unlinkAccount({ accountId: linked.id });
    setBusy(false);
    if (r.error) { setErr(r.error.message ?? t("Something went wrong")); toast(t("Something went wrong"), "err"); return; }
    toast(t("GitHub disconnected."));
    load();
  }
  return (
    <div className="card sect">
      <h3>{t("Connected accounts")}</h3>
      <p className="muted" style={{ marginBottom: 12 }}>{t("Sign in with GitHub as well as with your email. The GitHub email may differ from your account email.")}</p>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderTop: "1px solid var(--line)" }}>
        {profile?.image
          ? <img src={profile.image} alt="" width={36} height={36} style={{ borderRadius: "50%", flex: "none" }} />
          : <svg width="36" height="36" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style={{ flex: "none" }}><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>GitHub</div>
          <div className="muted" style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {linked ? (profile?.login ? `@${profile.login}` : profile?.name || profile?.email || t("Connected")) : t("Not connected")}
            {linked && profile?.login && profile.email ? ` · ${profile.email}` : ""}
          </div>
        </div>
        {linked
          ? <button className="btn" disabled={busy || onlyWay} onClick={disconnect}>{t("Disconnect")}</button>
          : <button className="btn" disabled={busy} onClick={connect}>{t("Connect")}</button>}
      </div>
      {linked && onlyWay && <p className="faint" style={{ marginTop: 10, fontSize: 13 }}>{t("GitHub is your only way to sign in, so it cannot be disconnected.")}</p>}
      {err && <p className="err" style={{ marginTop: 10 }}>{err}</p>}
    </div>
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
        {me && <ConnectedAccounts />}
        {me && <Security me={me} reload={load} />}
      </div>
    </>
  );
}
