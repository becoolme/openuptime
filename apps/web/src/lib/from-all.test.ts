import { describe, expect, it } from "vitest";
import { forgetAll, rememberAll, takeAll } from "./from-all";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

describe("from-all memory", () => {
  it("is empty until the All view is left", () => {
    expect(takeAll(memory())).toBe(false);
  });
  it("is consumed by the first back navigation", () => {
    const s = memory();
    rememberAll(s);
    expect(takeAll(s)).toBe(true);
    expect(takeAll(s)).toBe(false);
  });
  it("is dropped when the visitor picks a project", () => {
    const s = memory();
    rememberAll(s);
    forgetAll(s);
    expect(takeAll(s)).toBe(false);
  });
  it("survives blocked storage", () => {
    const broken = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => { throw new Error("x"); } };
    expect(() => { rememberAll(broken); forgetAll(broken); }).not.toThrow();
    expect(takeAll(broken)).toBe(false);
    expect(takeAll(null)).toBe(false);
  });
});
