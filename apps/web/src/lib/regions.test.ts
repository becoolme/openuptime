import { describe, expect, it } from "vitest";
import { regionLocked, toggleRegion } from "./regions";

describe("toggleRegion", () => {
  it("replaces auto with the first region picked", () => {
    expect(toggleRegion(["auto"], "us-east", 1)).toEqual(["us-east"]);
    expect(toggleRegion(["auto"], "us-east", 3)).toEqual(["us-east"]);
  });
  it("switches to another region on a one-region plan", () => {
    expect(toggleRegion(["us-east"], "eu-central", 1)).toEqual(["eu-central"]);
    expect(toggleRegion(["us-east"], "auto", 1)).toEqual(["auto"]);
  });
  it("adds regions up to the limit and then holds", () => {
    expect(toggleRegion(["us-east"], "eu-central", 3)).toEqual(["us-east", "eu-central"]);
    expect(toggleRegion(["us-east", "eu-central", "ap-southeast"], "us-west", 3)).toEqual(["us-east", "eu-central", "ap-southeast"]);
  });
  it("falls back to auto when the last one is switched off", () => {
    expect(toggleRegion(["us-east"], "us-east", 3)).toEqual(["auto"]);
    expect(toggleRegion(["us-east", "eu-central"], "us-east", 3)).toEqual(["eu-central"]);
  });
});

describe("regionLocked", () => {
  it("never locks a one-region plan, where picking replaces", () => {
    expect(regionLocked(["auto"], "us-east", 1)).toBe(false);
    expect(regionLocked(["us-east"], "eu-central", 1)).toBe(false);
  });
  it("locks the unselected options of a full multi-region selection", () => {
    const full = ["us-east", "eu-central", "ap-southeast"];
    expect(regionLocked(full, "us-west", 3)).toBe(true);
    expect(regionLocked(full, "us-east", 3)).toBe(false);
    expect(regionLocked(["us-east", "eu-central"], "us-west", 3)).toBe(false);
  });
});
