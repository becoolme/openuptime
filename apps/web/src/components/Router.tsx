import { useEffect, useState } from "react";
import { armCache } from "../lib/api";
import { NAV_LABEL, resolveRoute } from "../lib/routes";
import { t } from "../lib/i18n";
import { lp, stripLocale } from "../lib/locale-path";
import Toaster from "./Toaster";
import VerifyBar from "./VerifyBar";
import Monitors from "./Monitors";
import MonitorDetail from "./MonitorDetail";
import Incidents from "./Incidents";
import IncidentDetail from "./IncidentDetail";
import StatusPages, { StatusPageEditor } from "./StatusPages";
import Alerting from "./Alerting";
import Maintenance from "./Maintenance";
import Team from "./Team";
import Account from "./Account";
import ApiKeys from "./ApiKeys";
import Settings from "./Settings";
import Usage from "./Usage";

const NAV_PREFIX = "/app";

/** Moves the sidebar highlight, breadcrumb and tab title to the route that is now showing (the shell itself is server-rendered once). */
function syncShell(pathname: string) {
  const hit = resolveRoute(pathname);
  const key = hit?.route.key ?? "";
  document.querySelectorAll<HTMLElement>("[data-nav]").forEach((el) => el.classList.toggle("on", el.dataset.nav === key));
  document.getElementById("tab-more")?.classList.toggle("on", ["maintenance", "team", "settings", "usage"].includes(key));
  const label = hit ? t(NAV_LABEL[hit.route.key]) : t("Not found");
  const crumb = document.querySelector(".crumb b");
  if (crumb) crumb.textContent = label;
  document.title = `${t(hit?.route.title ?? "Not found")} · OpenUptime`;
}

/** Same-origin /app links navigate in place; everything else (modifier clicks, new tabs, other pages) is left to the browser. */
function internal(a: HTMLAnchorElement, e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  if (a.target && a.target !== "_self") return false;
  if (a.hasAttribute("download") || a.origin !== location.origin) return false;
  const p = stripLocale(a.pathname);
  return p === NAV_PREFIX || p.startsWith(NAV_PREFIX + "/");
}

function View({ name, params }: { name: string; params: string[] }) {
  switch (name) {
    case "Monitors": return <Monitors />;
    case "MonitorDetail": return <MonitorDetail id={params[0]} />;
    case "Incidents": return <Incidents />;
    case "IncidentDetail": return <IncidentDetail id={params[0]} />;
    case "StatusPages": return <StatusPages />;
    case "StatusPageEditor": return <StatusPageEditor id={params[0]} />;
    case "Alerting": return <Alerting />;
    case "Maintenance": return <Maintenance />;
    case "Team": return <Team />;
    case "Account": return <Account />;
    case "ApiKeys": return <ApiKeys />;
    case "Settings": return <Settings />;
    case "Usage": return <Usage />;
    default: return null;
  }
}

/** Client-side router for the back office: one HTML load, then page changes only fetch API data. */
export default function Router() {
  const [path, setPath] = useState(() => location.pathname);
  const [bump, setBump] = useState(0);
  const [scope, setScope] = useState(0);

  useEffect(() => {
    let remounted = false;
    const show = () => {
      remounted = false;
      setPath(location.pathname);
      setBump(0);
      syncShell(location.pathname);
      document.getElementById("app")?.classList.remove("open");
      window.scrollTo(0, 0);
      window.dispatchEvent(new Event("ou:changed")); // refresh the sidebar counts
    };
    const onPop = () => { armCache(); show(); };
    // another workspace or project: same page, new data — remount it even though the path did not change
    const onScope = () => { setScope((n) => n + 1); show(); };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || !internal(a, e)) return;
      e.preventDefault();
      if (a.pathname + a.search === location.pathname + location.search) return;
      history.pushState(null, "", a.pathname + a.search);
      onPop();
    };
    // a revisited page was painted from cache and the background refresh found newer data: remount once with it
    const onStale = () => {
      if (remounted) return;
      remounted = true;
      armCache();
      setBump((n) => n + 1);
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("ou:scope", onScope);
    window.addEventListener("ou:stale", onStale);
    document.addEventListener("click", onClick);
    syncShell(location.pathname);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("ou:scope", onScope);
      window.removeEventListener("ou:stale", onStale);
      document.removeEventListener("click", onClick);
    };
  }, []);

  const hit = resolveRoute(path);
  if (!hit) return <p className="muted">{t("Page not found.")} <a href={lp("/app")}>{t("← Monitors")}</a></p>;
  return <><Toaster /><VerifyBar /><View key={`${path}#${scope}#${bump}`} name={hit.route.name} params={hit.params} /></>;
}
