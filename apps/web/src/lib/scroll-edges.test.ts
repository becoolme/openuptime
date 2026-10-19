import { describe, expect, it } from "vitest";
import { scrollEdges } from "./scroll-edges";

describe("scrollEdges", () => {
  it("shows nothing when the content fits", () => {
    expect(scrollEdges(0, 160, 160)).toEqual({ top: false, bottom: false });
  });
  it("shows only the bottom edge at the top of a long list", () => {
    expect(scrollEdges(0, 160, 400)).toEqual({ top: false, bottom: true });
  });
  it("shows both edges in the middle", () => {
    expect(scrollEdges(100, 160, 400)).toEqual({ top: true, bottom: true });
  });
  it("shows only the top edge at the end, tolerating fractions", () => {
    expect(scrollEdges(240, 160, 400)).toEqual({ top: true, bottom: false });
    expect(scrollEdges(239.6, 160, 400)).toEqual({ top: true, bottom: false });
  });
});
