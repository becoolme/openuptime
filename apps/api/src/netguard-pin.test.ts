import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.fn();
const pinned = vi.fn();
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("./pinnedfetch", () => ({ pinnedFetch: pinned }));

const { configureNetGuard, dialEach, guardAddresses, guardHost, guardHosts, guardedFetch, targetIsPrivate, targetProblem } = await import("./netguard");

const answer = (...addrs: string[]) => lookup.mockResolvedValue(addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

let n = 0;
/** each test uses its own name: resolutions are cached for a short while */
const name = () => `host${++n}.example.com`;

beforeEach(() => {
  configureNetGuard({});
  lookup.mockReset();
  pinned.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("resolved addresses are validated and pinned", () => {
  it("refuses a name when any of its addresses is private", async () => {
    answer("93.184.216.34", "10.0.0.5");
    await expect(guardHost(name())).rejects.toThrow(/private or internal/);
    answer("2606:4700::1111", "::ffff:127.0.0.1");
    await expect(guardAddresses(name())).rejects.toThrow(/private or internal/);
  });

  it("hands back every validated address to dial", async () => {
    answer("93.184.216.34", "2606:2800:220:1::1");
    const h = name();
    expect(await guardAddresses(h)).toEqual({ host: h, addresses: ["93.184.216.34", "2606:2800:220:1::1"] });
    expect(await guardHost(h)).toBe("93.184.216.34");
  });

  it("does not dial a name that cannot be resolved, and does not turn it into a monitor error", async () => {
    lookup.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" }));
    await expect(guardHost(name())).rejects.toMatchObject({ code: "ENOTFOUND" });
    expect(await targetProblem("tcp", `${name()}:80`)).toBeNull();
  });

  it("connects an http check to the validated address, for every redirect hop", async () => {
    const first = name();
    const second = name();
    lookup.mockImplementation(async (h: string) => [{ address: h === first ? "93.184.216.34" : "8.8.8.8", family: 4 }]);
    pinned.mockImplementationOnce(async () => new Response(null, { status: 302, headers: { location: `https://${second}/next` } }))
      .mockImplementationOnce(async () => new Response("ok"));
    vi.stubGlobal("fetch", async () => { throw new Error("must not use the name-resolving fetch"); });
    const { res, url } = await guardedFetch(`https://${first}/`);
    expect(res.status).toBe(200);
    expect(url).toBe(`https://${second}/next`);
    expect(pinned.mock.calls.map((c) => [c[0], c[2]])).toEqual([[`https://${first}/`, ["93.184.216.34"]], [`https://${second}/next`, ["8.8.8.8"]]]);
  });

  it("refuses a redirect to a name that resolves privately, without connecting", async () => {
    const first = name();
    const evil = name();
    lookup.mockImplementation(async (h: string) => [{ address: h === first ? "93.184.216.34" : "169.254.169.254", family: 4 }]);
    pinned.mockImplementation(async () => new Response(null, { status: 302, headers: { location: `http://${evil}/` } }));
    await expect(guardedFetch(`https://${first}/`)).rejects.toThrow(/private or internal/);
    expect(pinned).toHaveBeenCalledTimes(1);
  });

  it("does not resolve or pin literals, nor anything when private targets are allowed", async () => {
    vi.stubGlobal("fetch", async () => new Response("ok"));
    await guardedFetch("https://93.184.216.34/");
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    await guardedFetch(`https://${name()}/`);
    expect(lookup).not.toHaveBeenCalled();
    expect(pinned).not.toHaveBeenCalled();
  });
});

describe("dialing every address", () => {
  it("lists IPv4 addresses first", async () => {
    answer("2606:2800:220:1::1", "93.184.216.34");
    expect(await guardHosts(name())).toEqual(["93.184.216.34", "2606:2800:220:1::1"]);
  });

  it("falls back to the next address when one fails", async () => {
    answer("93.184.216.34", "8.8.8.8");
    const tried: string[] = [];
    const r = await dialEach(name(), async (a) => {
      tried.push(a);
      if (a === "93.184.216.34") throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      return a;
    });
    expect(r).toBe("8.8.8.8");
    expect(tried).toEqual(["93.184.216.34", "8.8.8.8"]);
  });

  it("looks the name up again once when every address failed, and reports all failures", async () => {
    const h = name();
    lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]);
    const tried: string[] = [];
    const err = await dialEach(h, async (a) => { tried.push(a); throw new Error(`no ${a}`); }).catch((e) => e);
    expect(tried).toEqual(["93.184.216.34", "8.8.8.8"]);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(err.errors).toHaveLength(2);
  });

  it("succeeds on the fresh lookup after stale addresses failed", async () => {
    const h = name();
    lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]);
    const r = await dialEach(h, async (a) => { if (a === "93.184.216.34") throw new Error("gone"); return a; });
    expect(r).toBe("8.8.8.8");
  });

  it("gives each address its own slice of the time, so a blackholed one does not use up the deadline", async () => {
    vi.useFakeTimers();
    try {
      answer("93.184.216.34", "8.8.8.8");
      const signals: AbortSignal[] = [];
      const run = dialEach(name(), (a, signal) => {
        signals.push(signal);
        return a === "93.184.216.34" ? new Promise<string>(() => {}) : Promise.resolve(a);
      }, Date.now() + 10_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await run).toBe("8.8.8.8");
      expect(signals[0].aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands a connection that arrives after its slice to discard", async () => {
    vi.useFakeTimers();
    try {
      answer("93.184.216.34", "8.8.8.8");
      const late: string[] = [];
      let release!: (v: string) => void;
      const run = dialEach(name(), (a) => (a === "93.184.216.34" ? new Promise<string>((r) => { release = r; }) : Promise.resolve(a)), Date.now() + 10_000, (v) => late.push(v));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await run).toBe("8.8.8.8");
      release("slow");
      await vi.advanceTimersByTimeAsync(0);
      expect(late).toEqual(["slow"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rethrows a single failure as it is when there is nothing to look up again", async () => {
    const e = new Error("boom");
    await expect(dialEach("93.184.216.34", async () => { throw e; })).rejects.toBe(e);
  });
});

describe("targetIsPrivate", () => {
  it("is true for a name that resolves privately, false for public or unresolvable names", async () => {
    answer("10.1.2.3");
    expect(await targetIsPrivate(name())).toBe(true);
    answer("93.184.216.34");
    expect(await targetIsPrivate(name())).toBe(false);
    lookup.mockRejectedValue(Object.assign(new Error("x"), { code: "ENOTFOUND" }));
    expect(await targetIsPrivate(name())).toBe(false);
  });

  it("judges a name by its addresses when private targets are allowed, so public names keep the offline self-check", async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    answer("93.184.216.34");
    expect(await targetIsPrivate(name())).toBe(false);
    answer("10.1.2.3");
    expect(await targetIsPrivate(name())).toBe(true);
    lookup.mockRejectedValue(Object.assign(new Error("x"), { code: "ENOTFOUND" }));
    expect(await targetIsPrivate(name())).toBe(false);
    expect(await targetIsPrivate("93.184.216.34")).toBe(false);
    expect(await targetIsPrivate("10.0.0.1")).toBe(true);
  });
});

describe("stale resolutions", () => {
  it("retries a connect failure once with a fresh lookup", async () => {
    const h = name();
    lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]);
    pinned.mockRejectedValueOnce(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })).mockResolvedValueOnce(new Response("ok"));
    const { res } = await guardedFetch(`https://${h}/`);
    expect(res.status).toBe(200);
    expect(pinned.mock.calls.map((c) => c[2])).toEqual([["93.184.216.34"], ["8.8.8.8"]]);
  });

  it("does not retry when the fresh lookup returns the same addresses", async () => {
    answer("93.184.216.34");
    pinned.mockRejectedValue(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }));
    await expect(guardedFetch(`https://${name()}/`)).rejects.toThrow("fetch failed");
    expect(pinned).toHaveBeenCalledTimes(1);
  });

  it("reads the codes of an AggregateError's attempts", async () => {
    const h = name();
    lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]);
    const agg = new TypeError("fetch failed", { cause: new AggregateError([Object.assign(new Error("a"), { code: "ETIMEDOUT" })]) });
    pinned.mockRejectedValueOnce(agg).mockResolvedValueOnce(new Response("ok"));
    expect((await guardedFetch(`https://${h}/`)).res.status).toBe(200);
  });

  it("does not retry other errors", async () => {
    answer("93.184.216.34");
    pinned.mockRejectedValue(new Error("weird"));
    await expect(guardedFetch(`https://${name()}/`)).rejects.toThrow("weird");
    expect(pinned).toHaveBeenCalledTimes(1);
  });
});
