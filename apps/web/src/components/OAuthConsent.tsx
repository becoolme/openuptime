import { t } from "../lib/i18n";
import { useEffect, useState } from "react";
import { authClient } from "../lib/auth-client";
import { AuthShell } from "./AuthShell";

type Client = { name?: string; uri?: string; client_name?: string };
type Workspace = { id: string; name: string; projects: { id: string; name: string }[] };

/**
 * The picker's answer, parked in a short-lived cookie the authorization server reads: `*` (every workspace) or
 * `;`-separated `<workspace>|*` / `<workspace>|<project>,<project>` entries.
 */
const GRANT = "ou_grant";
type Entry = { org: string; ids: string[] | null };
/** The cookie reads `<code_challenge>~<grant>`, so it only ever answers the authorization request it was made for. */
const challengeOf = () => new URLSearchParams(location.search).get("code_challenge") ?? "";
const readGrant = (): "all" | Entry[] | null => {
  const m = document.cookie.split(/;\s*/).find((c) => c.startsWith(`${GRANT}=`));
  const v = decodeURIComponent(m?.slice(GRANT.length + 1) ?? "");
  const i = v.indexOf("~");
  const raw = i >= 0 && v.slice(0, i) === challengeOf() ? v.slice(i + 1) : "";
  if (!raw) return null;
  if (raw === "*") return "all";
  return raw.split(";").map((e) => e.split("|")).filter(([org]) => !!org).map(([org, sel]) => ({ org, ids: !sel || sel === "*" ? null : sel.split(",") }));
};
const writeGrant = (value: string) => {
  document.cookie = `${GRANT}=${encodeURIComponent(`${challengeOf()}~${value}`)}; path=/; max-age=300; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
};
const clearGrant = () => { document.cookie = `${GRANT}=; path=/; max-age=0`; };

/** Where the authorization server wants the browser next: its reply is `{ redirect_uri }` or `{ url }`. */
const target = (d: unknown) => (d as { redirect_uri?: string; url?: string } | null)?.redirect_uri ?? (d as { url?: string } | null)?.url;

async function post(path: string, body: unknown) {
  const r = await fetch(`/api/auth${path}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  return { ok: r.ok, data: data as Record<string, unknown> | null };
}

const SCOPE_TEXT: Record<string, string> = {
  "mcp:read": "See monitors, incidents, status pages, alert channels and maintenance windows",
  "mcp:write": "Create, change, pause and delete monitors, and open or update incidents",
  offline_access: "Stay connected without asking you again",
  openid: "Know which account this is",
};

/** Consent screen an agent (MCP client) sends the user to, and the workspace picker that can come before it. */
export default function OAuthConsent({ mode }: { mode: "consent" | "workspace" }) {
  const [client, setClient] = useState<Client | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [spaces, setSpaces] = useState<Workspace[]>([]);
  const [picked, setPicked] = useState("");
  // how much the agent gets: everything, whole workspaces, or single projects
  const [access, setAccess] = useState<"all" | "workspaces" | "projects">("all");
  const [chosenWs, setChosenWs] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [grant, setGrant] = useState<"all" | Entry[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const query = typeof location === "undefined" ? "" : location.search.slice(1);

  useEffect(() => {
    (async () => {
      const me = await fetch("/api/me", { credentials: "include" }).then((r) => r.ok).catch(() => false);
      if (!me) {
        window.location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
        return;
      }
      const p = new URLSearchParams(query);
      setScopes((p.get("scope") ?? "").split(/\s+/).filter(Boolean));
      const id = p.get("client_id");
      if (id) {
        const r = await fetch(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(id)}`, { credentials: "include" }).catch(() => null);
        if (r?.ok) setClient((await r.json()) as Client);
      }
      const pick = await fetch("/api/oauth/picker", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { active: string | null; workspaces: Workspace[] } | null;
      setSpaces(pick?.workspaces ?? []);
      if (mode === "workspace") {
        const first = pick?.active ?? pick?.workspaces[0]?.id ?? "";
        setPicked(first);
        setChosenWs(first ? [first] : []);
      }
      else setGrant(readGrant());
      setReady(true);
    })().catch(() => setError(t("Something went wrong")));
  }, [mode, query]);

  const many = spaces.length > 1;
  const toggleWs = (id: string) => setChosenWs((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  const toggle = (id: string) => setChosen((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  // a single workspace has nothing to choose between: "whole workspace" is then the only workspace-level answer
  const wsIds = many ? chosenWs : spaces.map((w) => w.id);
  const value =
    access === "all" ? "*"
    : access === "workspaces" ? wsIds.map((id) => `${id}|*`).join(";")
    : spaces.map((w) => [w.id, w.projects.filter((p) => chosen.includes(p.id)).map((p) => p.id)] as const).filter(([, ids]) => ids.length).map(([id, ids]) => `${id}|${ids.join(",")}`).join(";");

  async function continueWithWorkspace(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!value) return setError(t("Pick at least one project"));
    setBusy(true);
    setError("");
    // the session's own workspace follows the first one granted, as before
    const lead = value === "*" ? picked : value.split(";")[0].split("|")[0];
    const set = await authClient.organization.setActive({ organizationId: lead });
    if (set.error) { setBusy(false); return setError(set.error.message ?? t("Something went wrong")); }
    writeGrant(value);
    const r = await post("/oauth2/continue", { postLogin: true, oauth_query: query });
    const to = target(r.data);
    if (r.ok && to) { window.location.href = to; return; }
    clearGrant();
    setBusy(false);
    setError(t("Something went wrong"));
  }

  async function decide(accept: boolean) {
    setBusy(true);
    setError("");
    // the cookie is read while the consent is recorded, so it stays until the answer is back
    const r = await post("/oauth2/consent", { accept, oauth_query: query });
    clearGrant();
    const to = target(r.data);
    if (r.ok && to) { window.location.href = to; return; }
    setBusy(false);
    setError(t("Something went wrong"));
  }

  const name = client?.name ?? client?.client_name ?? t("An application");

  return (
    <AuthShell side="login">
      {mode === "workspace" ? (
        <>
          <h1 className="serif consent-h">{t("Choose what {app} can access").replace("{app}", name)}</h1>
          <p className="muted auth-sub">{t("Give {app} everything, whole workspaces, or only the projects you select.").replace("{app}", name)}</p>
          {/* the labels depend on how many workspaces there are: keep the form hidden until that is known, so nothing changes under the cursor */}
          <form className="auth-fields" onSubmit={continueWithWorkspace} style={{ visibility: ready ? "visible" : "hidden" }}>
            <div className="consent-list" role="radiogroup">
              <label className={`consent-ws${access === "all" ? " on" : ""}`}>
                <input type="radio" name="acc" checked={access === "all"} onChange={() => setAccess("all")} />
                <span className="consent-ws-n">{t("All workspaces")}<small className="muted">{t("Every project, including workspaces you join later")}</small></span>
              </label>
              <label className={`consent-ws${access === "workspaces" ? " on" : ""}`}>
                <input type="radio" name="acc" checked={access === "workspaces"} onChange={() => setAccess("workspaces")} />
                <span className="consent-ws-n">{many ? t("Selected workspaces") : t("All projects")}<small className="muted">{many ? t("Every project in the workspaces you tick below") : t("Including projects created later")}</small></span>
              </label>
              <label className={`consent-ws${access === "projects" ? " on" : ""}`}>
                <input type="radio" name="acc" checked={access === "projects"} onChange={() => setAccess("projects")} />
                <span className="consent-ws-n">{t("Selected projects")}<small className="muted">{t("Only the ones you tick below")}</small></span>
              </label>
            </div>
            {access === "workspaces" && many && (
              <div className="consent-list consent-sub">
                {spaces.map((w) => (
                  <label key={w.id} className={`consent-ws${chosenWs.includes(w.id) ? " on" : ""}`}>
                    <input type="checkbox" checked={chosenWs.includes(w.id)} onChange={() => toggleWs(w.id)} />
                    <span className="consent-ws-n">{w.name}<small className="muted">{w.projects.length} {t("projects")}</small></span>
                  </label>
                ))}
              </div>
            )}
            {access === "projects" && (
              <div className="consent-groups consent-sub">
                {spaces.map((w) => (
                  <div key={w.id} className="consent-list">
                    {many && <p className="consent-k">{w.name}</p>}
                    {w.projects.map((p) => (
                      <label key={p.id} className={`consent-ws${chosen.includes(p.id) ? " on" : ""}`}>
                        <input type="checkbox" checked={chosen.includes(p.id)} onChange={() => toggle(p.id)} />
                        <span className="consent-ws-n">{p.name}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {error && <p className="err">{error}</p>}
            <button className="btn primary full" disabled={busy || !ready || !value}>{t("Continue")}</button>
          </form>
        </>
      ) : (
        <>
          <div className="consent-app">
            <span className="consent-ic" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
            <div className="consent-who">
              <b>{name}</b>
              {client?.uri && <small className="faint mono">{client.uri}</small>}
            </div>
          </div>
          <h1 className="serif consent-h">{t("Authorize {app}").replace("{app}", name)}</h1>
          <p className="muted auth-sub">{t("{app} is asking to manage your OpenUptime workspace on your behalf. It will be able to:").replace("{app}", name)}</p>
          {grant && (
            <ul className="consent-where muted">
              {grant === "all"
                ? <li>{t("All workspaces")} · {t("All projects")}</li>
                : grant.map((g) => {
                    const w = spaces.find((x) => x.id === g.org);
                    if (!w) return null;
                    const names = g.ids ? w.projects.filter((p) => g.ids!.includes(p.id)).map((p) => p.name).join(", ") : t("All projects");
                    return <li key={g.org}><b>{w.name}</b> · {names}</li>;
                  })}
            </ul>
          )}
          <ul className="consent-list">
            {scopes.map((s) => (
              <li key={s} className="consent-scope"><span className="show-tick">✓</span><span>{t(SCOPE_TEXT[s] ?? s)}</span></li>
            ))}
          </ul>
          {error && <p className="err">{error}</p>}
          <div className="consent-actions">
            <button className="btn primary full" disabled={busy || !ready} onClick={() => decide(true)}>{t("Allow")}</button>
            <button className="btn full" disabled={busy || !ready} onClick={() => decide(false)}>{t("Deny")}</button>
          </div>
          <p className="faint consent-foot">{t("You can revoke access at any time from your account settings.")}</p>
        </>
      )}
    </AuthShell>
  );
}
