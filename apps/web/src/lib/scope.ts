/** The "All projects" view of a workspace: the project cookie holds `all` instead of a project id. */
export const COOKIE = "ou_project";
export const ALL = "all";

/** The value of the project cookie, or "" when there is none. */
export function projectCookie(cookie: string): string {
  const m = cookie.split(/;\s*/).find((p) => p.startsWith(`${COOKIE}=`));
  return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : "";
}

/** True when the browser is in the "All projects" view. */
export const isAllProjects = (cookie = typeof document === "undefined" ? "" : document.cookie) => projectCookie(cookie) === ALL;

/** A `document.cookie` assignment that selects a project (or `all`) for a year. */
export const setProjectCookie = (id: string) => `${COOKIE}=${id};path=/;max-age=31536000;samesite=lax`;

/** The name of a project for a badge; "" while the project list is unknown or the id is not in it. */
export function projectName(projects: { id: string; name: string }[], id: string | null | undefined): string {
  return projects.find((p) => p.id === id)?.name ?? "";
}

/** The project list as shown in the merged lists: only worth a badge when the workspace has more than one project. */
export const showBadges = (projects: { id: string }[]) => projects.length > 1;
