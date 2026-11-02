import { describe, expect, it } from "vitest";
import { read, walk } from "./helpers";

/**
 * Workers accept only "follow" and "manual" as a fetch redirect mode and throw on "error", while Node accepts it, so
 * unit tests under Node pass and the same code fails in production. DNS monitors broke this way.
 */
describe("fetch in Workers code", () => {
  it("uses no redirect mode that Workers refuse", () => {
    const files = ["apps/api/src", "packages"].flatMap((dir) => walk(dir, (f) => /\.(ts|mjs|js)$/.test(f) && !/\.test\.ts$/.test(f)));
    const bad = files.filter((f) => /redirect:\s*["'](?!follow["']|manual["'])/.test(read(f)));
    expect(bad).toEqual([]);
  });
});
