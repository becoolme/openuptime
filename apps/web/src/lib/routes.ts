import { stripLocale } from "./locale-path";

/** The back-office route table, shared by the static shell (404 status for deep links) and the client router. */
export type NavKey = "monitors" | "incidents" | "status-pages" | "alerting" | "maintenance" | "team" | "account" | "api-keys" | "settings" | "usage";
export type Route = {
  re: RegExp;
  name: string;
  /** which sidebar entry is highlighted */
  key: NavKey;
  /** English title (translated at the edge of use) */
  title: string;
  /** API GETs (without the /api prefix) the page needs first; the client starts them before its JS has loaded */
  data: (p: string[]) => string[];
};

export const NAV_LABEL: Record<NavKey, string> = {
  monitors: "Monitors", incidents: "Incidents", "status-pages": "Status pages", alerting: "Alerting",
  maintenance: "Maintenance", team: "Team", account: "Account", "api-keys": "API keys", settings: "Settings", usage: "Plan & usage",
};

export const ROUTES: Route[] = [
  { re: /^\/app$/, name: "Monitors", key: "monitors", title: "Monitors", data: () => ["/monitors", "/incidents", "/channels", "/status-pages"] },
  { re: /^\/app\/monitors\/([^/]+)$/, name: "MonitorDetail", key: "monitors", title: "Monitor", data: ([id]) => [`/monitors/${id}`, "/channels"] },
  { re: /^\/app\/incidents$/, name: "Incidents", key: "incidents", title: "Incidents", data: () => ["/incidents"] },
  { re: /^\/app\/incidents\/([^/]+)$/, name: "IncidentDetail", key: "incidents", title: "Incident", data: ([id]) => [`/incidents/${id}`] },
  { re: /^\/app\/status-pages$/, name: "StatusPages", key: "status-pages", title: "Status pages", data: () => ["/status-pages"] },
  { re: /^\/app\/status-pages\/([^/]+)$/, name: "StatusPageEditor", key: "status-pages", title: "Status page", data: ([id]) => [`/status-pages/${id}`, "/monitors", `/status-pages/${id}/subscribers`] },
  { re: /^\/app\/alerting$/, name: "Alerting", key: "alerting", title: "Alerting", data: () => ["/channels"] },
  { re: /^\/app\/maintenance$/, name: "Maintenance", key: "maintenance", title: "Maintenance", data: () => ["/maintenance", "/monitors"] },
  { re: /^\/app\/team$/, name: "Team", key: "team", title: "Team", data: () => [] },
  { re: /^\/app\/account$/, name: "Account", key: "account", title: "Account", data: () => [] },
  { re: /^\/app\/api-keys$/, name: "ApiKeys", key: "api-keys", title: "API keys", data: () => ["/projects"] },
  { re: /^\/app\/usage$/, name: "Usage", key: "usage", title: "Plan & usage", data: () => ["/usage", "/monitors"] },
  { re: /^\/app\/settings$/, name: "Settings", key: "settings", title: "Settings", data: () => [] },
];

export function resolveRoute(pathname: string): { route: Route; params: string[] } | null {
  const bare = stripLocale(pathname);
  const path = bare.length > 1 ? bare.replace(/\/+$/, "") : bare;
  for (const route of ROUTES) {
    const m = path.match(route.re);
    if (m) return { route, params: m.slice(1).map(decodeURIComponent) };
  }
  return null;
}
