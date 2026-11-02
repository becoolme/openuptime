import { describe, expect, it } from "vitest";
import { lazy } from "./lazy";

describe("lazy", () => {
  it("builds nothing until a property is read, then builds once", () => {
    let built = 0;
    const o = lazy(() => (built++, { n: 1, nested: { m: 2 } }));
    expect(built).toBe(0);
    expect(o.n).toBe(1);
    expect(o.nested.m).toBe(2);
    expect(built).toBe(1);
  });

  it("keeps the built object as this for its methods", async () => {
    class Counter { count = 0; add() { return ++this.count; } async later() { return this.add(); } }
    const c = lazy(() => new Counter());
    const add = c.add;
    expect(add()).toBe(1);
    expect(await c.later()).toBe(2);
    expect(c.count).toBe(2);
  });

  it("answers in and key listing from the built object", () => {
    const o = lazy(() => ({ a: 1, b: 2 }) as Record<string, number>);
    expect("a" in o).toBe(true);
    expect("z" in o).toBe(false);
    expect(Object.keys(o)).toEqual(["a", "b"]);
  });
});
