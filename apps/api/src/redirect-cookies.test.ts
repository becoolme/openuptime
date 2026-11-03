import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCheck } from "./checker";
import { configureNetGuard } from "./netguard";

describe("cookies across redirects", () => {
  const seen: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { location: "/check", "set-cookie": ["session=abc; Path=/; HttpOnly", "pref=x; Secure", "old=1; Max-Age=0"] });
      return res.end();
    }
    if (req.url === "/loop") {
      // sets the cookie, then sends the client back until it has it
      res.writeHead(302, { location: req.headers.cookie?.includes("seen=1") ? "/done" : "/loop", "set-cookie": "seen=1" });
      return res.end();
    }
    seen.push(req.headers.cookie);
    res.end("ok");
  });
  let base = "";
  beforeAll(async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); configureNetGuard({}); });
  const run = (path: string, headers?: Record<string, string>) => runCheck({ type: "http", target: base + path, method: "GET", expectedStatus: 200, timeoutMs: 3000, headers });

  it("sends a cookie set by a redirect to the next hop on the same host, but not a Secure one over http", async () => {
    expect(await run("/start", { cookie: "mine=1" })).toMatchObject({ ok: true, statusCode: 200 });
    expect(seen.at(-1)).toBe("mine=1; session=abc");
  });
  it("lets a redirect that waits for its own cookie finish", async () => {
    expect(await run("/loop")).toMatchObject({ ok: true, statusCode: 200 });
  });
});
