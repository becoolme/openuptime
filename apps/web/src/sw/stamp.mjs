// Build-time half of the service worker: decides what is precached and turns src/sw/sw.js into the /sw.js that ships.
// Plain ESM so astro.config.mjs and the tests can both import it.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The page every back-office URL is answered with (the static, data-free shell). */
export const SHELL = "/app";
/** A runaway asset list should fail the build, not silently make every install download megabytes. */
export const MAX_PRECACHE_BYTES = 5 * 1024 * 1024;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

/**
 * Paths to precache for a finished client build, and an id for them.
 * Only the build's own hashed files under /_astro and the shell page: never anything dynamic, never /api.
 * The id is a hash of their content, so it changes exactly when a deploy would change what the app loads.
 */
export function listPrecache(clientDir) {
  const assetsDir = join(clientDir, "_astro");
  const shellFile = join(clientDir, "app.html");
  if (!existsSync(shellFile) || !existsSync(assetsDir)) throw new Error(`service worker: no shell or _astro in ${clientDir}`);
  const assets = walk(assetsDir)
    .filter((f) => !f.endsWith(".map"))
    .map((f) => ({ url: "/" + relative(clientDir, f).split(sep).join("/"), file: f }))
    .sort((a, b) => (a.url < b.url ? -1 : 1));
  const all = [{ url: SHELL, file: shellFile }, ...assets];
  const size = all.reduce((n, f) => n + statSync(f.file).size, 0);
  if (size > MAX_PRECACHE_BYTES) throw new Error(`service worker: precache is ${size} bytes, over the ${MAX_PRECACHE_BYTES} cap`);
  const h = createHash("sha256");
  for (const f of all) h.update(f.url).update("\0").update(readFileSync(f.file)).update("\0");
  return { files: all.map((f) => f.url), version: h.digest("hex").slice(0, 12), size };
}

/** Fills the placeholders in the worker source. Throws if the template no longer has them (it would ship unstamped). */
export function stampWorker(template, { version, files }) {
  if (!template.includes('"__BUILD_ID__"') || !template.includes('"__PRECACHE__"')) throw new Error("service worker: template placeholders missing");
  return template.replace('"__BUILD_ID__"', JSON.stringify(version)).replace('"__PRECACHE__"', JSON.stringify(files));
}
