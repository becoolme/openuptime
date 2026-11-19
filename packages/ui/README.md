# @openuptime/ui

Design tokens, base styles and React components shared by OpenUptime and OpenCron.

- `theme.css`: colours, radius and fonts, light and dark. Override brand tokens (`--accent`) after importing it.
- `base.css`: reset, type, `.btn`, `.card`, `.fld`, `.in`, `.pill`, the dropdown, toasts and skeletons.
- `select`, `toaster` + `toast`, `skeleton`, `use-busy`: React components and hooks that use those classes.

Rules: no product names, routes, API calls or `t()` in here (pass text in as props); React is a peer dependency;
every literal colour token needs a dark value (`theme.test.ts` checks it). OpenCron vendors this package with
`pnpm sync:openuptime` and never edits its copy.
