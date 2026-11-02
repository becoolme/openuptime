import { describe, expect, it } from "vitest";
import { ttlCache } from "./ttlcache";

describe("ttlCache", () => {
  it("serves a value until it expires", () => {
    const c = ttlCache<string>(1000);
    c.set("a", "x", 0);
    expect(c.get("a", 999)).toBe("x");
    expect(c.get("a", 1000)).toBeUndefined();
  });
  it("drops the oldest entry when full", () => {
    const c = ttlCache<number>(1000, 2);
    c.set("a", 1, 0);
    c.set("b", 2, 0);
    c.set("c", 3, 0);
    expect([c.get("a", 1), c.get("b", 1), c.get("c", 1)]).toEqual([undefined, 2, 3]);
  });
});
