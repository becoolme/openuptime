import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureNetGuard } from "../../api/src/netguard";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signProbe } from "../../api/src/probe-protocol";
import { MAX_BODY_BYTES } from "./handler";
import { createProbeServer } from "./node-server";

const secret = "a-long-enough-shared-secret";
let probe: Server;
let target: Server;
let base = "";
let targetUrl = "";

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));

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
    expect((await post({ type: "http", target: targetUrl, headers: { pad: "x".repeat(MAX_BODY_BYTES + 1) } })).status).toBe(413);
  });
});
