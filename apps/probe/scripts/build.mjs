// Builds a Vercel "prebuilt" deployment (Build Output API v3): one function per region, each pinned to a single Vercel
// region, all served under /api/probe/<region id>. Deploy it with `vercel deploy --prebuilt --prod`.
//
//   node scripts/build.mjs                       every region in regions.json
//   PROBE_BUILD_REGIONS=us-east,eu-central node scripts/build.mjs
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".vercel", "output");
const all = JSON.parse(await readFile(join(root, "regions.json"), "utf8"));
const wanted = (process.env.PROBE_BUILD_REGIONS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ids = wanted.length ? wanted : Object.keys(all);
const unknown = ids.filter((id) => !all[id]);
if (unknown.length) {
  console.error(`Unknown region id: ${unknown.join(", ")}. Known: ${Object.keys(all).join(", ")} (edit regions.json to add one).`);
  process.exit(1);
}

await rm(out, { recursive: true, force: true });
const bundle = join(root, ".vercel", "bundle");
await rm(bundle, { recursive: true, force: true });
await mkdir(bundle, { recursive: true });
await build({
  entryPoints: [join(root, "src/vercel.ts")],
  outfile: join(bundle, "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
});

for (const id of ids) {
  const dir = join(out, "functions", "api", "probe", `${id}.func`);
  await mkdir(dir, { recursive: true });
  await cp(join(bundle, "index.mjs"), join(dir, "index.mjs"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    join(dir, ".vc-config.json"),
    JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, regions: [all[id]], maxDuration: 60 }, null, 2),
  );
  console.log(`  /api/probe/${id}  ->  ${all[id]}`);
}
await writeFile(join(out, "config.json"), JSON.stringify({ version: 3 }, null, 2));
console.log(`Built ${ids.length} probe function${ids.length === 1 ? "" : "s"} into ${out}`);
