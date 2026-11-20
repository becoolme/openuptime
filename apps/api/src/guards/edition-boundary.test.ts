import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROOT, read, walk } from "./helpers";
import { join } from "node:path";

/**
 * `main` is the community edition. The hosted edition lives on the `cloud` branch, which merges `main`, never the other
 * way round. These checks stop hosted-only code from leaking into `main` (and so into the open-source Docker image).
 */

/** Paths that exist only on the hosted branch. */
const CLOUD_ONLY_PATHS = [
  "apps/api/src/cloud",
  "apps/api/src/worker.cloud.ts",
  "apps/api/wrangler.cloud.jsonc",
  "apps/web/edge",
  "apps/web/wrangler.edge.jsonc",
];

/** The one hosted-named module `main` may import: the cloud changelog list, empty here and filled on the hosted branch. */
const ALLOWED = /(^|\/)changelog-cloud$/;

const SOURCE = /\.(tsx?|mjs|astro)$/;
const specifiers = (src: string) =>
  [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)].map((m) => m[1]);
const hostedSpecifier = /(^|\/)(cloud|edge)(\/|$)|worker\.cloud|wrangler\.(cloud|edge)|changelog-cloud/;

/**
 * The hosted branch merges `main` and legitimately holds the hosted files, so these checks only apply on `main` and its
 * pull requests. A feature branch cut from `cloud` also holds those files without being named `cloud*`; treat it as hosted
 * so a local run does not report the files as a leak. `main` and `master` never get that exemption, so a real leak is still
 * caught even if the files are already there locally.
 */
export const isHostedCheckout = (branch: string, hasHostedFiles: boolean) =>
  /^cloud/.test(branch) || (!/^(main|master)$/.test(branch) && hasHostedFiles);

const targetBranch = () => process.env.GITHUB_BASE_REF || process.env.GITHUB_REF_NAME || "";
const localBranch = () => {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
};
const hosted = targetBranch()
  ? /^cloud/.test(targetBranch())
  : isHostedCheckout(localBranch(), CLOUD_ONLY_PATHS.some((p) => existsSync(join(ROOT, p))));

describe("hosted checkout detection", () => {
  it("treats a cloud branch, and a feature branch carrying hosted files, as hosted", () => {
    expect(isHostedCheckout("cloud", false)).toBe(true);
    expect(isHostedCheckout("cloud-private/traditional-chinese", true)).toBe(true);
    expect(isHostedCheckout("traditional-chinese", true)).toBe(true);
  });

  it("still checks main when hosted files leaked into it", () => {
    expect(isHostedCheckout("main", true)).toBe(false);
    expect(isHostedCheckout("main", false)).toBe(false);
    expect(isHostedCheckout("feature", false)).toBe(false);
  });
});

describe.skipIf(hosted)("community build", () => {
  it("has no hosted-only files", () => {
    expect(CLOUD_ONLY_PATHS.filter((p) => existsSync(join(ROOT, p)))).toEqual([]);
  });

  it("imports nothing from hosted-only paths", () => {
    const files = [
      ...walk("apps", (f) => SOURCE.test(f) && !f.endsWith(".test.ts")),
      ...walk("packages", (f) => SOURCE.test(f) && !f.endsWith(".test.ts")),
      ...walk("scripts"),
    ].filter((f) => !f.includes("/guards/"));
    const offenders: string[] = [];
    for (const f of files) {
      for (const spec of specifiers(read(f))) {
        if (!hostedSpecifier.test(spec)) continue;
        if (!ALLOWED.test(spec)) offenders.push(`${f} imports ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the hosted changelog list empty", () => {
    expect(read("apps/web/src/lib/changelog-cloud.ts")).toMatch(/CLOUD_ENTRIES: ChangelogEntry\[\] = \[\];/);
  });

  it("keeps the edition seam on the community edition by default", () => {
    expect(read("apps/api/src/server.ts")).toMatch(/const edition: Edition = community;/);
    expect(read("apps/api/src/worker.ts")).toMatch(/edition: Edition = community/);
  });

  it("builds the Docker image from the node entry point only", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).not.toMatch(/\bcloud\b|worker\.cloud|wrangler|web\/edge/i);
    expect(read("apps/api/package.json")).toMatch(/"build:node": "esbuild src\/server\.ts /);
  });
});
