import { describe, expect, it } from "vitest";
import { MIN_BAR_PX, visibleRange } from "./ResponseChart";

describe("response chart window", () => {
  it("keeps every bar at least MIN_BAR_PX wide, so the chart scrolls instead of shrinking the bars", () => {
    expect(MIN_BAR_PX).toBeGreaterThanOrEqual(8);
  });

  it("shows all bars when they fit", () => {
    expect(visibleRange(10, 0, 500, 500)).toEqual([0, 9]);
  });

  it("shows the newest bars at the right edge of a long history", () => {
    // 120 bars of 10px in a 400px box scrolled to the end
    expect(visibleRange(120, 800, 400, 1200)).toEqual([80, 119]);
  });

  it("follows the scroll position", () => {
    expect(visibleRange(120, 0, 400, 1200)).toEqual([0, 39]);
    expect(visibleRange(120, 300, 400, 1200)).toEqual([30, 69]);
  });

  it("copes with an empty or single-run history", () => {
    expect(visibleRange(0, 0, 400, 0)).toEqual([0, 0]);
    expect(visibleRange(1, 0, 400, 44)).toEqual([0, 0]);
  });
});
