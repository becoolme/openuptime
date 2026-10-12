import { describe, expect, it } from "vitest";
import { siteLogo } from "./brand";

describe("siteLogo", () => {
  it("uses the host of the website link", () => {
    expect(siteLogo("https://www.example.com/pricing?x=1")).toBe("https://favicon.im/www.example.com");
    expect(siteLogo("http://status.acme.io:8080/")).toBe("https://favicon.im/status.acme.io");
  });
  it("returns null without a usable http(s) link", () => {
    expect(siteLogo(null)).toBeNull();
    expect(siteLogo("")).toBeNull();
    expect(siteLogo("not a url")).toBeNull();
    expect(siteLogo("javascript:alert(1)")).toBeNull();
    expect(siteLogo("mailto:hi@example.com")).toBeNull();
  });
});
