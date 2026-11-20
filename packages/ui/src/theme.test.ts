import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

/** Custom properties declared inside the first block that follows `selector`. */
function block(selector: string): Map<string, string> {
  const at = css.indexOf(selector);
  expect(at, `${selector} is missing`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at + selector.length - 1);
  const close = css.indexOf("}", open);
  const vars = new Map<string, string>();
  for (const m of css.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) vars.set(m[1], m[2].trim());
  return vars;
}

const light = block(":root{");
const literalColours = [...light].filter(([, v]) => /^#|^rgb|^hsl|^oklch/.test(v)).map(([k]) => k);

describe("theme tokens", () => {
  it("declares the tokens products rely on", () => {
    for (const k of ["--bg", "--surface", "--ink", "--muted", "--line", "--accent", "--ok", "--warn", "--down", "--radius", "--sans", "--mono"]) {
      expect(light.has(k), k).toBe(true);
    }
  });

  it.each([":root:not([data-theme=light]){", ":root[data-theme=dark]{"])("gives every literal colour a dark value in %s", (sel) => {
    const dark = block(sel);
    expect(literalColours.filter((k) => !dark.has(k))).toEqual([]);
  });

  it("keeps the two dark blocks identical", () => {
    expect([...block(":root:not([data-theme=light]){")]).toEqual([...block(":root[data-theme=dark]{")]);
  });
});
