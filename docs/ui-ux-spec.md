# OpenUptime UI/UX specification

The source of truth for how the product looks and behaves. Design boards live in the design artifact; this document records the rules they follow so new pages don't drift. Implementation: `apps/web/src/styles/global.css` (tokens + shared classes) and `apps/web/src/components/*`.

## 1. Principles

1. **Calm, then loud.** Operational state is quiet (neutral surfaces, one green accent). Red appears only when something needs action.
2. **Real data only.** Never ship decorative claims (fake testimonials, customer counts, regions we don't run, login providers that aren't configured). If the backend can't do it, the UI doesn't show it.
3. **One job per screen.** Page header → primary action top-right → content cards. Secondary actions live inside cards.
4. **Same thing, same look.** Status is always a `.pill`, a list is always `.tbl`, a form is always `.fld`/`.in`, a confirmation is always a `.modal`.
5. **Mobile is a layout, not a shrink.** Tables become cards, sidebar becomes a drawer + bottom tabs.

## 2. Design tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #fafaf7 | #0a0c0b | page background |
| `--surface` | #ffffff | #111413 | cards, inputs, modals |
| `--surface-2` | #f4f4ee | #171b19 | table headers, segmented bg, hover |
| `--line` / `--line-2` | #e7e7df / — | #222826 / #2d3431 | borders, dividers |
| `--ink` | #0e1411 | #f1f4f2 | primary text, primary button bg |
| `--muted` / `--faint` | — | — | secondary / tertiary text |
| `--accent` | #0f9d58 | #3ddc84 | up, active nav, links, focus |
| `--warn` | #c98a0a | #f5b942 | degraded, maintenance |
| `--down` | #d93a3a | #ff5c5c | down, destructive |

Rules: never hard-code a colour in a component — use a token so dark mode works. Dark follows `prefers-color-scheme` unless the user toggled (`localStorage ou_theme`, `data-theme` on `<html>`).

## 3. Typography

- **Geist** — UI text (14–15px body, 500 for labels/titles).
- **Geist Mono** — numbers, URLs, IDs, timestamps, chips, table headers (uppercase 11px, letter-spacing .08em).
- **Instrument Serif** — page titles (h1 ≈ 38–42px), card titles (`h3` ≈ 22px), empty-state titles, public status headline. Never for body.
- Numbers in KPI cards: mono 28–34px with a muted unit (`<u>`).

## 4. Spacing, radius, elevation

- 4px base grid; card padding 20–24px; gap between cards 16px; page padding 40px desktop / 16px mobile.
- Radii: card 16, button 12, input 11 (height 46), pill/chip 999 / 8, modal 20.
- No drop shadows except modals and menus; separation is by 1px `--line`.

## 5. Components

| Component | Class | Notes |
|---|---|---|
| Button | `.btn` (+`.primary` ink fill, `.sm`, `.danger-l`) | busy state: label changes ("Saving…") and `disabled`. One primary per view. |
| Status pill | `.pill.up/.down/.degraded/.pending/.resolved` | dot + lowercase label, translated. |
| Chip | `.chip` | mono, neutral: type (HTTP/TCP/CRON), interval. |
| KPI card | `.kp > .card` | `small` label, `b` value, `.d` delta line (`.bad` red). |
| Card | `.card` / `.cc` + `.cc-h` | header row: serif h3 left, action right. |
| Key-value | `.kv` | label left muted, value right mono. |
| Table | `.tbl .th .tr` | grid columns; < 900px rows collapse to stacked cards. |
| Segmented | `.seg` > `i.on` | 2–4 mutually exclusive options (interval, theme). |
| Toggle | `.tg(.on)` | instant setting; always labelled. |
| Route row | `.route` | icon + title/sub + toggle or pill; used for channels, incidents. |
| Type grid | `.type-grid .type-c` | choose among 2–6 big options (monitor type, channel type). |
| Form field | `.fld` + `.in` | label above, hint below in `--faint`, error `.err`. |
| Modal | `.modal` | desktop: centred, max 520px; mobile: bottom sheet. Esc/backdrop closes. |
| Empty state | `.empty` | serif title, one sentence, one primary action. |
| Steps | `.step`, `.onb-step` | numbered circle; done = accent fill + ✓. |
| Avatar | `.av` | initial letter, ink bg. |
| Sidebar badge | `.nav .n` | count; incidents red when > 0, others muted mono. |

## 6. Layout & shell

- **Desktop ≥ 1024px**: 240px sidebar (logo, workspace/project switcher, nav, account), top bar (breadcrumb title, locale, theme), content max-width ≈ 960–1200.
- **Tablet 900–1023px**: sidebar remains; two-column `.cols` collapses to one.
- **Mobile < 900px**: sidebar → drawer (hamburger), bottom tab bar (Monitors, Incidents, Status pages, Alerting, More). Tables → cards, KPI grid 2×2, modals → bottom sheets.
- Grid children must set `min-width: 0` so long URLs never force horizontal scroll. Check every new page with `ovf.mjs` at 375px.

## 7. Pages (board → rule)

| Page | Must contain |
|---|---|
| Monitors | KPI row, incident banner, filter tabs + search (⌘K), table; empty state = onboarding checklist (workspace · monitor · channel · status page). |
| Monitor detail | title + status pill, chips, actions (Edit / Pause / Check now); KPIs; response chart; recent checks; config, alert routing, incidents. |
| Incidents | list with status filter, "Declare incident"; detail has timeline + post-update form. |
| Status pages | card grid; editor = Branding, Components (groups, order), Subscribers, live preview. Public page shows real data only. |
| Alerting | channel list with test/enable/delete; add-channel modal (type grid → config); "How alerts are sent" explainer. |
| Team / API keys | table + invite/create modal; a new key is shown **once** with a copy button. |
| Settings | General (name), Account (read-only), Runtime. Danger actions at the bottom. |
| Auth | split layout: form left, brand panel right (no fabricated proof). GitHub button only when `/api/auth-providers` says so. Password minimum 8. |

## 8. Interaction

- Data refreshes by polling (10–15s); optimistic UI is not used — buttons show a busy label until the server answers.
- Destructive actions: native confirm (or typed modal for workspace-level), copy states the consequence.
- Navigation is full-page (Astro) with React islands; keep scroll position by not remounting shells.
- Keyboard: ⌘/Ctrl+K focuses search, Esc closes modals, Enter submits forms, focus ring = 2px accent.

## 9. Content & i18n

- English string is the key; all user-facing text goes through `t()`; add the zh-CN entry in `apps/web/src/lib/zh.ts` in the same change.
- Sentence case, no trailing full stop on buttons/labels, ellipsis `…` for in-progress.
- Times are rendered in the viewer's locale; public status page uses UTC explicitly.
- Locale cookie `ou_lang`, theme `ou_theme`.

## 10. Accessibility

- Text contrast ≥ 4.5:1 in both themes; status never conveyed by colour alone (pill has label).
- All icon-only buttons have `aria-label`; modals trap focus and restore it on close.
- Touch targets ≥ 40px on mobile.

## 11. Definition of done for a page

1. Matches the board's structure (or the deviation is listed in `docs/ui-alignment-checklist.md` with the reason).
2. Light + dark checked; desktop + 375px checked (no horizontal overflow).
3. zh-CN strings added; `astro check` clean.
4. No fabricated claims; unsupported features omitted, not faked.
