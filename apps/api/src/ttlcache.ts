// A small in-process cache with an expiry, for read-mostly public payloads. It lives in the process (Node, Docker) or the
// isolate (Workers), so it needs no Redis or edge cache and behaves the same everywhere; each instance warms its own copy.
// It stores finished values, never promises: a Workers request that awaits a promise another request started can hang.
export function ttlCache<V>(ttlMs: number, max = 500) {
  const items = new Map<string, { at: number; value: V }>();
  return {
    get(key: string, now = Date.now()): V | undefined {
      const hit = items.get(key);
      if (!hit) return undefined;
      if (now - hit.at >= ttlMs) {
        items.delete(key);
        return undefined;
      }
      return hit.value;
    },
    clear() {
      items.clear();
    },
    set(key: string, value: V, now = Date.now()) {
      if (items.size >= max) items.delete(items.keys().next().value as string); // the oldest entry; insertion order
      items.delete(key);
      items.set(key, { at: now, value });
    },
  };
}
