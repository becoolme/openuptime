import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LOGO_IMG_HOSTS, siteLogo } from "./brand";

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

describe("status page CSP", () => {
  it("allows the favicon host and the host it redirects to", () => {
    expect(LOGO_IMG_HOSTS).toContain(new URL(siteLogo("https://example.com")!).origin);
    expect(LOGO_IMG_HOSTS).toContain("https://a.favicon.im");
    const page = readFileSync(new URL("../pages/status/[slug].astro", import.meta.url), "utf8");
    expect(page).toContain("LOGO_IMG_HOSTS.join");
  });
});
