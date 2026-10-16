import { afterEach, describe, expect, it } from "vitest";
import { sharedCache, useEdgeCache, type EdgeStore } from "./sharedcache";

const fake = () => {
  const data = new Map<string, string>();
  const store: EdgeStore = { get: async (k) => data.get(k), put: async (k, v) => void data.set(k, v) };
  return { data, store };
};
afterEach(() => useEdgeCache(undefined));

describe("sharedCache", () => {
  it("loads once and then serves from memory", async () => {
    const c = sharedCache<number>("t", 1000);
    let n = 0;
    const load = async () => ++n;
    expect([await c.cached("a", load), await c.cached("a", load)]).toEqual([1, 1]);
  });
  it("does not keep what load returns undefined for", async () => {
    const c = sharedCache<number>("t", 1000);
    let n = 0;
    expect(await c.cached("a", async () => (++n, undefined))).toBeUndefined();
    expect(await c.cached("a", async () => (++n, undefined))).toBeUndefined();
    expect(n).toBe(2);
  });
  it("shares a value through the edge store with another instance", async () => {
    const { store, data } = fake();
    useEdgeCache(store);
    await sharedCache<{ x: number }>("t", 1000).cached("a", async () => ({ x: 1 }));
    expect(data.has("t|a")).toBe(true);
    let loaded = false;
    const other = sharedCache<{ x: number }>("t", 1000);
    expect(await other.cached("a", async () => ((loaded = true), { x: 2 }))).toEqual({ x: 1 });
    expect(loaded).toBe(false);
  });
  it("hands the edge write to waitUntil when there is one", async () => {
    const { store } = fake();
    useEdgeCache(store);
    const work: Promise<unknown>[] = [];
    await sharedCache<number>("t", 1000).cached("a", async () => 1, (p) => work.push(p));
    expect(work).toHaveLength(1);
  });
  it("skips the edge store when the ttl is zero", async () => {
    const { store, data } = fake();
    useEdgeCache(store);
    await sharedCache<number>("t", 0).cached("a", async () => 1);
    expect(data.size).toBe(0);
  });
});
