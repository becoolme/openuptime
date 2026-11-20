import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generate } from "./gen-api.mjs";

const api = generate();
const manifest = JSON.parse(readFileSync(new URL("../../../packages/ui/package.json", import.meta.url), "utf8"));
const all = api.modules.flatMap((m) => m.exports);

describe("generated UI reference", () => {
  it("covers every entry point the package exports", () => {
    const listed = [...api.modules.map((m) => m.specifier), ...api.styles.map((s) => s.specifier), "@openuptime/ui/theme.css"];
    expect(listed.sort()).toEqual(Object.keys(manifest.exports).map((k) => `${manifest.name}${k.slice(1)}`).sort());
  });

  it("documents every component's props from its type", () => {
    const select = all.find((e) => e.name === "Select");
    expect(select?.kind).toBe("component");
    expect(select.props.find((p) => p.name === "compact")).toMatchObject({ optional: true, doc: expect.stringContaining("top bar") });
    expect(all.find((e) => e.name === "SkeletonRows").props.find((p) => p.name === "rows").default).toBe("5");
  });

  it("reads light and dark values for the theme tokens", () => {
    expect(api.tokens.find((t) => t.name === "--accent")).toMatchObject({ light: expect.any(String), dark: expect.any(String) });
  });

  it("has a live demo for every component and hook", () => {
    const missing = all.filter((e) => e.kind === "component" || e.kind === "hook").filter((e) => !existsSync(new URL(`../src/demos/${e.name}.demo.tsx`, import.meta.url)));
    expect(missing.map((e) => e.name)).toEqual([]);
  });
});
