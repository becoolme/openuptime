import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCheck } from "./checker";
import { networkLevelError, proberOnline, proberSideError, resetSelfCheck } from "./selfcheck";

beforeEach(resetSelfCheck);
afterEach(() => vi.unstubAllGlobals());

const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

describe("proberOnline", () => {
  it("is online as soon as one reference URL answers, whatever the status", async () => {
    const seen: string[] = [];
    const fetch = async (url: string) => {
      seen.push(url);
      if (seen.length === 1) throw refused;
      return new Response(null, { status: 204 });
    };
    expect(await proberOnline({ urls: ["https://a.test/", "https://b.test/", "https://c.test/"], fetch })).toBe(true);
    expect(seen).toEqual(["https://a.test/", "https://b.test/"]);
  });

  it("is offline when none answers", async () => {
    const fetch = vi.fn(async () => { throw refused; });
    expect(await proberOnline({ urls: ["https://a.test/", "https://b.test/"], fetch })).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shares one verdict between concurrent callers, and for a few seconds afterwards", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    const opts = { urls: ["https://a.test/"], fetch, now: () => 1000 };
    const all = await Promise.all([proberOnline(opts), proberOnline(opts), proberOnline(opts)]);
    expect(all).toEqual([true, true, true]);
    await proberOnline({ ...opts, now: () => 3000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    await proberOnline({ ...opts, now: () => 9000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("error classification", () => {
  it("recognises errors that only this machine's network can cause", () => {
    expect(proberSideError(Object.assign(new Error("x"), { code: "EADDRNOTAVAIL" }))).toBe(true);
    expect(proberSideError(new TypeError("fetch failed", { cause: { code: "ENETUNREACH" } }))).toBe(true);
    const both = Object.assign(new AggregateError([{ code: "ENETUNREACH" }, { code: "EADDRNOTAVAIL" }]), {});
    expect(proberSideError(both)).toBe(true);
  });
  it("leaves target-side errors alone", () => {
    expect(proberSideError(refused)).toBe(false);
    expect(proberSideError(new Error("no code"))).toBe(false);
    expect(proberSideError(new AggregateError([{ code: "ENETUNREACH" }, { code: "ETIMEDOUT" }]))).toBe(false);
  });
  it("does not treat a refused target as a network failure", () => {
    expect(networkLevelError(Object.assign(new Error("x"), { name: "BlockedTarget" }))).toBe(false);
    expect(networkLevelError(refused)).toBe(true);
  });
});

describe("runCheck with a prober that is offline", () => {
  const http = () => runCheck({ type: "http", target: "https://93.184.216.34/", method: "GET", expectedStatus: 200, timeoutMs: 2000 });

  it("discards a network failure when no reference URL answers", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed", { cause: refused }); });
    const r = await http();
    expect(r).toMatchObject({ ok: false, inconclusive: true });
  });

  it("records the failure when the prober is online", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).startsWith("https://93.184.216.34")) throw new TypeError("fetch failed", { cause: refused });
      return new Response(null, { status: 204 });
    });
    const r = await http();
    expect(r.ok).toBe(false);
    expect(r.inconclusive).toBeUndefined();
    expect(r.error).toBe("ECONNREFUSED");
  });

  it("discards at once an error caused by the prober's own missing route", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("fetch failed", { cause: { code: "EADDRNOTAVAIL" } }); });
    vi.stubGlobal("fetch", fetch);
    expect((await http()).inconclusive).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1); // no reference lookups needed
  });

  it("never second-guesses an HTTP answer", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 503 }));
    const r = await http();
    expect(r).toMatchObject({ ok: false, statusCode: 503 });
    expect(r.inconclusive).toBeUndefined();
  });
});
