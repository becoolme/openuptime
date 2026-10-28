import type { RdapCacheEntry, Repo } from "@openuptime/repo";
import { afterEach, describe, expect, it, vi } from "vitest";
import { domainCheck, expiration, registryUrl, DOMAIN_TTL_MS, UNKNOWN_TTL_MS } from "./domain-expiry";
import { domainName } from "./domain-name";
import { guardedFetch } from "./netguard";
vi.mock("./netguard", () => ({ guardedFetch: vi.fn() }));
const bootstrap = { services: [[["com"], ["https://registry.example/rdap/"]]] };
const record = (days = 60) => ({ objectClassName: "domain", ldhName: "example.com", events: [{ eventAction: "expiration", eventDate: new Date(Date.now() + days * 864e5).toISOString() }] });
function cache() {
  const values = new Map<string, RdapCacheEntry>();
  const repo = { cachedRdap: async (key: string, load: () => Promise<RdapCacheEntry>) => {
    const hit = values.get(key); if (hit && hit.expiresAt.getTime() > Date.now()) return hit;
    const value = await load(); values.set(key, value); return value;
  } } as Repo;
  return { repo, values };
}
function response(value: unknown, status = 200) { vi.mocked(guardedFetch).mockResolvedValueOnce({ res: new Response(JSON.stringify(value), { status }), url: "https://registry.example" } as never); }
const input = { target: "example.com", timeoutMs: 1000 };
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });
describe("domain RDAP", () => {
  it("normalizes IDNA but never guesses a registered domain", () => {
    expect(domainName("BÜCHER.de.")).toBe("xn--bcher-kva.de");
    expect(domainName("www.example.com")).toBe("www.example.com");
    for (const value of ["https://example.com", "127.0.0.1", "localhost", "example.com/path", "a@b.com"]) expect(() => domainName(value)).toThrow();
  });
  it("chooses the longest label suffix and refuses unsafe endpoint schemes", () => {
    expect(registryUrl({ services: [...bootstrap.services, [["co.com"], ["http://bad", "https://specific.example/"]]] }, "x.co.com")).toBe("https://specific.example/domain/x.co.com");
    for (const url of ["http://registry.example", "https://user:pass@registry.example", "https://registry.example:8443"]) expect(() => registryUrl({ services: [[["com"], [url]]] }, "example.com")).toThrow(/No HTTPS/);
    expect(() => registryUrl(bootstrap, "example.unsupported")).toThrow(/No HTTPS/);
  });
  it("requires the requested domain and a usable top-level expiration event", () => {
    expect(() => expiration({ ...record(), ldhName: "other.com" }, "example.com")).toThrow(/requested/);
    for (const events of [[], [{ eventAction: "registration", eventDate: "2030-01-01T00:00:00Z" }], [{ eventAction: "expiration", eventDate: "tomorrow" }]]) expect(() => expiration({ ...record(), events }, "example.com")).toThrow(/did not publish/);
  });
  it("caches successful data, reevaluates thresholds and uses hardened network options", async () => {
    const { repo, values } = cache(); response(bootstrap); response(record(20));
    expect(await domainCheck(repo, { ...input, domainExpiryWarnDays: 10 })).toMatchObject({ ok: true, domainExpiry: { state: "valid" } });
    expect(await domainCheck(repo, input)).toMatchObject({ ok: false, domainExpiry: { state: "expiring" } });
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(guardedFetch).mock.calls.every(([, init, options]) => init?.signal instanceof AbortSignal && options?.follow === false && options.publicOnly)).toBe(true);
    expect(values.get("domain:v1:example.com")!.expiresAt.getTime() - Date.now()).toBeCloseTo(DOMAIN_TTL_MS, -2);
  });
  it.each([429, 302, 503])("reports HTTP %s as unknown and caches the failure briefly", async status => {
    const { repo, values } = cache(); response(bootstrap); response({}, status);
    expect(await domainCheck(repo, input)).toMatchObject({ ok: false, error: expect.stringContaining(String(status)), domainExpiry: { state: "unknown", expiresAt: null } });
    await domainCheck(repo, input); expect(guardedFetch).toHaveBeenCalledTimes(2);
    expect(values.get("domain:v1:example.com")!.expiresAt.getTime() - Date.now()).toBeCloseTo(UNKNOWN_TTL_MS, -2);
  });
  it("reports missing events and unsupported suffixes as unknown", async () => {
    response(bootstrap); response({ ...record(), events: [] });
    expect(await domainCheck(cache().repo, input)).toMatchObject({ ok: false, domainExpiry: { state: "unknown" } });
    response(bootstrap);
    expect(await domainCheck(cache().repo, { ...input, target: "example.unsupported" })).toMatchObject({ ok: false, error: expect.stringContaining("No HTTPS") });
  });
  it("never falls back to expired cached healthy data when the refresh fails", async () => {
    vi.useFakeTimers(); const { repo } = cache(); response(bootstrap); response(record());
    expect((await domainCheck(repo, input)).ok).toBe(true);
    vi.advanceTimersByTime(DOMAIN_TTL_MS + 1); response({}, 429);
    expect(await domainCheck(repo, input)).toMatchObject({ ok: false, domainExpiry: { state: "unknown", expiresAt: null } });
  });
  it("distinguishes passed dates from unknown, and bounds bodies and timeout failures", async () => {
    response(bootstrap); response(record(-1));
    expect(await domainCheck(cache().repo, input)).toMatchObject({ ok: false, domainExpiry: { state: "expired" }, error: expect.stringContaining("date has passed") });
    response(bootstrap); response("x".repeat(1024 * 1024));
    expect(await domainCheck(cache().repo, input)).toMatchObject({ ok: false, error: expect.stringContaining("1 MiB") });
    response(bootstrap); vi.mocked(guardedFetch).mockRejectedValueOnce(new Error("operation timed out"));
    expect(await domainCheck(cache().repo, input)).toMatchObject({ ok: false, domainExpiry: { state: "unknown" }, error: expect.stringContaining("timed out") });
  });
});
