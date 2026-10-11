import { describe, expect, it } from "vitest";
import { COOKIE, pickLocale, t, translate } from "./i18n";
import { zh } from "./zh";

const [key, val] = Object.entries(zh)[0];

describe("translate", () => {
  it("returns English for en", () => expect(translate("en", key)).toBe(key));
  it("translates for zh-CN", () => expect(translate("zh-CN", key)).toBe(val));
  it("falls back to the source text when missing", () => {
    expect(translate("zh-CN", "__no such key__")).toBe("__no such key__");
  });
});

describe("t (no DOM)", () => {
  it("falls back to English without document", () => expect(t(key)).toBe(key));
});

describe("pickLocale", () => {
  it("prefers a valid cookie", () => {
    expect(pickLocale(`${COOKIE}=en`, "zh-CN")).toBe("en");
    expect(pickLocale(`a=b; ${COOKIE}=zh-CN`, "en")).toBe("zh-CN");
  });
  it("falls back to Accept-Language", () => {
    expect(pickLocale(null, "zh-TW,zh;q=0.9")).toBe("zh-CN");
    expect(pickLocale(undefined, "en-US")).toBe("en");
    expect(pickLocale(`${COOKIE}=fr`, "zh")).toBe("zh-CN");
  });
  it("defaults to en", () => expect(pickLocale(null, null)).toBe("en"));
  it("status pages ignore cookie and Accept-Language", () => {
    expect(pickLocale(`${COOKIE}=zh-CN`, "zh-CN", "/status/acme")).toBe("en");
    expect(pickLocale(null, "zh", "/zh-Hans/status/acme")).toBe("zh-CN");
  });
});
