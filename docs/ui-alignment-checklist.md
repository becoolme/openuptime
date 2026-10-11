# UI alignment checklist (design boards → implementation)

Status: ✅ aligned · 🟡 partially · ⬜ todo · ⛔ deferred (unsupported by backend)

| Page | Board | Status | Notes |
|---|---|---|---|
| Sidebar + count badges | Dashboard | ✅ | `/api/counts` |
| Dashboard / Monitors | Dashboard | ✅ | |
| Monitor detail | Monitor | ✅ | |
| Login / Signup / Forgot / Reset | Login, Signup, Forgot | ✅ | split layout; GitHub only if configured |
| Incidents list + detail + declare | Incidents, IncidentDetail | ✅ | |
| Status pages list + editor | StatusPages | ✅ | groups, ordering, preview; ⛔ languages, custom domain |
| Public status page | Status | ✅ | real data only; ⛔ regions, p95 KPIs |
| Alerting | Alerting, Integrations | ✅ | |
| Team | Team | ✅ | |
| Settings | Settings | ✅ | |
| API keys | ApiKeys | ✅ | |
| New monitor | NewMonitor | ✅ | ⛔ SSL type, multi-region |
| Onboarding | Onboarding | ✅ | checklist on empty Monitors page; ⛔ "3 regions / 30s" copy |
| Dark-theme audit | — | ✅ | dashboard, status pages, alerting, settings, public status |
| Landing | Main | 🟡 | existing `landing/index.html`; not re-audited |

See also `docs/ui-ux-spec.md`.
