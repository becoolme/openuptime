import { execFileSync } from "node:child_process";
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
 * pull requests. Locally, a branch is hosted when its name starts with `cloud`, it tracks a cloud remote or branch, or
 * its history contains a cloud ref. A nested name such as `feature/cloudflare-timeouts` is not cloud, and neither is a
 * Community branch that accidentally adds a hosted file, so those are still checked. `OPENUPTIME_HOSTED=1` opts out.
 */
const cloudName = /^cloud($|[-/])/;
/** A local branch name is hosted when it starts with cloud; feature/cloud-sync is not. */
const hostedBranch = (branch: string) => cloudName.test(branch);
/** A remote ref is hosted when its remote or its branch starts with cloud. */
const hostedRef = (ref: string) => {
  const slash = ref.indexOf("/");
  if (slash < 0) return hostedBranch(ref);
  return cloudName.test(ref.slice(0, slash)) || cloudName.test(ref.slice(slash + 1));
};
export const isHostedCheckout = (branch: string, upstream: string, descendsFromHosted: boolean) =>
  !/^(main|master)$/.test(branch) && (hostedBranch(branch) || hostedRef(upstream) || descendsFromHosted);

const targetBranch = () => process.env.GITHUB_BASE_REF || process.env.GITHUB_REF_NAME || "";
const localRef = (args: string[]) => {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
};
const refsOf = (namespace: string) => {
  try {
    return execFileSync("git", ["for-each-ref", "--format=%(refname:short)", namespace], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString().split("\n").map((r) => r.trim()).filter(Boolean);
  } catch {
    return [];
  }
};
/**
 * A branch cut from `cloud` has the hosted files in its history, whatever its own name looks like. Check whether a cloud
 * ref that contains a hosted path is an ancestor of HEAD, so a Community branch that merely adds such a file is not exempt,
 * and neither is a leak that cloud later merged from main.
 */
const descendsFromHosted = () => {
  const refs = [...refsOf("refs/heads").filter(hostedBranch), ...refsOf("refs/remotes").filter(hostedRef)];
  return refs.some((ref) => {
    const hasHosted = CLOUD_ONLY_PATHS.some((path) => {
      try {
        execFileSync("git", ["cat-file", "-e", `${ref}:${path}`], { cwd: ROOT, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    });
    if (!hasHosted) return false;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", ref, "HEAD"], { cwd: ROOT, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
};
const hosted = process.env.OPENUPTIME_HOSTED === "1"
  || (targetBranch() ? hostedBranch(targetBranch()) : isHostedCheckout(localRef(["HEAD"]), localRef(["@{upstream}"]), descendsFromHosted()));

describe("hosted checkout detection", () => {
  it("treats a cloud branch, a branch tracking one, or a branch descending from one as hosted", () => {
    expect(isHostedCheckout("cloud", "", false)).toBe(true);
    expect(isHostedCheckout("cloud-private/traditional-chinese", "", false)).toBe(true);
    expect(isHostedCheckout("traditional-chinese", "cloud-private/traditional-chinese", false)).toBe(true);
    expect(isHostedCheckout("traditional-chinese", "origin/traditional-chinese", true)).toBe(true);
  });

  it("still checks a community branch, including cloud-like nested names", () => {
    expect(isHostedCheckout("fix-webhooks", "origin/fix-webhooks", false)).toBe(false);
    expect(isHostedCheckout("feature/cloudflare-timeouts", "origin/feature/cloudflare-timeouts", false)).toBe(false);
    expect(isHostedCheckout("feature/cloud-sync", "origin/feature/cloud-sync", false)).toBe(false);
    expect(isHostedCheckout("main", "origin/main", false)).toBe(false);
    expect(isHostedCheckout("main", "", true)).toBe(false);
    expect(isHostedCheckout("master", "origin/master", true)).toBe(false);
    expect(isHostedCheckout("fix-webhooks", "origin/cloud", false)).toBe(true);
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
