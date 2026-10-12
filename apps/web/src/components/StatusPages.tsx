import { navigate } from "../lib/nav";
import { t } from "../lib/i18n";
import { useEffect, useState } from "react";
import { api, type Monitor, type StatusPage, type Subscriber } from "../lib/api";

export default function StatusPages() {
  const [pages, setPages] = useState<StatusPage[] | null>(null);
  const [open, setOpen] = useState(false);
  const load = () => api.statusPages().then(setPages);
  useEffect(() => { load(); }, []);
  return (
    <>
      <div className="ph">
        <div><h1>{t("Status pages")}</h1><p className="muted">{t("Public pages your customers can check before they email you.")}</p></div>
        <button className="btn primary" onClick={() => setOpen(true)}>{t("+ New status page")}</button>
      </div>
      {pages === null && <p className="muted">{t("Loading…")}</p>}
      {pages?.length === 0 ? (
        <div className="empty"><h3 style={{ fontSize: 28 }}>{t("No status pages")}</h3><p className="muted" style={{ margin: "6px 0 20px" }}>{t("Publish one in a minute.")}</p>
          <button className="btn primary" onClick={() => setOpen(true)}>{t("+ Create a status page")}</button></div>
      ) : (
        <div className="sp-grid">
          {pages?.map((p) => (
            <div className="card sp-card" key={p.id}>
              <div className="sp-h">
                <h3>{p.title}</h3>
                <span className="chip">{t(p.theme === "auto" ? "Auto" : p.theme === "dark" ? "Dark" : "Light")}</span>
              </div>
              <a className="mono sp-url" href={`/status/${p.slug}`} target="_blank">/status/{p.slug} ↗</a>
              <p className="faint" style={{ fontSize: 13 }}>{p.monitorIds?.length ?? 0} {t("components")}</p>
              <div className="sp-f">
                <a className="btn sm" href={`/app/status-pages/${p.id}`}>{t("Edit")}</a>
                <a className="btn sm" href={`/status/${p.slug}`} target="_blank">{t("Open page")}</a>
              </div>
            </div>
          ))}
        </div>
      )}
      {open && <Create onClose={() => setOpen(false)} />}
    </>
  );
}

function Create({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const p = await api.createStatusPage({ title, slug, monitorIds: [] });
      navigate(`/app/status-pages/${p.id}`);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <div className="modal" onClick={onClose}>
      <form className="card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 style={{ fontSize: 30 }}>{t("New status page")}</h2>
        <label className="fld">{t("Title")}<input className="in" required autoFocus value={title} onChange={(e) => { setTitle(e.target.value); if (!slug) setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")); }} placeholder={t("Acme Status")} /></label>
        <label className="fld">{t("Slug")}<input className="in mono" required pattern="[a-z0-9-]{3,40}" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={t("acme")} /></label>
        {err && <p className="err">{err}</p>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>{t("Cancel")}</button><button className="btn primary" disabled={busy}>{busy ? t("Creating…") : t("Create")}</button>
        </div>
      </form>
    </div>
  );
}

type Comp = { monitorId: string; groupName: string };
const DEFAULT_GROUP = "Services";
const heading = (o: string) => ({ operational: "Everything is running smoothly.", degraded: "Some systems are degraded.", outage: "We’re experiencing an outage." }[o] ?? "");

export function StatusPageEditor({ id }: { id: string }) {
  const [page, setPage] = useState<StatusPage | null>(null);
  const [comps, setComps] = useState<Comp[]>([]);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState("");
  const [err, setErr] = useState("");
  const [upgrade, setUpgrade] = useState<string | undefined>();
  useEffect(() => {
    api.statusPage(id).then((p) => {
      setPage(p);
      setComps((p.components ?? (p.monitorIds ?? []).map((monitorId) => ({ monitorId, groupName: null }))).map((c) => ({ monitorId: c.monitorId, groupName: c.groupName || DEFAULT_GROUP })));
    });
    api.monitors().then(setMonitors);
  }, [id]);
  if (!page) return <p className="muted">{t("Loading…")}</p>;
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const shown = comps.filter((c) => byId.has(c.monitorId));
  const free = monitors.filter((m) => !comps.some((c) => c.monitorId === m.id));
  const move = (i: number, d: number) => {
    const n = [...comps];
    const j = i + d;
    if (j < 0 || j >= n.length) return;
    [n[i], n[j]] = [n[j], n[i]];
    setComps(n);
  };
  const groups = [...new Set(shown.map((c) => c.groupName))];
  const overall = shown.some((c) => byId.get(c.monitorId)!.status === "down") ? "outage" : shown.some((c) => byId.get(c.monitorId)!.status === "degraded") ? "degraded" : "operational";
  async function save() {
    setPending("save");
    setErr("");
    try {
      await api.updateStatusPage(id, { title: page!.title, theme: page!.theme, showLatency: page!.showLatency, externalUrl: (page!.externalUrl ?? "").trim(), hideBranding: !!page!.hideBranding, components: comps } as Partial<StatusPage>);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      const x = e as Error & { code?: string; upgradeUrl?: string };
      setErr(x.code === "branding_not_allowed" ? t("Your plan cannot hide the OpenUptime branding.") : x.message);
      setUpgrade(x.code ? x.upgradeUrl : undefined);
    }
    setPending("");
  }
  return (
    <>
      <p className="crumb-back"><a href="/app/status-pages" className="muted">{t("← Status pages")}</a></p>
      <div className="ph">
        <div style={{ minWidth: 0 }}>
          <h1 className="ph-title">{page.title}</h1>
          <p className="ph-sub mono"><a style={{ color: "var(--accent)" }} href={`/status/${page.slug}`} target="_blank">/status/{page.slug} ↗</a></p>
        </div>
        <div className="ph-actions">
          <button className="btn danger-l" disabled={!!pending} onClick={async () => {
            if (!confirm(t("Delete this status page?"))) return;
            setPending("delete");
            try { await api.deleteStatusPage(id); navigate("/app/status-pages"); } catch (e) { setErr((e as Error).message); setPending(""); }
          }}>{pending === "delete" ? t("Deleting…") : t("Delete")}</button>
          <button className="btn primary" disabled={!!pending} onClick={save}>{pending === "save" ? t("Saving…") : saved ? t("Saved ✓") : t("Save")}</button>
        </div>
      </div>
      {err && <p className="err">{err}{upgrade && <> <a href={upgrade}>{t("Upgrade")}</a></>}</p>}
      <div className="cols">
        <div className="col">
          <div className="card cc">
            <div className="cc-h"><h3>{t("Branding")}</h3></div>
            <label className="fld">{t("Title")}<input className="in" value={page.title} onChange={(e) => setPage({ ...page, title: e.target.value })} /></label>
            <div className="fld">{t("Slug")}<div className="in mono faint ro">/status/{page.slug}</div></div>
            <div className="fld">{t("Theme")}
              <div className="seg">
                {(["light", "dark", "auto"] as const).map((th) => (
                  <i key={th} className={page.theme === th ? "on" : ""} onClick={() => setPage({ ...page, theme: th })}>{t(th === "auto" ? "Auto" : th === "dark" ? "Dark" : "Light")}</i>
                ))}
              </div>
            </div>
            <label className="fld">{t("Website link (optional)")}<input className="in" type="url" inputMode="url" placeholder="https://example.com" maxLength={2048} value={page.externalUrl ?? ""} onChange={(e) => setPage({ ...page, externalUrl: e.target.value })} /><small className="faint">{t("Shows an external-link icon next to the title that opens this address.")}</small></label>
            <button type="button" className="route tog" onClick={() => setPage({ ...page, showLatency: !page.showLatency })}>
              <div><b style={{ fontWeight: 500 }}>{t("Show response times")}</b><small>{t("Display latency next to each component")}</small></div>
              <span className={`tg ${page.showLatency ? "on" : ""}`} />
            </button>
            {/* a page that already hides the brand keeps the flag after a downgrade; the toggle stays usable to turn it off */}
            <button type="button" className="route tog" disabled={page.branding?.allowed === false && !page.hideBranding} onClick={() => setPage({ ...page, hideBranding: !page.hideBranding })}>
              <div><b style={{ fontWeight: 500 }}>{t("Hide OpenUptime branding")}</b><small>{t("Remove the OpenUptime mark and “Powered by” line. The header shows the logo of your website link instead.")}</small></div>
              <span className={`tg ${page.hideBranding ? "on" : ""}`} />
            </button>
            {page.branding?.allowed === false && (
              <p className="faint" style={{ fontSize: 13, margin: 0 }}>
                {page.hideBranding ? t("Your plan no longer includes this, so OpenUptime branding is shown again.") : t("Not included in your plan.")}
                {page.branding.upgradeUrl && <> <a href={page.branding.upgradeUrl}>{t("Upgrade")}</a></>}
              </p>
            )}
          </div>

          <div className="card cc">
            <div className="cc-h"><h3>{t("Components")}</h3><span className="faint" style={{ fontSize: 13 }}>{shown.length}</span></div>
            {shown.length === 0 && <p className="muted">{t("No components yet. Add a monitor below.")}</p>}
            {comps.map((c, i) => {
              const m = byId.get(c.monitorId);
              if (!m) return null;
              return (
                <div className="comp-r" key={c.monitorId}>
                  <span className={`dot ${m.status === "up" ? "up" : m.status === "degraded" ? "warn" : "down"}`} />
                  <span className="comp-n">{m.name}</span>
                  <input className="in comp-g" aria-label={t("Group")} value={c.groupName} placeholder={t("Group")} onChange={(e) => setComps(comps.map((x, k) => (k === i ? { ...x, groupName: e.target.value } : x)))} />
                  <span className="comp-a">
                    <button type="button" className="btn sm" aria-label="Up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                    <button type="button" className="btn sm" aria-label="Down" disabled={i === comps.length - 1} onClick={() => move(i, 1)}>↓</button>
                    <button type="button" className="btn sm" aria-label={t("Remove")} onClick={() => setComps(comps.filter((_, k) => k !== i))}>✕</button>
                  </span>
                </div>
              );
            })}
            {free.length > 0 && (
              <div className="comp-add">
                <small className="faint">{t("Add a monitor")}</small>
                <div className="chips">
                  {free.map((m) => (
                    <button type="button" key={m.id} className="chip add" onClick={() => setComps([...comps, { monitorId: m.id, groupName: comps[comps.length - 1]?.groupName ?? DEFAULT_GROUP }])}>+ {m.name}</button>
                  ))}
                </div>
              </div>
            )}
            {monitors.length === 0 && <p className="muted">{t("Create a monitor first.")}</p>}
          </div>

          <Embed slug={page.slug} />
          <Subscribers pageId={id} />
        </div>

        <div className="col">
          <div className="card cc prev">
            <div className="cc-h"><h3>{t("Live preview")}</h3><a className="btn sm" href={`/status/${page.slug}`} target="_blank">{t("Open page")}</a></div>
            <div className="prev-b">
              <span className={`pill ${overall === "outage" ? "down" : overall === "degraded" ? "degraded" : "up"}`}>{overall === "operational" ? t("All systems operational") : t(overall)}</span>
              <h2 className="prev-h">{t(heading(overall))}</h2>
              {groups.map((g) => (
                <div key={g}>
                  <div className="prev-g">{g}</div>
                  {shown.filter((c) => c.groupName === g).map((c) => {
                    const m = byId.get(c.monitorId)!;
                    return (
                      <div className="prev-r" key={c.monitorId}>
                        <span className={`dot ${m.status === "up" ? "up" : m.status === "degraded" ? "warn" : "down"}`} />
                        <span className="prev-n">{m.name}</span>
                        {page.showLatency && m.avgLatency24h != null && <span className="mono faint">{Math.round(m.avgLatency24h)} ms</span>}
                        <span className="mono">{m.uptime24h != null ? `${m.uptime24h.toFixed(2)}%` : "—"}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
              {shown.length === 0 && <p className="faint" style={{ fontSize: 13 }}>{t("Nothing to show yet.")}</p>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Subscribers({ pageId }: { pageId: string }) {
  const [subs, setSubs] = useState<Subscriber[] | null>(null);
  const [removing, setRemoving] = useState("");
  const load = () => api.subscribers(pageId).then(setSubs);
  useEffect(() => { load(); }, [pageId]);
  if (!subs) return null;
  return (
    <div className="card cc">
      <div className="cc-h"><h3>{t("Subscribers")}</h3><span className="faint" style={{ fontSize: 13 }}>{subs.length}</span></div>
      {subs.length === 0 && <p className="muted" style={{ marginTop: 8 }}>{t("No subscribers yet.")}</p>}
      {subs.map((s) => (
        <div key={s.id} className="route sub-r">
          <span className="mono" style={{ flex: 1, minWidth: 0, wordBreak: "break-all" }}>{s.email}</span>
          <span className={`pill ${s.confirmedAt ? "up" : "pending"}`}>{s.confirmedAt ? t("Confirmed") : t("Pending")}</span>
          <button className="btn sm" disabled={removing === s.id} onClick={async () => {
            setRemoving(s.id);
            try { await api.deleteSubscriber(pageId, s.id); await load(); } finally { setRemoving(""); }
          }}>{removing === s.id ? t("Removing…") : t("Remove")}</button>
        </div>
      ))}
    </div>
  );
}

/** Copy-paste snippets for showing this page's state on another site. */
function Embed({ slug }: { slug: string }) {
  const origin = typeof location === "undefined" ? "" : location.origin;
  const [copied, setCopied] = useState("");
  const items = [
    { k: "badge", label: t("Badge"), code: `<script src="${origin}/embed.js" data-slug="${slug}" async></script>\n<noscript><a href="${origin}/status/${slug}">System status</a></noscript>` },
    { k: "banner", label: t("Banner (only during incidents)"), code: `<script src="${origin}/embed.js" data-slug="${slug}" data-mode="banner" async></script>` },
    { k: "img", label: t("Image (README, email)"), code: `<img src="${origin}/api/public/status/${slug}/badge.svg" alt="status">` },
  ];
  return (
    <div className="card cc">
      <div className="cc-h"><h3>{t("Embed")}</h3><a className="btn sm" href="/docs/embed" target="_blank">{t("Docs")}</a></div>
      <p className="muted" style={{ marginBottom: 12 }}>{t("Show this page's live state on your own site or README.")}</p>
      {items.map((i) => (
        <div key={i.k} style={{ marginBottom: 12 }}>
          <div className="faint" style={{ fontSize: 13, marginBottom: 4 }}>{i.label}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <code className="mono" style={{ flex: 1, minWidth: 0, wordBreak: "break-all", whiteSpace: "pre-wrap", fontSize: 12, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8 }}>{i.code}</code>
            <button type="button" className="btn sm" onClick={async () => {
              try { await navigator.clipboard.writeText(i.code); setCopied(i.k); setTimeout(() => setCopied(""), 1500); } catch {}
            }}>{copied === i.k ? t("Copied") : t("Copy")}</button>
          </div>
        </div>
      ))}
    </div>
  );
}
