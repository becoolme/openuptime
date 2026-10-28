import { ttlCache } from "./ttlcache";

// Short-lived copies of read-mostly payloads. Every process keeps its own in memory (Docker, Node, a Worker isolate). The
// Workers entry points also register the data centre's cache (`caches.default`), which every isolate in that data centre
// shares, so a copy computed by one is found by the others. Without it (Docker) only memory is used.

/** A store shared beyond one process. Values are JSON text. */
export interface EdgeStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
}

let edge: EdgeStore | undefined;
export function useEdgeCache(store: EdgeStore | undefined) {
  edge = store;
}

/** The Workers cache for this data centre, or undefined where there is none (it also does not exist on workers.dev). */
export function cloudflareEdgeCache(): EdgeStore | undefined {
  const cache = typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default : undefined;
  if (!cache) return undefined;
  const request = (key: string) => new Request(`https://edge-cache.openuptime.internal/${encodeURIComponent(key)}`);
  return {
    async get(key) {
      const hit = await cache.match(request(key)).catch(() => undefined);
      return hit ? await hit.text().catch(() => undefined) : undefined;
    },
    async put(key, value, ttlSeconds) {
      await cache.put(request(key), new Response(value, { headers: { "cache-control": `max-age=${ttlSeconds}` } })).catch(() => {});
    },
  };
}

type WaitUntil = (work: Promise<unknown>) => void;

/** The Workers `waitUntil` of a request, if it runs in one (Node has no execution context and Hono throws). */
export function waitUntilOf(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }): WaitUntil | undefined {
  try {
    return (p) => c.executionCtx.waitUntil(p);
  } catch {
    return undefined;
  }
}

/** Never stores promises: a Workers request awaiting another request's promise can hang. `load` returns undefined for "do not keep". */
export function sharedCache<V>(name: string, ttlMs: number, max = 500) {
  const memory = ttlCache<V>(ttlMs, max);
  return {
    async cached(key: string, load: () => Promise<V | undefined>, waitUntil?: WaitUntil, options?: { bypass?: boolean }): Promise<V | undefined> {
      if (options?.bypass) return load();
      const mem = memory.get(key);
      if (mem !== undefined) return mem;
      const store = ttlMs > 0 ? edge : undefined;
      const shared = store ? await store.get(`${name}|${key}`).catch(() => undefined) : undefined;
      if (shared) {
        try {
          const value = JSON.parse(shared) as V;
          memory.set(key, value);
          return value;
        } catch {}
      }
      const value = await load();
      if (value === undefined) return undefined;
      memory.set(key, value);
      if (store) {
        const write = store.put(`${name}|${key}`, JSON.stringify(value), Math.max(1, Math.round(ttlMs / 1000))).catch(() => {});
        if (waitUntil) waitUntil(write);
        else await write;
      }
      return value;
    },
    clear: () => memory.clear(),
  };
}
