import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listPrecache, MAX_PRECACHE_BYTES, stampWorker } from "./stamp.mjs";

function client(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "ou-sw-"));
  mkdirSync(join(dir, "_astro"));
  writeFileSync(join(dir, "app.html"), "<html>shell</html>");
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

describe("listPrecache", () => {
  it("lists the shell and the build's hashed assets only", () => {
    const dir = client({ "_astro/a.1.js": "a", "_astro/b.2.css": "b", "_astro/a.1.js.map": "m", "login.html": "x", "sw.js": "x" });
    const { files } = listPrecache(dir);
    expect(files).toEqual(["/app", "/_astro/a.1.js", "/_astro/b.2.css"]);
    for (const f of files) expect(f === "/app" || f.startsWith("/_astro/")).toBe(true);
  });
  it("gives the same id for the same build and a different one when a file changes", () => {
    const a = listPrecache(client({ "_astro/a.1.js": "a" }));
    const b = listPrecache(client({ "_astro/a.1.js": "a" }));
    const c = listPrecache(client({ "_astro/a.1.js": "changed" }));
    const d = listPrecache(client({ "_astro/a.1.js": "a", "_astro/new.js": "n" }));
    expect(a.version).toBe(b.version);
    expect(new Set([a.version, c.version, d.version]).size).toBe(3);
    expect(a.version).toMatch(/^[0-9a-f]{12}$/);
  });
  it("fails the build when the shell is missing or the list is oversized", () => {
    const empty = mkdtempSync(join(tmpdir(), "ou-sw-"));
    expect(() => listPrecache(empty)).toThrow();
    const big = client({ "_astro/big.js": "x".repeat(MAX_PRECACHE_BYTES + 1) });
    expect(() => listPrecache(big)).toThrow(/cap/);
  });
});

describe("stampWorker", () => {
  const template = readFileSync(new URL("./sw.js", import.meta.url), "utf8");
  it("fills in the id and the list, leaving no placeholder", () => {
    const out = stampWorker(template, { version: "abc123abc123", files: ["/app", "/_astro/a.js"] });
    expect(out).toContain('const VERSION = "abc123abc123";');
    expect(out).toContain('const PRECACHE = ["/app","/_astro/a.js"];');
    expect(out).not.toContain("__BUILD_ID__");
    expect(out).not.toContain("__PRECACHE__");
  });
  it("refuses a template without the placeholders", () => {
    expect(() => stampWorker("const x = 1;", { version: "v", files: [] })).toThrow();
  });
});
