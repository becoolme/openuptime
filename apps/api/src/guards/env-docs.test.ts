import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, read, walk } from "./helpers";

/**
 * The variables the code reads and the variables the example files, docker-compose.yml and wrangler.jsonc document
 * must stay the same set: a variable the code reads but compose does not pass does nothing for a Docker user, and a
 * documented variable nobody reads misleads.
 */

const NAME = /^[A-Z][A-Z0-9_]*$/;
const sorted = (s: Iterable<string>) => [...s].sort();
const minus = (a: Iterable<string>, ...rest: Iterable<string>[]) => {
  const drop = new Set(rest.flatMap((r) => [...r]));
  return sorted([...a].filter((x) => !drop.has(x)));
};

/** Variables the app sets or reads for its own plumbing (SITE_ORIGIN is read by the web build of a hosted deployment); never configured by an operator through compose. */
const INTERNAL = ["API_ORIGIN", "DEPLOY_TARGET", "DEV", "PROD", "SITE_ORIGIN", "VITEST", "WEB_DIST"];
/** Cloudflare bindings, not environment variables. */
const BINDINGS_ONLY = ["CHECK_QUEUE", "EMAIL", "HYPERDRIVE"];
/** Read from the environment but wired through compose itself (`ports`, the DATABASE_URL built from the Postgres password). */
const COMPOSE_WIRED = ["DATABASE_URL", "PORT"];

function codeVars(): string[] {
  const found = new Set<string>();
  // the Bindings type is the contract of the API
  const env = read("apps/api/src/env.ts");
  for (const m of env.matchAll(/^\s{2}([A-Z][A-Z0-9_]*)\??:/gm)) found.add(m[1]);
  // direct reads, in the API and the web app (tests and documentation pages excluded)
  const files = [...walk("apps/api/src", (f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts") && !f.includes("/guards/")),
    ...walk("apps/web/src", (f) => /\.(tsx?|astro)$/.test(f) && !f.endsWith(".test.ts") && !f.includes("/pages/docs/")), "apps/web/astro.config.mjs"];
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/\b(?:process\.env|env|c\.env)\.([A-Z][A-Z0-9_]*)\b/g)) found.add(m[1]);
    for (const m of src.matchAll(/\bsetting\("([A-Z][A-Z0-9_]*)"\)/g)) found.add(m[1]);
  }
  return sorted(found);
}

/** Names written as `KEY=`, active or in a comment (also in the middle of a line), the way the example files document them. */
function exampleVars(file: string): string[] {
  return sorted(new Set([...read(file).matchAll(/\b([A-Z][A-Z0-9_]{2,})=/g)].map((m) => m[1])));
}

function composeEnvironment(): string[] {
  const yml = read("docker-compose.yml");
  const block = yml.match(/^ {4}environment:\n((?: {6}.*\n|\s*\n)+)/m);
  if (!block) throw new Error("docker-compose.yml: no environment block for the app service");
  return sorted([...block[1].matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]));
}

/** Variables compose substitutes from `.env` (`${NAME:-default}`). */
const composeInputs = () => sorted(new Set([...read("docker-compose.yml").matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1])));

describe("environment variables", () => {
  const code = codeVars();
  const readByCode = minus(code, INTERNAL, BINDINGS_ONLY);

  it("finds the variables it is supposed to compare", () => {
    expect(code).toEqual(expect.arrayContaining(["BETTER_AUTH_SECRET", "PLAUSIBLE_DOMAIN", "PRODUCT_URL", "DB_POOL_MAX", "TRUST_PROXY"]));
    expect(code.every((n) => NAME.test(n))).toBe(true);
  });

  // the hosted edition reads extra variables (Cloudflare, billing, ...) that its own deployment sets, not the Docker one
  it.skipIf(existsSync(join(ROOT, "apps/api/src/cloud")))("docker-compose.yml passes every variable the code reads", () => {
    expect(minus(readByCode, composeEnvironment(), COMPOSE_WIRED)).toEqual([]);
  });

  it("docker-compose.yml passes no variable the code does not read", () => {
    expect(minus(composeEnvironment(), code)).toEqual([]);
  });

  it(".env.docker.example documents every variable compose takes from .env", () => {
    expect(minus(composeInputs(), exampleVars(".env.docker.example"))).toEqual([]);
  });

  it(".env.docker.example documents nothing compose ignores", () => {
    expect(minus(exampleVars(".env.docker.example"), composeInputs())).toEqual([]);
  });

  it(".env.example documents only variables the code reads", () => {
    expect(minus(exampleVars(".env.example"), code)).toEqual([]);
  });

  it("apps/api/wrangler.jsonc sets only variables the code reads", () => {
    const vars = [...read("apps/api/wrangler.jsonc").matchAll(/"([A-Z][A-Z0-9_]*)"\s*:/g)].map((m) => m[1]);
    expect(minus(vars, code)).toEqual([]);
  });
});
