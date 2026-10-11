import { describe, expect, it } from "vitest";
import { splitLocale, stripLocale, withLocale } from "./locale-path";

describe("locale paths", () => {
  it("splits prefixes", () => {
    expect(splitLocale("/zh-Hans")).toEqual({ locale: "zh-CN", rest: "/" });
    expect(splitLocale("/zh-Hans/app/team")).toEqual({ locale: "zh-CN", rest: "/app/team" });
    expect(splitLocale("/ja/")).toEqual({ locale: "ja", rest: "/" });
    expect(splitLocale("/app")).toEqual({ locale: null, rest: "/app" });
    expect(splitLocale("/jap/app")).toEqual({ locale: null, rest: "/jap/app" });
  });
  it("strips", () => expect(stripLocale("/zh-Hans/login")).toBe("/login"));
  it("adds prefixes without doubling", () => {
    expect(withLocale("/app", "zh-CN")).toBe("/zh-Hans/app");
    expect(withLocale("/", "zh-CN")).toBe("/zh-Hans");
    expect(withLocale("/zh-Hans/app?x=1#h", "zh-CN")).toBe("/zh-Hans/app?x=1#h");
    expect(withLocale("/zh-Hans/app", "en")).toBe("/app");
    expect(withLocale("/app", "en")).toBe("/app");
  });
});
