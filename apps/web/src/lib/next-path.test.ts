import { describe, expect, it } from "vitest";
import { nextPath } from "./next-path";

describe("nextPath", () => {
  it("defaults to /app", () => {
    expect(nextPath("")).toBe("/app");
    expect(nextPath("?foo=1")).toBe("/app");
  });
  it("accepts same-site paths", () => {
    expect(nextPath("?next=/app/monitors/1")).toBe("/app/monitors/1");
    expect(nextPath("?next=%2Fapp%2Fteam")).toBe("/app/team");
  });
  it("rejects open redirects", () => {
    for (const n of ["//evil.com", "https://evil.com", "evil.com", "/\\evil.com", "%2F%2Fevil.com", "javascript:alert(1)"]) {
      expect(nextPath(`?next=${n}`)).toBe("/app");
    }
  });
});
