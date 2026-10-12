import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureNetGuard } from "../../api/src/netguard";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signProbe } from "../../api/src/probe-protocol";
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
    target = createServer((_req, res) => res.end("up"));
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
    expect(await (await fetch(base)).json()).toEqual({ ok: true, region: "test-region" });
  });

  it("runs a signed check and returns the outcome", async () => {
    const res = await post({ type: "http", target: targetUrl, expectedStatus: 200, timeoutMs: 3000 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, statusCode: 200 });
  });

  it("refuses an unsigned request and an oversized body", async () => {
    expect((await fetch(base, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await post({ type: "http", target: targetUrl, headers: { pad: "x".repeat(40_000) } })).status).toBe(413);
  });
});
