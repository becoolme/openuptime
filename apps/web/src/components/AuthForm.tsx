import { t } from "../lib/i18n";
import { useEffect, useState } from "react";
import { authClient } from "../lib/auth-client";
import { AuthShell } from "./AuthShell";
import { nextPath as safeNext } from "../lib/next-path";
import { lp } from "../lib/locale-path";

// an agent sent the user here to sign in (signed OAuth query): resume its authorization request afterwards
const oauthResume = () => {
  const p = new URLSearchParams(location.search);
  return p.has("client_id") && p.has("sig") ? `/api/auth/oauth2/authorize${location.search}` : null;
};
const nextPath = () => oauthResume() ?? lp(safeNext(location.search));

export default function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [github, setGithub] = useState(false);
  // false when the operator closed registration: only invited people can still create an account
  const [open, setOpen] = useState(true);
  // password accepted, second step pending
  const [twoStep, setTwoStep] = useState(false);
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const login = mode === "login";

  useEffect(() => {
    // the page is static, so "already signed in" is checked here
    fetch("/api/me", { credentials: "include" }).then((r) => r.ok && (window.location.href = nextPath())).catch(() => {});
    fetch("/api/auth-providers").then((r) => r.json()).then((d: { github?: boolean; signup?: boolean }) => { setGithub(!!d.github); setOpen(d.signup !== false); }).catch(() => {});
  }, []);

  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = login
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: name || email.split("@")[0], callbackURL: "/app/account?verified=1" });
      if (res.error) setError(res.error.message ?? t("Something went wrong"));
      else if (login && (res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) { setTwoStep(true); }
      else { window.location.href = nextPath(); return; } // stay disabled while navigating
    } catch {
      setError(t("Something went wrong"));
    }
    setBusy(false);
  }

  async function verify(e: React.SyntheticEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = backup
        ? await authClient.twoFactor.verifyBackupCode({ code: code.trim() })
        : await authClient.twoFactor.verifyTotp({ code: code.trim(), trustDevice: true });
      if (res.error) setError(t("That code is not valid. Try the current one from your app."));
      else { window.location.href = nextPath(); return; }
    } catch {
      setError(t("Something went wrong"));
    }
    setBusy(false);
  }

  if (twoStep) {
    return (
      <AuthShell side={mode}>
        <h1 className="serif">{t("Two-step verification")}</h1>
        <p className="muted auth-sub">{t(backup ? "Enter one of your backup codes." : "Enter the 6-digit code from your authenticator app.")}</p>
        <form className="auth-fields" onSubmit={verify}>
          <label className="fld">{t("Verification code")}<input className="in mono" autoFocus required inputMode={backup ? "text" : "numeric"} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder={backup ? "xxxxx-xxxxx" : "123456"} /></label>
          {error && <p className="err">{error}</p>}
          <button className="btn primary full auth-go" disabled={busy}>{busy ? t("Signing in…") : t("Verify")}</button>
        </form>
        <p className="muted auth-foot"><a href="#" className="auth-link" onClick={(e) => { e.preventDefault(); setBackup(!backup); setCode(""); setError(""); }}>{t(backup ? "Use your authenticator app" : "Use a backup code")}</a></p>
      </AuthShell>
    );
  }

  return (
    <AuthShell side={mode}>
      <h1 className="serif">{t(login ? "Welcome back." : "Start watching.")}</h1>
      <p className="muted auth-sub">{t(login ? "Sign in to see what’s up — and what isn’t." : "Free and open source. Your first monitor in two minutes.")}</p>

      {github && (
        <>
          <button type="button" className="btn full auth-oauth" onClick={() => authClient.signIn.social({ provider: "github", callbackURL: "/app" })}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M18 10.5c0 4-12 2-12 5" /></svg>
            {t("Continue with GitHub")}
          </button>
          <div className="auth-or"><span>{t("or")}</span></div>
        </>
      )}

      <form className="auth-fields" onSubmit={submit}>
        {!login && (
          <label className="fld">{t("Name")}<input className="in" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder={t("Your name")} /></label>
        )}
        <label className="fld">{t(login ? "Email" : "Work email")}<input className="in" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@company.com" /></label>
        <label className="fld">
          <span className="fld-row">{t("Password")}{login && <a href="/forgot-password" className="auth-link">{t("Forgot password?")}</a>}</span>
          <span className="pw">
            <input className="in" type={show ? "text" : "password"} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={login ? "current-password" : "new-password"} placeholder={login ? "••••••••" : t("At least 8 characters")} />
            <button type="button" className="pw-t" onClick={() => setShow(!show)}>{t(show ? "Hide" : "Show")}</button>
          </span>
        </label>
        {error && <p className="err">{error}</p>}
        <button className="btn primary full auth-go" disabled={busy}>{busy ? t(login ? "Signing in…" : "Creating account…") : t(login ? "Sign in" : "Create account")}</button>
      </form>
      {!login && !open && (
        <p className="muted" style={{ fontSize: 13.5, textAlign: "center", marginTop: 14 }}>
          {t("Sign-ups are closed here. Only people who were invited to a workspace can create an account, using the invited email address.")}
        </p>
      )}
      {!login && (
        <p className="faint" style={{ fontSize: 12.5, textAlign: "center", marginTop: 14 }}>
          {t("By creating an account you agree to the")} <a href="/terms" className="auth-link">{t("Terms of Service")}</a> {t("and the")} <a href="/privacy" className="auth-link">{t("Privacy Policy")}</a>.
        </p>
      )}
      <p className="muted auth-foot">
        {login ? (open || location.search ? <>{t("New here?")} <a href={`/signup${location.search}`} className="auth-link">{t("Create an account")}</a></> : null) : <>{t("Have an account?")} <a href={`/login${location.search}`} className="auth-link">{t("Sign in")}</a></>}
      </p>
    </AuthShell>
  );
}
