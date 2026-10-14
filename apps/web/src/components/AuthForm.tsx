import { t } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
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

type TurnstileApi = { render(el: HTMLElement, o: Record<string, unknown>): string; reset(id?: string): void; remove(id?: string): void };
const turnstileApi = () => (window as unknown as { turnstile?: TurnstileApi }).turnstile;
let turnstileScript: Promise<void> | undefined;
/** Cloudflare's Turnstile script, loaded on demand (only when the operator configured a site key). */
const loadTurnstile = () =>
  (turnstileScript ??= new Promise<void>((ok, fail) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => ok();
    s.onerror = () => { turnstileScript = undefined; fail(new Error("turnstile")); };
    document.head.append(s);
  }));

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
  // Cloudflare Turnstile on sign-up: the site key comes from the API, which only reports one when verification is on
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [legal, setLegal] = useState(false);
  const widget = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const login = mode === "login";

  useEffect(() => {
    // the page is static, so "already signed in" is checked here
    fetch("/api/me", { credentials: "include" }).then((r) => r.ok && (window.location.href = nextPath())).catch(() => {});
    fetch("/api/auth-providers").then((r) => r.json()).then((d: { github?: boolean; signup?: boolean; turnstileSiteKey?: string | null; legal?: boolean }) => { setLegal(!!d.legal); setGithub(!!d.github); setOpen(d.signup !== false); setSiteKey(d.turnstileSiteKey || null); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (login || !siteKey) return;
    let gone = false;
    loadTurnstile().then(() => {
      const api = turnstileApi();
      if (gone || !api || !widget.current) return;
      widgetId.current = api.render(widget.current, {
        sitekey: siteKey,
        callback: (v: string) => setToken(v),
        "expired-callback": () => setToken(""),
        "error-callback": () => setToken(""),
      });
    }).catch(() => setError(t("Something went wrong")));
    return () => {
      gone = true;
      if (widgetId.current) turnstileApi()?.remove(widgetId.current);
      widgetId.current = undefined;
    };
  }, [login, siteKey]);

  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!login && siteKey && !token) return setError(t("Please complete the verification."));
    setBusy(true);
    setError("");
    try {
      const res = login
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email(
            { email, password, name: name || email.split("@")[0], callbackURL: "/app/account?verified=1" },
            siteKey ? { headers: { "x-captcha-response": token } } : undefined,
          );
      if (res.error) {
        setError(res.error.message ?? t("Something went wrong"));
        // a Turnstile token works once: ask for a fresh one
        if (!login && siteKey) { setToken(""); turnstileApi()?.reset(widgetId.current); }
      }
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
            <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
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
        {!login && siteKey && <div ref={widget} className="auth-captcha" style={{ minHeight: 65 }} />}
        {error && <p className="err">{error}</p>}
        <button className="btn primary full auth-go" disabled={busy}>{busy ? t(login ? "Signing in…" : "Creating account…") : t(login ? "Sign in" : "Create account")}</button>
      </form>
      {!login && !open && (
        <p className="muted" style={{ fontSize: 13.5, textAlign: "center", marginTop: 14 }}>
          {t("Sign-ups are closed here. Only people who were invited to a workspace can create an account, using the invited email address.")}
        </p>
      )}
      {!login && legal && (
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
