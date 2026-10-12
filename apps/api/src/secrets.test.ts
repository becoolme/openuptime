import { describe, expect, it } from "vitest";
import { MASK, maskConfig, maskHeaders, restoreConfig, restoreHeaders, sameJson } from "./secrets";
import { clientIp, safeEqual } from "./ratelimit";

describe("channel settings", () => {
  const stored = { url: "https://hooks.slack.com/services/T000/B000/abcdef", secret: "s3cr3t", botToken: "123:abc", chatId: "-100", to: "ops@example.com" };

  it("hides credentials but keeps what is not secret", () => {
    const m = maskConfig(stored);
    expect(m.url).toBe(`https://hooks.slack.com/${MASK}`);
    expect(m.secret).toBe(MASK);
    expect(m.botToken).toBe(MASK);
    expect(m.chatId).toBe("-100");
    expect(m.to).toBe("ops@example.com");
    expect(JSON.stringify(m)).not.toContain("abcdef");
  });

  it("treats a placeholder sent back as unchanged, and a new value as a change", () => {
    expect(sameJson(restoreConfig(maskConfig(stored), stored), stored)).toBe(true);
    const changed = restoreConfig({ ...maskConfig(stored), url: "https://example.com/new" }, stored);
    expect(changed.url).toBe("https://example.com/new");
    expect(changed.secret).toBe("s3cr3t");
    expect(sameJson(changed, stored)).toBe(false);
  });

  it("does not let a guessed placeholder replace a different credential", () => {
    // the placeholder only stands for the stored value of the same key
    expect(restoreConfig({ url: `https://other.example/${MASK}` }, stored).url).toBe(`https://other.example/${MASK}`);
  });
});

describe("monitor headers", () => {
  it("hides values, keeps names and restores placeholders", () => {
    const stored = { Authorization: "Bearer abc", "X-Env": "prod" };
    expect(maskHeaders(stored)).toEqual({ Authorization: MASK, "X-Env": MASK });
    expect(restoreHeaders({ Authorization: MASK, "X-Env": "staging", "X-New": MASK }, stored)).toEqual({ Authorization: "Bearer abc", "X-Env": "staging" });
  });
});

describe("client address", () => {
  const ctx = (headers: Record<string, string>) => ({ req: { header: (k: string) => headers[k.toLowerCase()] }, env: {} }) as never;
  it("ignores forwarding headers unless a proxy is trusted", () => {
    expect(clientIp(ctx({ "x-forwarded-for": "1.2.3.4", "cf-connecting-ip": "5.6.7.8" }))).toBeNull();
    expect(clientIp(ctx({ "x-forwarded-for": "9.9.9.9, 1.2.3.4" }), { TRUST_PROXY: "true" })).toBe("1.2.3.4");
  });
});

describe("safeEqual", () => {
  it("compares strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual(undefined, "abc")).toBe(false);
  });
});
