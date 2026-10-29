import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runCheck } from "./checker";
import { configureNetGuard, guardedFetch } from "./netguard";
import { requestBodyProblem } from "./http-request";
import { configureProbes, runInRegion } from "./probes";
import { verifyProbe, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./probe-protocol";

describe("HTTP request bodies", () => {
  const lengths: (string | undefined)[] = [];
  const seen: { method: string; body: string; contentType?: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    lengths.push(req.headers["content-length"]);
    seen.push({ method: req.method!, body, contentType: req.headers["content-type"] });
    if (req.url === "/redirect") { res.writeHead(307, { location: "/echo" }); res.end(); }
    else if (req.url === "/get") { res.writeHead(303, { location: "/echo" }); res.end(); }
    else res.end("ok");
  });
  let base = "";
  beforeAll(async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); configureNetGuard({}); });
  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("sends %s payload without rewriting it", async (method) => {
    const requestBody = '{"text":"你好"}';
    expect(await runCheck({ type: "http", target: base, method, requestBody, headers: { "content-type": "application/json" }, expectedStatus: 200, timeoutMs: 1000 })).toMatchObject({ ok: true });
    expect(seen.at(-1)).toEqual({ method, body: requestBody, contentType: "application/json" });
  });
  it("lets the runtime calculate byte lengths instead of trusting custom Content-Length", async () => {
    expect(await runCheck({ type: "http", target: base, method: "POST", requestBody: "你好", headers: { "Content-Length": "1" }, expectedStatus: 200, timeoutMs: 1000 })).toMatchObject({ ok: true });
    expect(seen.at(-1)?.body).toBe("你好");
    expect(lengths.at(-1)).toBe("6");
    expect(await runCheck({ type: "http", target: base, method: "GET", headers: { "content-length": "99" }, expectedStatus: 200, timeoutMs: 1000 })).toMatchObject({ ok: true });
    expect(lengths.at(-1)).not.toBe("99");
  });
  it("preserves bodies for same-origin 307 and clears body headers for 303", async () => {
    const input = { type: "http" as const, method: "POST", requestBody: "a=1", headers: { "content-type": "application/x-www-form-urlencoded" }, expectedStatus: 200, timeoutMs: 1000 };
    expect(await runCheck({ ...input, target: base + "/redirect" })).toMatchObject({ ok: true });
    expect(seen.at(-1)).toEqual({ method: "POST", body: "a=1", contentType: "application/x-www-form-urlencoded" });
    expect(await runCheck({ ...input, target: base + "/get" })).toMatchObject({ ok: true });
    expect(seen.at(-1)).toEqual({ method: "GET", body: "", contentType: undefined });
  });
  it("rejects incompatible methods and bounds UTF-8 bytes", () => {
    expect(requestBodyProblem({ type: "http", method: "GET", requestBody: "x" })).toMatch(/GET/);
    expect(requestBodyProblem({ type: "tcp", method: "POST", requestBody: "x" })).toMatch(/HTTP/);
    expect(requestBodyProblem({ type: "http", method: "POST", requestBody: "你".repeat(5462) })).toMatch(/16384/);
    expect(requestBodyProblem({ type: "http", method: "POST", requestBody: "x".repeat(16384) })).toBeNull();
  });
  it("never forwards a body across origins", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 307, headers: { location: "https://8.8.8.8/" } }));
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(guardedFetch("https://1.1.1.1/", { method: "POST", body: "secret" }, { protectBody: true })).rejects.toThrow(/Cross-origin/);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it("does not POST to old probes, and signs the complete body for upgraded probes", async () => {
    configureProbes({ PROBE_REGIONS: '{"test":"https://probe.example.com/"}', PROBE_SECRET: "fixture" });
    const input = { type: "http" as const, target: "https://example.com/", method: "POST", requestBody: "secret", expectedStatus: 200, timeoutMs: 1000 };
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    try {
      expect(await runInRegion("test", input)).toMatchObject({ unreachable: expect.stringContaining("upgrade required") });
      expect(fetch).toHaveBeenCalledTimes(1);
      fetch.mockImplementation(async (_url, init) => {
        if (init?.method !== "POST") return Response.json({ capabilities: ["http-request-body-v1"] });
        const headers = new Headers(init.headers);
        expect(JSON.parse(init.body as string).requestBody).toBe("secret");
        expect(await verifyProbe("fixture", { timestamp: headers.get(TIMESTAMP_HEADER), signature: headers.get(SIGNATURE_HEADER), body: init.body as string })).toBe(true);
        return Response.json({ ok: true });
      });
      expect(await runInRegion("test", input)).toMatchObject({ outcome: { ok: true } });
      // A successful preflight must not authorize a later request after a probe rollback.
      fetch.mockImplementation(async () => Response.json({ ok: true }));
      const beforeRollback = fetch.mock.calls.length;
      expect(await runInRegion("test", input)).toMatchObject({ unreachable: expect.stringContaining("upgrade required") });
      expect(fetch).toHaveBeenCalledTimes(beforeRollback + 1);

    } finally { vi.unstubAllGlobals(); configureProbes({}); }
  });
});
