import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pub = (p: string) => new URL(`../../public/${p}`, import.meta.url);
const manifest = JSON.parse(readFileSync(pub("manifest.webmanifest"), "utf8"));

describe("web app manifest", () => {
  it("starts in the back office, within scope", () => {
    expect(manifest.start_url).toBe("/app");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.name).toBeTruthy();
  });
  it("points at icons that exist, including a maskable one", () => {
    for (const icon of manifest.icons) expect(existsSync(pub(icon.src.slice(1))), icon.src).toBe(true);
    expect(manifest.icons.some((i: { purpose: string }) => i.purpose === "maskable")).toBe(true);
    expect(manifest.icons.some((i: { sizes: string }) => i.sizes === "192x192")).toBe(true);
    expect(manifest.icons.some((i: { sizes: string }) => i.sizes === "512x512")).toBe(true);
  });
});
