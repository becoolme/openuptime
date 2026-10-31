import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureNetGuard } from "../../api/src/netguard";
import { ENVELOPE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, signProbe, signProbeEnvelope } from "../../api/src/probe-protocol";
import { MAX_BODY_BYTES, SMALL_BODY_BYTES } from "./handler";
import { createProbeServer } from "./node-server";

const secret = "a-long-enough-shared-secret";
let probe: Server;
let target: Server;
let base = "";
let targetUrl = "";

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));

/**
 * Status of a POST whose body the server may refuse before reading. fetch() reports that as a failed write, so this
 * resolves on the response and ignores the reset that follows.
 */
function statusOf(text: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = request(base, { method: "POST", headers: { "content-length": String(Buffer.byteLength(text)), ...headers } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", (e) => setTimeout(() => reject(e), 100));
    req.end(text);
  });
}

async function signedHeaders(text: string) {
  const ts = Math.floor(Date.now() / 1000);
  return { "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: await signProbe(secret, ts, text) };
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  return fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: await signProbe(secret, ts, text), ...headers },
    body: text,
  });
}

describe("probe as a Node server", () => {
  beforeAll(async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    target = createServer(async (req, res) => {
      if (req.url !== "/body") return res.end("up");
      let body = "";
      for await (const chunk of req) body += chunk;
      res.statusCode = req.method === "PATCH" && body === '{"message":"你好"}' && req.headers["content-type"] === "application/json" ? 200 : 400;
      res.end("up");
    });
    probe = createProbeServer({ secret, region: "test-region" });
    targetUrl = `http://127.0.0.1:${await listen(target)}/`;
    base = `http://127.0.0.1:${await listen(probe)}/`;
  });
  afterAll(() => {
    configureNetGuard({});
    probe.close();
    target.close();
  });

  it("answers the health check with its region", async () => {
    expect(await (await fetch(base)).json()).toMatchObject({ ok: true, region: "test-region", capabilities: ["http-request-body-v1", "mcp-monitor-v2"] });
  });

  it("runs a signed check and returns the outcome", async () => {
    const res = await post({ type: "http", target: targetUrl, expectedStatus: 200, timeoutMs: 3000 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, statusCode: 200 });
  });

  it("carries a signed request body through to the target", async () => {
    const res = await post({ type: "http", target: targetUrl + "body", method: "PATCH", requestBody: '{"message":"你好"}', headers: { "content-type": "application/json" }, expectedStatus: 200, timeoutMs: 3000 });
    expect(await res.json()).toMatchObject({ ok: true, statusCode: 200 });
  });

  it("refuses an unsigned request and an oversized body", async () => {
    expect((await fetch(base, { method: "POST", body: "{}" })).status).toBe(401);
    const over = JSON.stringify({ type: "http", target: targetUrl, headers: { pad: "x".repeat(MAX_BODY_BYTES + 1) } });
    expect(await statusOf(over, await signedHeaders(over))).toBe(413);
    // unsigned and large: refused from the headers, before the body is buffered
    expect(await statusOf("x".repeat(MAX_BODY_BYTES))).toBe(401);
    // signed, but nothing vouches for a large length: the small limit applies
    const large = JSON.stringify({ type: "http", target: targetUrl, headers: { pad: "x".repeat(SMALL_BODY_BYTES) } });
    expect(await statusOf(large, await signedHeaders(large))).toBe(413);
  });

  it("reads a large body only with a valid envelope, and only for an MCP check", async () => {
    const send = async (type: string) => {
      const text = JSON.stringify({ type, target: targetUrl, timeoutMs: 3000, headers: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`x-pad-${i}`, "p".repeat(2000)])) });
      const ts = Math.floor(Date.now() / 1000);
      return fetch(base, {
        method: "POST",
        headers: {
          "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: await signProbe(secret, ts, text),
          [ENVELOPE_HEADER]: await signProbeEnvelope(secret, ts, Buffer.byteLength(text)),
        },
        body: text,
      });
    };
    expect((await send("http")).status).toBe(413);
    const mcp = await send("mcp");
    expect(mcp.status).toBe(200);
    expect(await mcp.json()).toHaveProperty("ok");
  });
});
