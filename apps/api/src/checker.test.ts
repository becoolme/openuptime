import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, runCheck, type CheckInput } from "./checker";
import { configureNetGuard } from "./netguard";

// these tests talk to servers on 127.0.0.1; the guard has its own tests in netguard.test.ts
beforeAll(() => configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" }));
afterAll(() => configureNetGuard({}));

describe("http keyword checks", () => {
  const server = createServer((req, res) => {
    if (req.url === "/echo") return res.end(JSON.stringify(req.headers["x-token"] ?? ""));
    res.end("<h1>hello world</h1>");
  });
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => void server.close());

  const check = (over: Partial<CheckInput> & { path?: string }) =>
    runCheck({ type: "http", target: base + (over.path ?? "/"), method: "GET", expectedStatus: 200, timeoutMs: 3000, ...over });

  it("passes when the keyword is present", async () => expect((await check({ keyword: "hello" })).ok).toBe(true));
  it("fails when the keyword is missing", async () => {
    const r = await check({ keyword: "goodbye" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });
  it("supports absent mode", async () => {
    expect((await check({ keyword: "hello", keywordMode: "absent" })).ok).toBe(false);
    expect((await check({ keyword: "goodbye", keywordMode: "absent" })).ok).toBe(true);
  });
  it("sends custom headers", async () => {
    const r = await check({ path: "/echo", keyword: "secret-1", headers: { "x-token": "secret-1" } });
    expect(r.ok).toBe(true);
  });
});

describe("database probes", () => {
  type Handler = (s: import("node:net").Socket) => void;
  const servers: import("node:net").Server[] = [];
  async function fake(h: Handler) {
    const { createServer: tcp } = await import("node:net");
    const s = tcp(h);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    servers.push(s);
    return `127.0.0.1:${(s.address() as AddressInfo).port}`;
  }
  afterAll(() => servers.forEach((s) => s.close()));
  const probe = (type: CheckInput["type"], target: string) =>
    runCheck({ type, target, method: "GET", expectedStatus: 200, timeoutMs: 2000 });

  it("tcp: leaves no timeout timer behind after a quick answer", async () => {
    const t = await fake((s) => s.end());
    const before = (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    expect((await probe("tcp", t)).ok).toBe(true);
    const after = (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    expect(after).toBeLessThanOrEqual(before);
  });
  it("postgres: answers the SSLRequest", async () => {
    const t = await fake((s) => s.once("data", () => s.end("N")));
    expect((await probe("postgres", t)).ok).toBe(true);
  });
  it("postgres: rejects a server that speaks something else", async () => {
    const t = await fake((s) => s.once("data", () => s.end("HTTP/1.1 400 Bad Request\r\n\r\n")));
    expect((await probe("postgres", t)).ok).toBe(false);
  });
  it("mysql: accepts a protocol 10 handshake", async () => {
    const t = await fake((s) => s.write(Buffer.from([0x20, 0, 0, 0, 0x0a, 0x38, 0x2e, 0x30, 0])));
    expect((await probe("mysql", t)).ok).toBe(true);
  });
  it("mysql: reports an error packet", async () => {
    const t = await fake((s) => s.write(Buffer.concat([Buffer.from([0x20, 0, 0, 0, 0xff, 0x6a, 0x04, 0x23]), Buffer.from("Host is blocked")])));
    const r = await probe("mysql", t);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/blocked/);
  });
  it("redis: PONG and NOAUTH are up, anything else is down", async () => {
    const pong = await fake((s) => s.once("data", () => s.write("+PONG\r\n")));
    const noauth = await fake((s) => s.once("data", () => s.write("-NOAUTH Authentication required.\r\n")));
    const bad = await fake((s) => s.once("data", () => s.write("-DENIED protected mode\r\n")));
    expect((await probe("redis", pong)).ok).toBe(true);
    expect((await probe("redis", noauth)).ok).toBe(true);
    expect((await probe("redis", bad)).ok).toBe(false);
  });
  it("fails when nothing listens", async () => {
    expect((await probe("redis", "127.0.0.1:1")).ok).toBe(false);
  });
});

describe("response body budget", () => {
  const server = createServer((req, res) => {
    if (req.url === "/big") {
      // 3 MB, with the keyword only after the first megabyte
      res.write("a".repeat(MAX_BODY_BYTES));
      res.end("b".repeat(2_000_000) + "needle");
      return;
    }
    if (req.url === "/edge") return res.end("x".repeat(MAX_BODY_BYTES - 6) + "needle");
    res.end("x");
  });
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => void server.close());
  const check = (path: string, keyword: string) => runCheck({ type: "http", target: base + path, method: "GET", expectedStatus: 200, timeoutMs: 3000, keyword });

  it("does not read past the budget when looking for a keyword", async () => {
    const r = await check("/big", "needle");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });
  it("finds a keyword that ends exactly at the budget", async () => expect((await check("/edge", "needle")).ok).toBe(true));
});
