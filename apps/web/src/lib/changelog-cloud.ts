import type { ChangelogEntry } from "./changelog";

/**
 * Changes that exist only in the hosted edition (the `cloud` branch). The community edition has none, so this stays
 * empty on `main`; the hosted branch fills it, and the page shows the edition filter only when it has entries.
 */
export const CLOUD_ENTRIES: ChangelogEntry[] = [];
