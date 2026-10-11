import { useState } from "react";
import { useBusy } from "../lib/use-busy";
import { authClient } from "../lib/auth-client";
import { t } from "../lib/i18n";
import { AuthShell } from "./AuthShell";

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, run] = useBusy();
  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    await run(() => authClient.requestPasswordReset({ email, redirectTo: "/reset-password" }).catch(() => null));
    setSent(true); // same answer whether or not the address exists
  }
  return (
    <AuthShell side="login">
      <h1 className="serif">{t("Reset your password")}</h1>
      <p className="muted auth-sub">{t("We’ll email you a link to choose a new one.")}</p>
      {sent ? <p className="auth-note">{t("If that address has an account, a reset link is on its way.")}</p> : (
        <form className="auth-fields" onSubmit={submit}>
          <label className="fld">{t("Email")}<input className="in" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@company.com" /></label>
          <button className="btn primary full auth-go" disabled={busy}>{busy ? t("Sending…") : t("Send reset link")}</button>
        </form>
      )}
      <p className="muted auth-foot"><a href="/login" className="auth-link">{t("← Back to sign in")}</a></p>
    </AuthShell>
  );
}

export function ResetPassword() {
  const token = new URLSearchParams(location.search).get("token");
  const [pw, setPw] = useState("");
  const [state, setState] = useState<"idle" | "done" | "bad">(token ? "idle" : "bad");
  const [busy, run] = useBusy();
  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    const res = await run(() => authClient.resetPassword({ newPassword: pw, token: token! }).catch(() => ({ error: true })));
    setState(res?.error ? "bad" : "done");
  }
  return (
    <AuthShell side="login">
      <h1 className="serif">{t("Choose a new password")}</h1>
      {state === "done" ? (
        <><p className="auth-note">{t("Your password was updated.")}</p><a className="btn primary full auth-go" href="/login">{t("Sign in")}</a></>
      ) : (
        <form className="auth-fields" onSubmit={submit}>
          {state === "bad" && <p className="err">{t("This reset link is invalid or has expired.")}</p>}
          <label className="fld">{t("New password")}<input className="in" type="password" minLength={8} required value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" placeholder={t("At least 8 characters")} /></label>
          <button className="btn primary full auth-go" disabled={busy}>{busy ? t("Saving…") : t("Save password")}</button>
        </form>
      )}
    </AuthShell>
  );
}
