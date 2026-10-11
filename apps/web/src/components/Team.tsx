import { t } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import { useBusy } from "../lib/use-busy";
import { authClient } from "../lib/auth-client";
import { api } from "../lib/api";

// The session's "active organization" can be unset (older sessions, cookie cache); the workspace the API resolves is authoritative.
const orgId = () => api.me().then((m) => m.organization.id);

type Member = { id: string; role: string; user: { name: string; email: string } };
type Invite = { id: string; email: string; role: string; status: string; expiresAt?: string };

/** "Expires in 6 days" / "Expires today", from the invitation's own expiry. */
function expiry(at?: string) {
  if (!at) return t("Invitation sent");
  const ms = new Date(at).getTime() - Date.now();
  if (ms <= 0) return t("Expired");
  const d = Math.floor(ms / 864e5);
  return d >= 1 ? `${t("Expires in")} ${d} ${t(d === 1 ? "day" : "days")}` : t("Expires today");
}

/** "⋯" button with a small dropdown of row actions. */
function RowMenu({ items, busy }: { items: { label: string; danger?: boolean; run: () => void | Promise<void> }[]; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  return (
    <span className="tm-act" ref={ref}>
      <button className="btn sm tm-dots" aria-label={t("Actions")} aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}>{busy ? "…" : "⋯"}</button>
      {open && (
        <div className="menu card" role="menu">
          {items.map((it) => (
            <button key={it.label} role="menuitem" className={`mi ${it.danger ? "danger" : ""}`} onClick={() => { setOpen(false); void it.run(); }}>{it.label}</button>
          ))}
        </div>
      )}
    </span>
  );
}

export default function Team() {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [msg, setMsg] = useState("");
  const [sent, setSent] = useState<{ email: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, run] = useBusy();
  const [removing, setRemoving] = useState("");
  const [canceling, setCanceling] = useState("");
  const [open, setOpen] = useState(false);
  const load = async () => {
    const res = await authClient.organization.getFullOrganization({ query: { organizationId: await orgId() } });
    const o = res.data as { members?: Member[]; invitations?: Invite[] } | null;
    setMembers(o?.members ?? []);
    setInvites((o?.invitations ?? []).filter((i) => i.status === "pending" && (!i.expiresAt || new Date(i.expiresAt).getTime() > Date.now())));
  };
  useEffect(() => { load(); }, []);

  async function invite(e: React.SyntheticEvent) {
    e.preventDefault();
    setMsg("");
    await run(async () => {
      try {
        const res = await authClient.organization.inviteMember({ email, role: role as "member" | "admin", organizationId: await orgId() });
        if (res.error) return setMsg(res.error.message ?? "Could not invite");
        setSent({ email, link: `${location.origin}/accept-invite/${(res.data as { id: string }).id}` });
        setCopied(false);
        setEmail("");
        await load();
        setOpen(false);
      } catch (x) { setMsg((x as Error).message); }
    });
  }
  const initial = (m: string) => (m.trim()[0] ?? "?").toUpperCase();
  return (
    <>
      <div className="ph">
        <div><h1>{t("Team")}</h1><p className="muted">{t("People who can see and change this workspace.")}</p></div>
        <button className="btn primary" onClick={() => { setMsg(""); setSent(null); setOpen(true); }}>{t("+ Invite teammate")}</button>
      </div>
      {sent && (
        <div className="callout ok" role="status">
          <span className="ci"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg></span>
          <div className="cb">
            <b>{t("Invitation sent to")} {sent.email}</b>
            <p className="muted">{t("They’ll get an email. You can also share this link directly:")}</p>
            <div className="lk">
              <code className="mono">{sent.link}</code>
              <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(sent.link).then(() => setCopied(true)).catch(() => {}); }}>{copied ? t("Copied") : t("Copy link")}</button>
            </div>
          </div>
          <button className="x" aria-label="Dismiss" onClick={() => setSent(null)}>×</button>
        </div>
      )}
      <div className="cols">
        <div className="col">
          <div className="card tbl">
            <div className="tr th tm-tr"><span>{t("Name")}</span><span>{t("Role")}</span><span /></div>
            {members.map((m) => (
              <div className="tr tm-tr" key={m.id}>
                <div className="nm"><span className="av">{initial(m.user.name || m.user.email)}</span><div><b style={{ fontWeight: 600 }}>{m.user.name}</b><small>{m.user.email}</small></div></div>
                <span><span className={`pill ${m.role === "owner" ? "up" : ""}`}>{t(m.role)}</span></span>
                {m.role !== "owner" ? (
                  <RowMenu busy={removing === m.id} items={[{
                    label: t("Remove from workspace"), danger: true,
                    run: async () => {
                      if (!confirm(`${t("Remove")} ${m.user.email}?`)) return;
                      setRemoving(m.id);
                      try { await authClient.organization.removeMember({ memberIdOrEmail: m.id, organizationId: await orgId() }); await load(); } catch (x) { setMsg((x as Error).message); } finally { setRemoving(""); }
                    },
                  }]} />
                ) : <span />}
              </div>
            ))}
            {invites.map((i) => (
              <div className="tr tm-tr inv" key={i.id}>
                <div className="nm"><span className="av ghost">?</span><div><b style={{ fontWeight: 600 }}>{i.email}</b><small>{expiry(i.expiresAt)}</small></div></div>
                <span><span className="pill pending">{t("pending")}</span></span>
                <RowMenu busy={canceling === i.id} items={[
                  {
                    label: t("Copy invite link"),
                    run: async () => { await navigator.clipboard?.writeText(`${location.origin}/accept-invite/${i.id}`).catch(() => {}); },
                  },
                  {
                    label: t("Cancel invitation"), danger: true,
                    run: async () => {
                      if (!confirm(`${t("Cancel invitation")} ${i.email}?`)) return;
                      setCanceling(i.id);
                      try {
                        const r = await authClient.organization.cancelInvitation({ invitationId: i.id });
                        if (r.error) setMsg(r.error.message ?? "Could not cancel");
                        await load();
                      } catch (x) { setMsg((x as Error).message); } finally { setCanceling(""); }
                    },
                  },
                ]} />
              </div>
            ))}
          </div>
          {msg && !open && <p className="err" style={{ marginTop: 14 }}>{msg}</p>}
        </div>
        <div className="col">
          <div className="card cc">
            <div className="cc-h"><h3>{t("Roles")}</h3></div>
            <div className="kv">
              <div><span>{t("owner")}</span><b>{t("Full control, including members and workspace settings.")}</b></div>
              <div><span>{t("admin")}</span><b>{t("Manage monitors, channels, status pages and members.")}</b></div>
              <div><span>{t("member")}</span><b>{t("Work with monitors and incidents.")}</b></div>
            </div>
          </div>
        </div>
      </div>

      {open && (
        <div className="modal" onClick={() => setOpen(false)}>
          <form className="card" onClick={(e) => e.stopPropagation()} onSubmit={invite}>
            <h2 style={{ fontSize: 30 }}>{t("Invite a teammate")}</h2>
            <label className="fld">{t("Email")}<input className="in" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com" /></label>
            <div className="fld">{t("Role")}
              <div className="seg">
                {(["member", "admin"] as const).map((r) => <i key={r} className={role === r ? "on" : ""} onClick={() => setRole(r)}>{t(r)}</i>)}
              </div>
            </div>
            {msg && <p className="err">{msg}</p>}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={() => setOpen(false)}>{t("Cancel")}</button>
              <button className="btn primary" disabled={busy}>{busy ? t("Creating…") : t("Create invitation")}</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
