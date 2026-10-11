import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { t } from "../lib/i18n";
import { toast } from "../lib/toast";

const KEY = "ou_verify_dismissed";

/** Notification bar for accounts whose email address is not verified yet. */
export default function VerifyBar() {
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem(KEY) === "1"; } catch { return false; } });
  useEffect(() => {
    // back from the link in the verification email: say so, then tidy the address bar
    const q = new URLSearchParams(location.search);
    if (q.get("verified") || q.get("error")) {
      if (q.get("error")) toast(t("That verification link is invalid or has expired. Send a new one."), "err");
      else toast(t("Your email address is verified."));
      q.delete("verified"); q.delete("error");
      history.replaceState(null, "", location.pathname + (q.size ? `?${q}` : "") + location.hash);
    }
    api.me().then((m) => { if (m.user && m.user.emailVerified === false) setEmail(m.user.email ?? null); }).catch(() => {});
  }, []);
  if (!email || hidden) return null;
  async function send() {
    setBusy(true);
    const r = await authClient.sendVerificationEmail({ email: email!, callbackURL: "/app/account?verified=1" }).catch(() => null);
    setBusy(false);
    if (!r || r.error) toast(r?.error?.message ?? t("Something went wrong"), "err");
    else toast(t("Verification email sent. Check your inbox."));
  }
  return (
    <div className="verify-bar" role="alert">
      <span>{t("Please verify your email address — we sent a link to {email}.").replace("{email}", email)}</span>
      <button className="btn sm" disabled={busy} onClick={send}>{busy ? t("Sending…") : t("Send verification email")}</button>
      <button className="icon-btn" aria-label={t("Dismiss")} onClick={() => { try { sessionStorage.setItem(KEY, "1"); } catch {} setHidden(true); }}>×</button>
    </div>
  );
}
