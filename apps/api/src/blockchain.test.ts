import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCheck, type CheckInput } from "./checker";
import { configureNetGuard, targetProblem } from "./netguard";

let reply: unknown = null;
let status = 200;
let received: { method?: string; body?: any; token?: string } = {};
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  received = { method: req.method, body: JSON.parse(Buffer.concat(chunks).toString()), token: req.headers.authorization };
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(reply));
});
let target: string;
beforeAll(async () => {
  configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); configureNetGuard({}); });
const check = (type: "evm" | "solana") => runCheck({ type, target, method: "GET", expectedStatus: 200, timeoutMs: 2000, headers: { authorization: "Bearer test" } } satisfies CheckInput);
const result = (value: unknown) => ({ jsonrpc: "2.0", id: 1, result: value });

describe("blockchain RPC checks", () => {
  it("sends authenticated EVM sync requests and rejects syncing", async () => {
    status = 200; reply = result(false);
    expect((await check("evm")).ok).toBe(true);
    expect(received).toMatchObject({ method: "POST", token: "Bearer test", body: { method: "eth_syncing", params: [] } });
    reply = result({ currentBlock: "0x1", highestBlock: "0x2" });
    expect(await check("evm")).toMatchObject({ ok: false, error: "EVM node is syncing" });
  });
  it("checks Solana health and fails on RPC errors", async () => {
    reply = result("ok");
    expect((await check("solana")).ok).toBe(true);
    expect(received.body.method).toBe("getHealth");
    reply = { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "unhealthy" } };
    expect((await check("solana")).ok).toBe(false);
  });
  it("rejects malformed envelopes, wrong result types and HTTP errors", async () => {
    for (const value of [{ jsonrpc: "2.0", id: 2, result: false }, result("false"), { ...result(false), error: {} }]) {
      reply = value; expect((await check("evm")).ok).toBe(false);
    }
    status = 503; expect(await check("evm")).toMatchObject({ ok: false, statusCode: 503 }); status = 200;
  });
  it("blocks private RPC targets by default", async () => {
    configureNetGuard({});
    expect(await targetProblem("evm", target)).toMatch(/private/i);
    expect(await targetProblem("solana", target)).toMatch(/private/i);
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
  });
});
