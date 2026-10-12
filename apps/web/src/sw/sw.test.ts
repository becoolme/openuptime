import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { stampWorker } from "./stamp.mjs";

const template = readFileSync(new URL("./sw.js", import.meta.url), "utf8");
const FILES = ["/app", "/_astro/App.abc123.js", "/_astro/chunk.def456.js", "/_astro/app.789.css"];
const VERSION = "v1abcdef0123";

type Listener = (e: any) => void;
type Net = (req: { url: string; cache?: string }) => Promise<Response>;

/** Loads the stamped worker into a sandbox with a fake cache storage and network, and records everything it does. */
function load(opts: { files?: string[]; language?: string; existingCaches?: Record<string, Record<string, string>> } = {}) {
  const store = new Map<string, Map<string, Response>>();
  for (const [name, entries] of Object.entries(opts.existingCaches ?? {})) {
    store.set(name, new Map(Object.entries(entries).map(([k, v]) => [k, new Response(v)])));
  }
  const log = { cacheReads: 0, cachePuts: [] as string[], network: [] as string[], deleted: [] as string[] };
  const caches = {
    open: async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      return {
        put: async (url: string, res: Response) => {
          log.cachePuts.push(url);
          store.get(name)!.set(url, res);
        },
      };
    },
    match: async (url: string, o: { cacheName: string }) => {
      log.cacheReads++;
      return store.get(o.cacheName)?.get(url)?.clone();
    },
    keys: async () => [...store.keys()],
    delete: async (name: string) => {
      log.deleted.push(name);
      return store.delete(name);
    },
  };
  let net: Net = async (req) => new Response("live:" + new URL(req.url).pathname);
  const listeners: Record<string, Listener> = {};
  let skipped = 0;
  const self = {
    location: { origin: "https://app.example" },
    navigator: { language: opts.language ?? "en-US" },
    addEventListener: (t: string, fn: Listener) => (listeners[t] = fn),
    skipWaiting: () => void skipped++,
  };
  class FakeRequest {
    url: string;
    cache?: string;
    constructor(path: string, init: { cache?: string } = {}) {
      this.url = new URL(path, "https://app.example").toString();
      this.cache = init.cache;
    }
  }
  const fetchFn = (req: { url: string; cache?: string }) => {
    log.network.push(new URL(req.url).pathname + (req.cache ? `#${req.cache}` : ""));
    return net(req);
  };
  const code = stampWorker(template, { version: VERSION, files: opts.files ?? FILES });
  runInNewContext(code, { self, caches, URL, Response, Request: FakeRequest, fetch: fetchFn, Promise, Set, Array });
  return {
    listeners,
    log,
    store,
    skipped: () => skipped,
    setNetwork: (fn: Net) => (net = fn),
    /** undefined when the worker leaves the request alone, else what it answered with */
    async fetch(url: string, init: { method?: string; mode?: string } = {}) {
      let answer: Promise<Response> | undefined;
      listeners.fetch({
        request: { url, method: init.method ?? "GET", mode: init.mode ?? "navigate" },
        respondWith: (p: Promise<Response>) => (answer = p),
      });
      return answer;
    },
    async lifecycle(type: "install" | "activate") {
      let work: Promise<unknown> = Promise.resolve();
      listeners[type]({ waitUntil: (p: Promise<unknown>) => (work = p) });
      await work;
    },
  };
}
const at = (p: string) => `https://app.example${p}`;
const text = async (r: Response | undefined) => r!.text();

describe("what the worker leaves alone", () => {
  it("never touches API, internal, auth or other pages, as a navigation or as a fetch", async () => {
    const sw = load();
    await sw.lifecycle("install");
    sw.log.cacheReads = 0;
    for (const path of ["/api/monitors", "/api/auth/get-session", "/api/counts", "/internal/x", "/oauth/callback", "/status/acme", "/", "/login", "/signup", "/health", "/.well-known/x", "/changelog", "/docs"]) {
      for (const mode of ["navigate", "cors", "same-origin", "no-cors"]) {
        expect(await sw.fetch(at(path), { mode }), `${mode} ${path}`).toBeUndefined();
      }
    }
    expect(sw.log.cacheReads).toBe(0);
    expect(sw.log.network.filter((n) => !n.endsWith("#reload"))).toEqual([]);
  });

  it("never touches non-GET requests or another origin", async () => {
    const sw = load();
    await sw.lifecycle("install");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(await sw.fetch(at("/app"), { method })).toBeUndefined();
      expect(await sw.fetch(at("/api/monitors"), { method, mode: "cors" })).toBeUndefined();
    }
    expect(await sw.fetch("https://other.example/app")).toBeUndefined();
    expect(await sw.fetch("https://other.example/_astro/App.abc123.js", { mode: "cors" })).toBeUndefined();
  });

  it("does not answer fetch() calls to the shell path or to files that are not on the list", async () => {
    const sw = load();
    await sw.lifecycle("install");
    expect(await sw.fetch(at("/app"), { mode: "cors" })).toBeUndefined();
    expect(await sw.fetch(at("/_astro/Other.zzz.js"), { mode: "cors" })).toBeUndefined();
    expect(await sw.fetch(at("/_astro/App.abc123.js/../../api/me"), { mode: "cors" })).toBeUndefined();
  });

  it("is not fooled by paths that only look like /app", async () => {
    const sw = load();
    await sw.lifecycle("install");
    for (const path of ["/apple", "/app.js", "/application", "/api/app", "/x/app", "/zh-Hans/api/app", "/zh-Hans/apple", "/zh-Hans/x/app"]) {
      expect(await sw.fetch(at(path)), path).toBeUndefined();
    }
  });

  it("can never be handed an API path to cache: the list is fixed by the build", async () => {
    const sw = load();
    await sw.lifecycle("install");
    await sw.fetch(at("/api/me"), { mode: "cors" });
    await sw.fetch(at("/app/monitors/1"));
    expect(sw.log.cachePuts.sort()).toEqual([...FILES].sort());
  });
});

describe("what it serves", () => {
  it("answers every back-office page navigation with the cached shell, without the network", async () => {
    const sw = load();
    await sw.lifecycle("install");
    sw.log.network.length = 0;
    for (const path of ["/app", "/app/monitors/123", "/app/status-pages/9/edit?x=1", "/zh-Hans/app", "/zh-Hans/app/incidents"]) {
      expect(await text(await sw.fetch(at(path))), path).toBe("live:/app");
    }
    expect(sw.log.network).toEqual([]);
  });

  it("serves listed assets from the cache and does not write at fetch time", async () => {
    const sw = load();
    await sw.lifecycle("install");
    const puts = sw.log.cachePuts.length;
    sw.log.network.length = 0;
    expect(await text(await sw.fetch(at("/_astro/App.abc123.js?v=1"), { mode: "cors" }))).toBe("live:/_astro/App.abc123.js");
    expect(sw.log.network).toEqual([]);
    expect(sw.log.cachePuts.length).toBe(puts);
  });

  it("falls back to the network for a listed asset that is somehow missing from the cache", async () => {
    const sw = load();
    // never installed: nothing cached
    expect(await text(await sw.fetch(at("/_astro/App.abc123.js"), { mode: "cors" }))).toBe("live:/_astro/App.abc123.js");
    expect(sw.log.cachePuts).toEqual([]);
  });

  it("with no cached shell, goes to the network, returning errors unchanged, and only a missing network gets the offline page", async () => {
    const sw = load();
    sw.setNetwork(async () => new Response("denied", { status: 401 }));
    const r = (await sw.fetch(at("/app")))!;
    expect(r.status).toBe(401);
    sw.setNetwork(async () => {
      throw new TypeError("Failed to fetch");
    });
    const en = (await sw.fetch(at("/app")))!;
    expect(en.status).toBe(503);
    expect(en.headers.get("cache-control")).toBe("no-store");
    expect(await en.text()).toContain("You are offline");
    expect(await (await sw.fetch(at("/zh-Hans/app")))!.text()).toContain("当前处于离线状态");
  });
});

describe("install and activate", () => {
  it("downloads the list fresh from the server into a cache named after the build", async () => {
    const sw = load();
    await sw.lifecycle("install");
    expect([...sw.store.keys()]).toEqual([`ou-shell-${VERSION}`]);
    expect([...sw.store.get(`ou-shell-${VERSION}`)!.keys()].sort()).toEqual([...FILES].sort());
    expect(sw.log.network.sort()).toEqual(FILES.map((f) => `${f}#reload`).sort());
  });

  it("fails the install when a file is missing, or was redirected, so the old version keeps running", async () => {
    const missing = load();
    missing.setNetwork(async (r) => (r.url.endsWith("chunk.def456.js") ? new Response("nf", { status: 404 }) : new Response("ok")));
    await expect(missing.lifecycle("install")).rejects.toThrow(/chunk\.def456\.js/);
    const redirected = load();
    redirected.setNetwork(async () => {
      const res = new Response("ok");
      Object.defineProperty(res, "redirected", { value: true });
      return res;
    });
    await expect(redirected.lifecycle("install")).rejects.toThrow();
  });

  it("on activate removes earlier builds' caches and nothing else", async () => {
    const sw = load({ existingCaches: { "ou-shell-old1": {}, "ou-shell-old2": {}, [`ou-shell-${VERSION}`]: {}, "someone-elses": {} } });
    await sw.lifecycle("activate");
    expect(sw.log.deleted.sort()).toEqual(["ou-shell-old1", "ou-shell-old2"]);
    expect([...sw.store.keys()].sort()).toEqual([`ou-shell-${VERSION}`, "someone-elses"].sort());
  });

  it("waits to take over until the page asks", () => {
    const sw = load();
    expect(sw.skipped()).toBe(0);
    sw.listeners.message({ data: { type: "SKIP_WAITING" } });
    expect(sw.skipped()).toBe(1);
    sw.listeners.message({ data: { type: "something-else" } });
    expect(sw.skipped()).toBe(1);
  });
});

describe("source", () => {
  it("writes to the cache in one place only (install) and never names an API path", () => {
    const code = template.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code.match(/\.put\(/g)).toHaveLength(1);
    expect(code).not.toMatch(/\.addAll\(|\.add\(|IndexedDB|localStorage|\/api|\/internal/);
    expect(code.indexOf(".put(")).toBeGreaterThan(code.indexOf("async function precache"));
    expect(code.indexOf(".put(")).toBeLessThan(code.indexOf("async function asset"));
  });
});
