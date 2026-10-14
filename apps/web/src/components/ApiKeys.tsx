import { t } from "../lib/i18n";
import { useEffect, useState } from "react";
import { useBusy } from "../lib/use-busy";
import { ago, api, type Project } from "../lib/api";
import { authClient } from "../lib/auth-client";
import QRCode from "qrcode";

type Key = { id: string; name: string | null; start: string | null; createdAt: string; metadata?: { projectIds?: string[] } | null };

type Grant = { id: string; clientId: string; scopes: string[]; updatedAt: string; name?: string };

/** Agents (MCP clients) the user authorized through OAuth; deleting the grant cuts their access immediately. */
function AgentGrants() {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [gone, setGone] = useState("");
  const load = async () => {
    const r = await fetch("/api/auth/oauth2/get-consents", { credentials: "include" });
    const list = r.ok ? ((await r.json()) as Grant[]) : [];
    const named = await Promise.all(list.map(async (g) => {
      const c = await fetch(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(g.clientId)}`, { credentials: "include" }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
      return { ...g, name: (c as { name?: string; client_name?: string } | null)?.name ?? (c as { client_name?: string } | null)?.client_name };
    }));
    setGrants(named);
  };
  useEffect(() => { load().catch(() => setGrants([])); }, []);
  if (!grants?.length) return null;
  return (
    <>
      <div className="ph" style={{ marginTop: 28 }}>
        <div><h2 style={{ fontSize: 22 }}>{t("Authorized agents")}</h2><p className="muted">{t("Apps you let manage OpenUptime on your behalf (MCP / OAuth).")}</p></div>
      </div>
      <div className="card tbl">
        {grants.map((g) => (
          <div className="tr" key={g.id} style={{ gridTemplateColumns: "1fr auto auto" }}>
            <div><b style={{ fontWeight: 600 }}>{g.name ?? t("An application")}</b><div className="muted" style={{ fontSize: 13 }}>{g.scopes.filter((x) => x.startsWith("mcp:")).join(", ") || "—"}</div></div>
            <span className="muted">{ago(g.updatedAt)}</span>
            <button className="btn sm" disabled={gone === g.id} onClick={async () => {
              if (!confirm(t("Revoke this key?"))) return;
              setGone(g.id);
              try {
                await fetch("/api/auth/oauth2/delete-consent", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: g.id }) });
                await load();
              } finally { setGone(""); }
            }}>{gone === g.id ? t("Revoking…") : t("Revoke")}</button>
          </div>
        ))}
      </div>
    </>
  );
}

export default function ApiKeys() {
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState("");
  const [err, setErr] = useState("");
  const [busy, run] = useBusy();
  const [revoking, setRevoking] = useState("");
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const load = async () => {
    const res = await authClient.apiKey.list();
    const d = res.data as unknown;
    setKeys((Array.isArray(d) ? d : (d as { apiKeys?: Key[] } | null)?.apiKeys ?? []) as Key[]);
  };
  useEffect(() => { load(); api.projects().then(setProjects).catch(() => {}); }, []);
  const scopeOf = (k: Key) => {
    const ids = k.metadata?.projectIds;
    if (!ids?.length) return t("All projects");
    return ids.map((id) => projects.find((p) => p.id === id)?.name ?? "—").join(", ");
  };

  async function create(e: React.SyntheticEvent) {
    e.preventDefault();
    setErr("");
    await run(async () => {
      try {
        const me = await api.me();
        if (!all && !picked.length) return setErr(t("Pick at least one project."));
        const res = await authClient.apiKey.create({ name, metadata: { organizationId: me.organization.id, ...(all ? {} : { projectIds: picked }) } });
        if (res.error) return setErr(res.error.message ?? "Could not create key");
        setFresh((res.data as { key: string }).key);
        setName("");
        setAll(true);
        setPicked([]);
        setOpen(false);
        await load();
      } catch (e) { setErr((e as Error).message); }
    });
  }
  // the mobile app reads this link: scan it from Settings, or on the welcome screen
  const [qr, setQr] = useState("");
  useEffect(() => {
    if (!fresh) { setQr(""); return; }
    QRCode.toDataURL(`openuptime://connect?server=${encodeURIComponent(location.origin)}&key=${encodeURIComponent(fresh)}`, { margin: 1, width: 168 })
      .then(setQr).catch(() => setQr(""));
  }, [fresh]);
  const keyIcon = <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l3 3" /></svg>;
  return (
    <>
      <div className="ph">
        <div><h1>{t("API keys")}</h1><p className="muted">{t("Send as")} <span className="mono">{t("x-api-key")}</span> {t("or a Bearer token to")} <span className="mono">{t("/api/*")}</span>.</p></div>
        <button className="btn primary" onClick={() => { setErr(""); setOpen(true); }}>{t("+ New key")}</button>
      </div>
      {fresh && (
        <div className="card fresh">
          <b>{t("Copy your key now — it won’t be shown again.")}</b>
          <div className="fresh-r">
            <code className="mono">{fresh}</code>
            <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(fresh); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? t("Copied ✓") : t("Copy")}</button>
          </div>
          {qr && (
            <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 14 }}>
              <img src={qr} alt={t("QR code to connect the mobile app")} width={168} height={168} style={{ background: "#fff", borderRadius: 8, flex: "none" }} />
              <p className="muted" style={{ fontSize: 13 }}>{t("Scan with the OpenUptime app to connect it to this server. The code contains the key, so do not share it.")}</p>
            </div>
          )}
        </div>
      )}
      {err && !open && <p className="err">{err}</p>}
      <div className="card tbl">
        <div className="tr th ak-tr"><span>{t("Name")}</span><span>{t("Key")}</span><span>{t("Projects")}</span><span>{t("Created")}</span><span /></div>
        {keys === null && <div className="tr" style={{ gridTemplateColumns: "1fr" }}><span className="muted">{t("Loading…")}</span></div>}
        {keys?.length === 0 && <div className="tr" style={{ gridTemplateColumns: "1fr" }}><span className="muted">{t("No keys yet.")}</span></div>}
        {keys?.map((k) => (
          <div className="tr ak-tr" key={k.id}>
            <div className="nm"><span className="ri ch-ic">{keyIcon}</span><b style={{ fontWeight: 600 }}>{k.name ?? t("Untitled")}</b></div>
            <span className="mono muted" style={{ fontSize: 13 }}>{k.start ?? ""}…</span>
            <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{scopeOf(k)}</span>
            <span className="muted">{ago(k.createdAt)}</span>
            <button className="btn sm" disabled={revoking === k.id} onClick={async () => {
              if (!confirm(t("Revoke this key?"))) return;
              setRevoking(k.id);
              try { await authClient.apiKey.delete({ keyId: k.id }); await load(); } catch (e) { setErr((e as Error).message); } finally { setRevoking(""); }
            }}>{revoking === k.id ? t("Revoking…") : t("Revoke")}</button>
          </div>
        ))}
      </div>
      <AgentGrants />
      <div className="card cc" style={{ marginTop: 22 }}>
        <div className="cc-h"><h3>{t("Quick start")}</h3><span className="chip">REST</span></div>
        <pre className="code2">{`curl ${location.origin}/api/monitors \\\n  -H "x-api-key: ou_…" \\\n  -H "x-project-id: <project id>"`}</pre>
      </div>

      {open && (
        <div className="modal" onClick={() => setOpen(false)}>
          <form className="card" onClick={(e) => e.stopPropagation()} onSubmit={create}>
            <h2 style={{ fontSize: 30 }}>{t("New API key")}</h2>
            <label className="fld">{t("Name")}<input className="in" required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("CI deploy hook")} /></label>
            <div className="fld">{t("Project access")}
              <div className="seg">
                <i className={all ? "on" : ""} onClick={() => setAll(true)}>{t("All projects")}</i>
                <i className={!all ? "on" : ""} onClick={() => setAll(false)}>{t("Selected projects")}</i>
              </div>
              {!all && (
                <div style={{ display: "grid", gap: 2, marginTop: 6, padding: 6, border: "1px solid var(--line)", borderRadius: 12, maxHeight: 180, overflow: "auto" }}>
                  {projects.map((p) => (
                    <label key={p.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 8px", fontSize: 14, fontWeight: 400, cursor: "pointer" }}>
                      <input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked((l) => (e.target.checked ? [...l, p.id] : l.filter((x) => x !== p.id)))} />{p.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
            {err && <p className="err">{err}</p>}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={() => setOpen(false)}>{t("Cancel")}</button>
              <button className="btn primary" disabled={busy}>{busy ? t("Creating…") : t("Create key")}</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
