import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, for the guard tests that compare files across packages. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

export const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** Every file under `dir` (relative to the root) whose name passes `keep`, skipping build output and dependencies. */
export function walk(dir: string, keep: (file: string) => boolean = () => true): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    if (["node_modules", "dist", ".astro", ".wrangler", ".vercel"].includes(name)) continue;
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel, keep));
    else if (keep(rel)) out.push(relative(".", rel));
  }
  return out;
}
