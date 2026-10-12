import { useEffect, useState, type ReactNode } from "react";
import { t } from "../lib/i18n";
import TopBar from "./TopBar";

const dot = (
  <span className="auth-mk"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l2.5-6 4 12 2.5-6H21" /></svg></span>
);

/** Split-screen frame shared by login / signup / forgot / reset (design boards Login, Signup, Forgot). */
export function AuthShell({ side, children }: { side: "login" | "signup"; children: ReactNode }) {
  return (
    <div className="auth2">
      <div className="auth-l">
        <header className="auth-top">
          <a href="/" className="auth-brand">{dot}<b>OpenUptime</b></a>
          <div className="auth-tools"><TopBar /></div>
        </header>
        <div className="auth-form">{children}</div>
        <p className="legal faint">{t("Open source · MIT licensed.")}</p>
      </div>
      <aside className="auth-r" aria-hidden="true">
        {side === "login" ? <LoginShowcase /> : <SignupShowcase />}
      </aside>
    </div>
  );
}

function LoginShowcase() {
  const rows: [string, string, string][] = [["api.example.com", "99.98%", "up"], ["checkout.example.com", "100%", "up"], ["status.example.com", "99.91%", "up"]];
  return (
    <div className="show">
      <p className="show-k mono faint">{t("EXAMPLE STATUS PAGE")}</p>
      <div className="show-card">
        <div className="show-h"><i className="show-dot" /><b>{t("All systems operational")}</b></div>
        {rows.map(([n, u]) => (
          <div className="show-row" key={n}>
            <span className="mono">{n}</span>
            <span className="show-bars">{Array.from({ length: 30 }, (_, i) => <i key={i} className={i === 11 && n.startsWith("status") ? "w" : ""} />)}</span>
            <span className="mono">{u}</span>
          </div>
        ))}
      </div>
      <h2 className="serif show-t">{t("Know first. Fix fast.")}</h2>
      <p className="muted show-s">{t("Uptime checks, incidents and a public status page, all in one place.")}</p>
    </div>
  );
}

function SignupShowcase() {
  // the deployment's own origin, resolved after mount so server and client markup agree
  const [origin, setOrigin] = useState("https://your-domain");
  useEffect(() => setOrigin(location.origin), []);
  const items: [string, string][] = [
    [t("HTTP, TCP, DNS and heartbeat checks"), t("Monitor sites, ports, records and cron jobs.")],
    [t("Alerts where you already are"), t("Email, Slack, Telegram, PagerDuty and webhooks.")],
    [t("Public status pages"), t("Share live status and incident updates with your users.")],
    [t("Open source"), t("Self-host it for free on Cloudflare or Docker.")],
  ];
  return (
    <div className="show">
      <h2 className="serif show-t">{t("Everything you need to stay up.")}</h2>
      <ul className="show-list">
        {items.map(([a, b]) => (
          <li key={a}><span className="show-tick">✓</span><div><b>{a}</b><small className="muted">{b}</small></div></li>
        ))}
      </ul>
      <pre className="show-code mono">{`curl ${origin}/api/heartbeat/<token>`}</pre>
    </div>
  );
}
