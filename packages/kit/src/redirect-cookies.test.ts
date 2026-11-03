import { describe, expect, it } from "vitest";
import { RedirectCookies } from "./netguard";

const answer = (...cookies: string[]) => {
  const h = new Headers();
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
};

describe("redirect cookies", () => {
  it("returns a cookie only to the host that set it, and a Secure one only over https", () => {
    const jar = new RedirectCookies();
    jar.take("a.example", answer("s=1; Domain=example; Path=/x", "t=2; Secure"));
    expect(jar.header(new URL("http://a.example/"), null)).toBe("s=1");
    expect(jar.header(new URL("https://a.example/"), "own=0")).toBe("own=0; s=1; t=2");
    expect(jar.header(new URL("https://b.example/"), null)).toBeNull();
  });
  it("removes a cookie that expires, and lets Max-Age win over Expires", () => {
    const jar = new RedirectCookies();
    jar.take("a.example", answer("a=1", "b=1", "c=1", "d=1"));
    jar.take("a.example", answer("a=; Max-Age=0", "b=; Expires=Thu, 01 Jan 1970 00:00:00 GMT", "c=2; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT", "d=3; Max-Age"));
    expect(jar.header(new URL("http://a.example/"), null)).toBe("c=2; d=3");
  });
  it("ignores malformed and oversized cookies, and keeps at most 50 per host", () => {
    const jar = new RedirectCookies();
    jar.take("a.example", answer("novalue", "bad name=1", `big=${"x".repeat(5000)}`));
    expect(jar.header(new URL("http://a.example/"), null)).toBeNull();
    jar.take("a.example", answer(...Array.from({ length: 60 }, (_, i) => `k${i}=v`)));
    expect(jar.header(new URL("http://a.example/"), null)!.split("; ")).toHaveLength(50);
    // one already kept can still be changed
    jar.take("a.example", answer("k0=w"));
    expect(jar.header(new URL("http://a.example/"), null)).toContain("k0=w");
  });
});
