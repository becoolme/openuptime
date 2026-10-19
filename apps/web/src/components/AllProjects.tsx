import { useEffect, useState } from "react";
import { api, type Project, type ProjectOverview } from "../lib/api";
import { t } from "../lib/i18n";
import { selectProject } from "../lib/nav";
import { plural } from "../lib/plural";
import { projectName, showBadges } from "../lib/scope";

/** The projects of the workspace, for naming the rows of a merged list. */
export function useProjects(): Project[] {
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => { api.projects().then(setProjects).catch(() => {}); }, []);
  return projects;
}

/** Small project label on a row of a merged list; clicking it switches to that project instead of opening the row. */
export function ProjectBadge({ id, projects }: { id: string | null | undefined; projects: Project[] }) {
  const name = projectName(projects, id);
  if (!id || !name || !showBadges(projects)) return null;
  const go = (e: React.SyntheticEvent) => { e.preventDefault(); e.stopPropagation(); selectProject(id); };
  return (
    <span className="pbadge" role="button" tabIndex={0} title={name} onClick={go} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && go(e)}>{name}</span>
  );
}

/** Small chip beside a page title saying the page lists every project of the workspace. */
export function ScopeChip() {
  return <span className="scope-chip">{t("All projects")}</span>;
}

/** Per-project summary on top of the Monitors page in the "All projects" view. */
export function ProjectStrip({ rows }: { rows: ProjectOverview[] }) {
  if (rows.length < 2) return null;
  return (
    <div className="pov">
      {rows.map((p) => (
        <button key={p.id} type="button" className="card pov-c" onClick={() => selectProject(p.id)}>
          <b>{p.name}</b>
          <small>{plural(p.monitors, "monitor", "monitors")}{p.down > 0 && <> · <span className="bad">{p.down} {t("down")}</span></>}</small>
          <small>{p.openIncidents > 0 ? <span className="bad">{plural(p.openIncidents, "open incident", "open incidents")}</span> : t("No open incidents")}</small>
        </button>
      ))}
    </div>
  );
}

/** Shown instead of a page that belongs to one project while the "All projects" view is active. */
export function ChooseProject({ title }: { title: string }) {
  const projects = useProjects();
  return (
    <>
      <div className="ph"><div><h1>{t(title)}</h1><p className="muted">{t("This page belongs to a single project. Choose one to continue.")}</p></div></div>
      <div className="card" style={{ padding: 8, maxWidth: 420 }}>
        <div className="menu-h nav-l"><span>{t("Projects")}</span></div>
        <div className="menu" style={{ position: "static", boxShadow: "none", border: 0, padding: 0 }}>
          {projects.map((p) => <button key={p.id} type="button" className="mi" onClick={() => selectProject(p.id)}>{p.name}</button>)}
        </div>
      </div>
    </>
  );
}
