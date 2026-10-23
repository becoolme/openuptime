import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runCheck } from "./checker";
import { addressBlocked, configureNetGuard, guardedFetch, hostBlocked, hostPort, targetProblem } from "./netguard";

afterEach(() => configureNetGuard({}));

describe("addressBlocked", () => {
  it("refuses private, loopback, link-local and metadata IPv4", () => {
    for (const ip of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "127.9.9.9", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "198.18.0.1", "224.0.0.1", "255.255.255.255"]) {
      expect([ip, addressBlocked(ip)]).toEqual([ip, true]);
    }
  });
  it("allows public IPv4, including neighbours of private ranges", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "169.253.0.1"]) {
      expect([ip, addressBlocked(ip)]).toEqual([ip, false]);
    }
  });
  it("refuses private IPv6 and IPv4 hidden inside IPv6", () => {
    for (const ip of ["::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "::127.0.0.1"]) {
      expect([ip, addressBlocked(ip)]).toEqual([ip, true]);
    }
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) expect([ip, addressBlocked(ip)]).toEqual([ip, false]);
  });
});

describe("hostBlocked", () => {
  it("refuses internal names and alternative spellings of loopback", () => {
    for (const h of ["localhost", "LOCALHOST", "app.localhost", "printer.local", "db.internal", "metadata.google.internal", "postgres", "redis", "2130706433", "0x7f.0.0.1", "127.1", "[::1]", "localhost.", "169.254.169.254"]) {
      expect([h, hostBlocked(h)]).toEqual([h, true]);
    }
  });
  it("lets public names and addresses through", () => {
    for (const h of ["example.com", "status.example.co.uk", "1.1.1.1", "[2606:4700:4700::1111]", "my-app.fly.dev"]) expect([h, hostBlocked(h)]).toEqual([h, false]);
  });
});

describe("hostPort", () => {
  it("parses host, host:port, [v6]:port and scheme://host:port", () => {
    expect(hostPort("db.example.com:5432", 0)).toEqual({ hostname: "db.example.com", port: 5432 });
    expect(hostPort("db.example.com", 5432)).toEqual({ hostname: "db.example.com", port: 5432 });
    expect(hostPort("postgres://db.example.com", 5432)).toEqual({ hostname: "db.example.com", port: 5432 });
    expect(hostPort("[::1]:80", 0)).toEqual({ hostname: "::1", port: 80 });
    expect(hostPort("db.example.com", 0)).toBeNull();
    expect(hostPort("host:99999", 0)).toBeNull();
  });
});

describe("targetProblem", () => {
  it("refuses private targets by type, and only http(s) URLs", async () => {
    expect(await targetProblem("http", "http://169.254.169.254/latest/meta-data/")).toMatch(/private or internal/);
    expect(await targetProblem("http", "http://user@127.0.0.1:8080/")).toMatch(/private or internal/);
    expect(await targetProblem("http", "http://localhost:3000")).toMatch(/private or internal/);
    expect(await targetProblem("http", "file:///etc/passwd")).toMatch(/http/);
    expect(await targetProblem("tcp", "10.0.0.5:22")).toMatch(/private or internal/);
    expect(await targetProblem("postgres", "postgres")).toMatch(/private or internal/);
    expect(await targetProblem("redis", "[::1]:6379")).toMatch(/private or internal/);
    expect(await targetProblem("http", "https://1.1.1.1/")).toBeNull();
    expect(await targetProblem("dns", "localhost")).toBeNull();
    expect(await targetProblem("heartbeat", "")).toBeNull();
  });
  it("allows everything with ALLOW_PRIVATE_TARGETS=true", async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    expect(await targetProblem("http", "http://127.0.0.1:8080")).toBeNull();
    expect(await targetProblem("tcp", "10.0.0.5:22")).toBeNull();
  });
});

describe("checks and redirects", () => {
  const servers: Server[] = [];
  const serve = async (handler: Parameters<typeof createServer>[1]) => {
    const s = createServer(handler);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };
  afterAll(() => servers.forEach((s) => s.close()));

  const http = (target: string) => runCheck({ type: "http", target, method: "GET", expectedStatus: 200, timeoutMs: 3000 });

  it("refuses a loopback target by default, with a hint, and reaches it when allowed", async () => {
    const base = await serve((_q, res) => res.end("ok"));
    const refused = await http(base);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/ALLOW_PRIVATE_TARGETS/);
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    expect((await http(base)).ok).toBe(true);
  });

  it("refuses non-http database targets on private addresses", async () => {
    for (const type of ["tcp", "postgres", "mysql", "redis"] as const) {
      const r = await runCheck({ type, target: "127.0.0.1:1", method: "GET", expectedStatus: 200, timeoutMs: 1000 });
      expect([type, r.ok, r.error]).toEqual([type, false, expect.stringMatching(/private or internal/)]);
    }
  });

  it("hands back the first response untouched when told not to follow", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return new Response(null, { status: 301, headers: { location: "https://93.184.216.34/next" } });
    });
    try {
      const { res, url } = await guardedFetch("https://93.184.216.34/start", {}, { follow: false });
      expect(res.status).toBe(301);
      expect(url).toBe("https://93.184.216.34/start");
      expect(seen).toEqual(["https://93.184.216.34/start"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("checks every redirect hop, not just the first", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    });
    try {
      await expect(guardedFetch("https://93.184.216.34/start")).rejects.toThrow(/private or internal/);
      expect(seen).toEqual(["https://93.184.216.34/start"]); // the metadata address was never requested
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("drops credentials when a redirect leaves the origin, and follows 307 with the same method", async () => {
    const calls: { url: string; method: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method as string, auth: new Headers(init.headers).get("authorization") });
      return calls.length === 1
        ? new Response(null, { status: 307, headers: { location: "https://8.8.8.8/next" } })
        : new Response("ok", { status: 200 });
    });
    try {
      const { res, url } = await guardedFetch("https://1.1.1.1/", { method: "POST", body: "{}", headers: { authorization: "Bearer x" } });
      expect(res.status).toBe(200);
      expect(url).toBe("https://8.8.8.8/next");
      expect(calls).toEqual([
        { url: "https://1.1.1.1/", method: "POST", auth: "Bearer x" },
        { url: "https://8.8.8.8/next", method: "POST", auth: null },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
