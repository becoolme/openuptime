// Builds the one-click-deploy bundle for OpenFlare into dist-release/:
//   api.mjs, web.mjs, web-assets.zip, openflare.json
// Upload that directory to any static host (GitHub release assets, R2, …) and give OpenFlare the URL of openflare.json.
// Relative bundle URLs in the manifest resolve next to it.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-release");
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

run("node", ["scripts/gen-migrations.mjs"], root);

// API: wrangler bundles to a single ES module
const apiOut = join(out, ".api");
run("npx", ["wrangler", "deploy", "--dry-run", "--outdir", apiOut], join(root, "apps/api"));
cpSync(join(apiOut, "worker.js"), join(out, "api.mjs"));
rmSync(apiOut, { recursive: true, force: true });

// Web: Astro's server output is multi-module; fold it into one file. Static files go into a zip.
const web = join(root, "apps/web");
run("pnpm", ["build"], web);
const esbuild = findEsbuild(root);
run(esbuild, [
  "dist/server/entry.mjs", "--bundle", "--format=esm", "--platform=neutral", "--main-fields=module,main",
  "--conditions=workerd,worker,browser", "--external:cloudflare:*", "--external:node:*", `--outfile=${join(out, "web.mjs")}`,
], web);
run("zip", ["-qr", join(out, "web-assets.zip"), "."], join(web, "dist/client"));

cpSync(join(root, "deploy/openflare.json"), join(out, "openflare.json"));
for (const f of readdirSync(out)) console.log(f.padEnd(20), (statSync(join(out, f)).size / 1024).toFixed(0) + " KB");

function findEsbuild(dir) {
  const pnpm = join(dir, "node_modules/.pnpm");
  const hit = readdirSync(pnpm).filter((d) => /^esbuild@\d/.test(d)).sort().pop();
  const bin = hit && join(pnpm, hit, "node_modules/esbuild/bin/esbuild");
  if (!bin || !existsSync(bin)) throw new Error("esbuild not found: run pnpm install");
  return bin;
}
