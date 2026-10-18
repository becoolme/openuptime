import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.fn();
const pinned = vi.fn();
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("./pinnedfetch", () => ({ pinnedFetch: pinned }));

const { configureNetGuard, guardAddresses, guardHost, guardedFetch, targetProblem } = await import("./netguard");

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
