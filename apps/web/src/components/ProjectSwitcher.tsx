import { useEffect, useRef, useState } from "react";
import { api, type Project } from "../lib/api";
import { t } from "../lib/i18n";
import { authClient } from "../lib/auth-client";
import { useBusy } from "../lib/use-busy";
import { go } from "../lib/locale-path";

const COOKIE = "ou_project";
const select = (id: string) => {
  document.cookie = `${COOKIE}=${id};path=/;max-age=31536000;samesite=lax`;
  go("/app");
};

/** Sidebar workspace block: shows the workspace and active project, and switches / creates / renames / deletes projects. */
export default function ProjectSwitcher() {
  const [org, setOrg] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [current, setCurrent] = useState("");
  const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([]);
  const [orgId, setOrgId] = useState("");
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addingWs, setAddingWs] = useState(false);
  const [wsName, setWsName] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, run] = useBusy();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([api.projects(), api.me()]).then(([p, m]) => { setProjects(p); setCurrent(m.projectId); setOrg(m.organization.name); setOrgId(m.organization.id); }).catch(() => {});
    authClient.organization.list().then((r) => setOrgs((r.data as { id: string; name: string }[] | null) ?? [])).catch(() => {});
  }, []);
  useEffect(() => {
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  async function switchOrg(id: string) {
    await authClient.organization.setActive({ organizationId: id });
    document.cookie = `${COOKIE}=;path=/;max-age=0`;
    go("/app");
  }
  async function createOrg(e: React.SyntheticEvent) {
    e.preventDefault();
    setErr("");
    const w = await run(() => api.createWorkspace(wsName.trim()).catch((x: Error) => { setErr(x.message); return null; }));
    if (w) await switchOrg(w.id);
  }
  const active = projects.find((p) => p.id === current);
  async function create(e: React.SyntheticEvent) {
    e.preventDefault();
    setErr("");
    const p = await run(() => api.createProject(name.trim()).catch((x: Error) => { setErr(x.message); return null; }));
    if (p) select(p.id);
  }
  async function rename() {
    const next = prompt(t("Project name"), active?.name ?? "")?.trim();
    if (!next || !active || next === active.name) return;
    await run(() => api.renameProject(active.id, next).then(() => setProjects((l) => l.map((p) => (p.id === active.id ? { ...p, name: next } : p)))).catch((x: Error) => setErr(x.message)));
  }
  async function remove() {
    if (!active || !confirm(`${t("Delete project")} “${active.name}”? ${t("Its monitors, status pages and channels are deleted too.")}`)) return;
    const ok = await run(() => api.deleteProject(active.id).then(() => true).catch((x: Error) => { setErr(x.message); return false; }));
    if (ok) { document.cookie = `${COOKIE}=;path=/;max-age=0`; go("/app"); }
  }

  return (
    <div className="ws-wrap" ref={ref}>
      <button className="ws" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <div><span>{org}</span><small>{active?.name ?? "…"}</small></div>
        <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m7 10 5 5 5-5" /></svg>
      </button>
      {open && (
        <div className="menu card" role="listbox">
          <div className="menu-h nav-l">
            <span>{t("Workspaces")}</span>
            <button type="button" className="menu-add" title={t("New workspace")} aria-label={t("New workspace")} onClick={() => setAddingWs(!addingWs)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
          </div>
          {orgs.length > 1 && (
            <div className="menu-list">
              {orgs.map((o) => (
                <button key={o.id} role="option" aria-selected={o.id === orgId} className={`mi ${o.id === orgId ? "on" : ""}`} onClick={() => (o.id === orgId ? setOpen(false) : switchOrg(o.id))}>
                  <span>{o.name}</span>{o.id === orgId && <span>✓</span>}
                </button>
              ))}
            </div>
          )}
          {addingWs && (
            <form onSubmit={createOrg} style={{ padding: 6, display: "grid", gap: 6 }}>
              <input className="in" style={{ height: 34, fontSize: 14 }} autoFocus required maxLength={60} placeholder={t("Workspace name")} value={wsName} onChange={(e) => setWsName(e.target.value)} />
              <button className="btn sm primary" disabled={busy}>{busy ? t("Creating…") : t("Create workspace")}</button>
            </form>
          )}
          <div className="sep" />
          <div className="menu-h nav-l">
            <span>{t("Projects")}</span>
            <button type="button" className="menu-add" title={t("New project")} aria-label={t("New project")} onClick={() => setAdding(!adding)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
          </div>
          <div className="menu-list">
            {projects.map((p) => (
              <button key={p.id} role="option" aria-selected={p.id === current} className={`mi ${p.id === current ? "on" : ""}`} onClick={() => (p.id === current ? setOpen(false) : select(p.id))}>
                <span>{p.name}</span>{p.id === current && <span>✓</span>}
              </button>
            ))}
          </div>
          {adding && (
            <form onSubmit={create} style={{ padding: 6, display: "grid", gap: 6 }}>
              <input className="in" style={{ height: 34, fontSize: 14 }} autoFocus required maxLength={60} placeholder={t("Project name")} value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn sm primary" disabled={busy}>{busy ? t("Creating…") : t("Create project")}</button>
            </form>
          )}
          <div className="sep" />
          <button className="mi" disabled={busy || !active} onClick={rename}>{t("Rename project")}</button>
          {projects.length > 1 && <button className="mi danger" disabled={busy || !active} onClick={remove}>{t("Delete project")}</button>}
          {err && <p className="err" style={{ padding: "4px 10px" }}>{err}</p>}
        </div>
      )}
    </div>
  );
}
