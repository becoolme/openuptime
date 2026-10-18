import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { pinnedFetch } from "./pinnedfetch";

describe("pinnedFetch", () => {
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));
  const serve = async (handler: Parameters<typeof createServer>[1]) => {
    const s = createServer(handler);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return (s.address() as AddressInfo).port;
  };

  it("dials the pinned address while keeping the name in the URL and Host header", async () => {
    const port = await serve((req, res) => res.end(JSON.stringify({ host: req.headers.host, url: req.url, enc: req.headers["accept-encoding"], x: req.headers["x-a"] })));
    // "pinned.test" does not resolve anywhere: reaching the server proves the address was used, not the name
    const res = await pinnedFetch(`http://pinned.test:${port}/path?q=1`, { headers: { "x-a": "b" }, signal: AbortSignal.timeout(3000) }, ["127.0.0.1"]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ host: `pinned.test:${port}`, url: "/path?q=1", enc: "identity", x: "b" });
  });

  it("always asks for an uncompressed body, whatever the caller says, and decodes one anyway", async () => {
    const seen: (string | undefined)[] = [];
    const encoders: Record<string, (b: Buffer) => Buffer> = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync };
    for (const [enc, fn] of Object.entries(encoders)) {
      const port = await serve((req, res) => {
        seen.push(req.headers["accept-encoding"] as string | undefined);
        res.writeHead(200, { "content-encoding": enc, "content-type": "text/plain" });
        res.end(fn(Buffer.from(`hello ${enc}`)));
      });
      const res = await pinnedFetch(`http://pinned.test:${port}/`, { headers: { "accept-encoding": "gzip, br" } }, ["127.0.0.1"]);
      expect(await res.text()).toBe(`hello ${enc}`);
      expect(res.headers.get("content-encoding")).toBeNull();
    }
    expect(seen).toEqual(["identity", "identity", "identity"]);
  });

  it("sends a string body and reads status and repeated headers", async () => {
    const port = await serve((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        res.writeHead(201, { "set-cookie": ["a=1", "b=2"], "content-type": "text/plain" });
        res.end(`${req.method}:${b}`);
      });
    });
    const res = await pinnedFetch(`http://pinned.test:${port}/`, { method: "POST", body: '{"a":1}' }, ["127.0.0.1"]);
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('POST:{"a":1}');
    expect(res.headers.getSetCookie?.() ?? []).toEqual(["a=1", "b=2"]);
  });

  it("answers HEAD and 304 without a body", async () => {
    const port = await serve((_q, res) => res.writeHead(304).end());
    const res = await pinnedFetch(`http://pinned.test:${port}/`, { method: "GET" }, ["127.0.0.1"]);
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
  });

  it("fails like fetch does: TypeError with the cause, and the abort reason on timeout", async () => {
    const closed = await serve(() => {});
    servers.pop()!.close();
    await expect(pinnedFetch(`http://pinned.test:${closed}/`, {}, ["127.0.0.1"])).rejects.toMatchObject({ message: "fetch failed", cause: { code: "ECONNREFUSED" } });
    const slow = await serve(() => {});
    await expect(pinnedFetch(`http://pinned.test:${slow}/`, { signal: AbortSignal.timeout(100) }, ["127.0.0.1"])).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
