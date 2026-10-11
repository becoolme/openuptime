import { t } from "../lib/i18n";
import { go } from "../lib/locale-path";
import { useEffect, useState } from "react";
import { authClient } from "../lib/auth-client";
import { AuthShell } from "./AuthShell";

type Invitation = { organizationName?: string; inviterEmail?: string; role?: string; email?: string; status?: string; expiresAt?: string | Date };
type Phase = "loading" | "signin" | "ready" | "joining" | "declined" | "error";

/** Invitation landing page: nobody joins a workspace without seeing which one and pressing Accept. */
export default function AcceptInvite({ id }: { id: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [inv, setInv] = useState<Invitation | null>(null);
  const [msg, setMsg] = useState("");
  const next = encodeURIComponent(`/accept-invite/${id}`);

  useEffect(() => {
    (async () => {
      const me = await fetch("/api/me", { credentials: "include" }).then((r) => r.ok).catch(() => false);
      if (!me) return setPhase("signin");
      const res = await authClient.organization.getInvitation({ query: { id } });
      if (res.error || !res.data) {
        setMsg(res.error?.message ?? t("This invitation is not valid for this account."));
        return setPhase("error");
      }
      const d = res.data as Invitation;
      if (d.status && d.status !== "pending") {
        setMsg(d.status === "accepted" ? t("This invitation was already accepted.") : t("This invitation is no longer valid."));
        return setPhase("error");
      }
      setInv(d);
      setPhase("ready");
    })().catch((e: Error) => { setMsg(e.message); setPhase("error"); });
  }, [id]);

  async function accept() {
    setPhase("joining");
    const res = await authClient.organization.acceptInvitation({ invitationId: id });
    if (res.error || !res.data) {
      setMsg(res.error?.message ?? t("Could not accept the invitation"));
      return setPhase("error");
    }
    // make the joined workspace the active one, otherwise the app would keep showing the personal workspace
    const orgId = (res.data as { invitation?: { organizationId?: string }; member?: { organizationId?: string } });
    const target = orgId.invitation?.organizationId ?? orgId.member?.organizationId;
    if (target) await authClient.organization.setActive({ organizationId: target });
    go("/app");
  }
  async function decline() {
    const res = await authClient.organization.rejectInvitation({ invitationId: id });
    if (res.error) { setMsg(res.error.message ?? ""); return setPhase("error"); }
    setPhase("declined");
  }

  return (
    <AuthShell side="signup">
      <h1 className="serif">{t("Team invitation")}</h1>
      {phase === "loading" && <p className="muted auth-sub">{t("Loading…")}</p>}
      {phase === "signin" && (
        <>
          <p className="muted auth-sub">{t("Sign in or create an account to see and accept this invitation.")}</p>
          <a className="btn primary full auth-go" href={`/login?next=${next}`}>{t("Sign in")}</a>
          <p className="muted auth-foot">{t("New here?")} <a className="auth-link" href={`/signup?next=${next}`}>{t("Create an account")}</a></p>
        </>
      )}
      {(phase === "ready" || phase === "joining") && inv && (
        <>
          <p className="muted auth-sub">
            {inv.inviterEmail ? `${inv.inviterEmail} ${t("invited you to join")}` : t("You were invited to join")} <b>{inv.organizationName}</b> {t("as")} <b>{t(inv.role ?? "member")}</b>.
          </p>
          <button className="btn primary full auth-go" disabled={phase === "joining"} onClick={accept}>{phase === "joining" ? t("Joining…") : t("Accept invitation")}</button>
          <button className="btn full" style={{ marginTop: 10 }} disabled={phase === "joining"} onClick={decline}>{t("Decline")}</button>
        </>
      )}
      {phase === "declined" && <p className="muted auth-sub">{t("Invitation declined.")}</p>}
      {phase === "error" && (
        <>
          <p className="err">{msg}</p>
          <a className="btn full auth-go" href="/app">{t("Go to app")}</a>
        </>
      )}
    </AuthShell>
  );
}
