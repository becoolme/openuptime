import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, read } from "./helpers";

/**
 * The probe bundles API source files (checker, netguard, MCP config) through relative imports, but its Docker image
 * installs only the probe's own dependencies. A package one of those API files imports must therefore also be listed in
 * `apps/probe/package.json`, or the image fails to build.
 */

const ENTRIES = ["apps/probe/src/server.ts", "apps/probe/src/vercel.ts"];

/** Value imports and re-exports; `import type` / `export type` are erased by the bundler and are skipped. */
const specifiers = (src: string) =>
  [...src.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\bfrom\s*)?["']([^"']+)["']/gm)].map((m) => m[1]);

function resolve(from: string, spec: string): string | undefined {
  const base = normalize(join(dirname(from), spec));
  return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((p) => existsSync(join(ROOT, p)) && /\.tsx?$/.test(p));
}

function bundledPackages(): Map<string, string> {
  const seen = new Set<string>();
  const packages = new Map<string, string>();
  const queue = [...ENTRIES];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiers(read(file))) {
      if (spec.startsWith(".")) {
        const next = resolve(file, spec);
        if (next) queue.push(next);
      } else if (!spec.startsWith("node:")) {
        const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        if (!packages.has(name)) packages.set(name, file);
      }
    }
  }
  return packages;
}

describe("probe dependencies", () => {
  it("declares every package its bundle pulls in", () => {
    const pkg = JSON.parse(read("apps/probe/package.json"));
    const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));
    const missing = [...bundledPackages()].filter(([name]) => !declared.has(name)).map(([name, file]) => `${name} (imported by ${file})`);
    expect(missing).toEqual([]);
  });
});
