import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { zh } from "./zh";

const src = readFileSync(new URL("./zh.ts", import.meta.url), "utf8");

/** Entry keys as written in the source: quoted or bare identifiers followed by `:` and a string value. */
function sourceKeys(): string[] {
  const keys: string[] = [];
  const re = /(?:^|[,{])\s*(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_$][\w$]*))\s*:\s*"/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) keys.push(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]);
  return keys;
}
const placeholders = (s: string) => (s.match(/\{[A-Za-z0-9_]+\}/g) ?? []).sort();

describe("zh dictionary", () => {
  it("parses at least as many keys from source as the runtime object has", () => {
    expect(sourceKeys().length).toBeGreaterThanOrEqual(Object.keys(zh).length);
  });
  it("has no duplicate keys", () => {
    const seen = new Set<string>();
    const dups = sourceKeys().filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
    expect(dups).toEqual([]);
  });
  it("has no empty keys or values", () => {
    for (const [k, v] of Object.entries(zh)) {
      expect(k.trim(), "empty key").not.toBe("");
      expect(v.trim(), `empty value for "${k}"`).not.toBe("");
    }
  });
  it("keeps {placeholders} identical between key and value", () => {
    for (const [k, v] of Object.entries(zh)) expect(placeholders(v), k).toEqual(placeholders(k));
  });
});
