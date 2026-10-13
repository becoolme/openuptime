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
    expect(pickLocale(`${COOKIE}=en`)).toBe("en");
    expect(pickLocale(`a=b; ${COOKIE}=zh-CN`)).toBe("zh-CN");
  });
  it("never follows the browser language", () => {
    expect(pickLocale(null)).toBe("en");
    expect(pickLocale(undefined)).toBe("en");
    expect(pickLocale(`${COOKIE}=fr`)).toBe("en");
  });
  it("landing-only languages render the rest of the site in English", () => {
    expect(pickLocale(`${COOKIE}=ja`)).toBe("en");
    expect(pickLocale(`${COOKIE}=es`)).toBe("en");
  });
  it("the URL wins over the cookie", () => {
    expect(pickLocale(`${COOKIE}=en`, "/zh-Hans/pricing")).toBe("zh-CN");
    expect(pickLocale(`${COOKIE}=zh-CN`, "/status/acme")).toBe("en");
    expect(pickLocale(null, "/zh-Hans/status/acme")).toBe("zh-CN");
  });
});
