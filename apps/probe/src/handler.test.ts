import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENVELOPE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, signProbe, signProbeEnvelope } from "../../api/src/probe-protocol";
import { configureNetGuard } from "../../api/src/netguard";
import { MAX_BODY_BYTES, SMALL_BODY_BYTES, handleProbe, parseCheck } from "./handler";

const secret = "s3cret";
const check = { type: "http", target: "https://example.com", method: "GET", expectedStatus: 200, timeoutMs: 2000, keyword: null, keywordMode: "contains", headers: {} };

async function signed(body: unknown, o: { secret?: string; ts?: number } = {}) {
  const text = JSON.stringify(body);
  const ts = o.ts ?? Math.floor(Date.now() / 1000);
  return new Request("http://probe/api/probe/eu-central", {
    method: "POST",
    headers: { [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: await signProbe(o.secret ?? secret, ts, text) },
    body: text,
  });
}

describe("probe handler", () => {
  it("answers a health GET without credentials", async () => {
    const res = await handleProbe(new Request("http://probe/"), { secret, region: "fra1" });
    expect(await res.json()).toMatchObject({ ok: true, region: "fra1", capabilities: ["http-request-body-v1", "mcp-monitor-v2"] });
  });

  it("is not an open proxy: unsigned, wrongly signed and stale requests are refused", async () => {
    const unsigned = await handleProbe(new Request("http://probe/", { method: "POST", body: JSON.stringify(check) }), { secret });
    expect(unsigned.status).toBe(401);
    expect((await handleProbe(await signed(check, { secret: "other" }), { secret })).status).toBe(401);
    expect((await handleProbe(await signed(check, { ts: Math.floor(Date.now() / 1000) - 600 }), { secret })).status).toBe(401);
  });

  it("refuses everything when no secret is configured", async () => {
    expect((await handleProbe(await signed(check), { secret: undefined })).status).toBe(503);
  });

  it("only runs the configured outbound monitor protocols", async () => {
    expect((await handleProbe(await signed({ ...check, type: "postgres", target: "postgres://u:p@db.example.com/x" }), { secret })).status).toBe(400);
    expect(parseCheck({ ...check, type: "websocket", target: "wss://example.com/socket", wsMessage: "ping" })).toMatchObject({ input: { type: "websocket", wsMessage: "ping" } });
    expect(parseCheck({ ...check, type: "websocket", target: "wss://example.com/socket" })).toMatchObject({ input: { wsMessage: null } });
    expect(parseCheck({ ...check, type: "websocket", wsMessage: 5 })).toHaveProperty("error");
    expect(parseCheck({ ...check, type: "websocket", wsMessage: "x".repeat(2001) })).toHaveProperty("error");
    expect(parseCheck({ ...check, timeoutMs: 999_999 })).toHaveProperty("error");
    expect(parseCheck({ ...check, headers: { a: 1 } })).toHaveProperty("error");
    expect(parseCheck({ ...check, expectedLocation: 5 })).toHaveProperty("error");
    expect(parseCheck({ ...check, expectedStatus: 301, expectedLocation: "/new" })).toMatchObject({ input: { expectedLocation: "/new" } });
  });

  it("accepts the remaining MCP deadline and centrally resolved bearer token, but never a refresh credential", () => {
    const input = { ...check, type: "mcp", timeoutMs: 100, headers: { Authorization: "Bearer " + "x".repeat(8192) }, mcpConfig: { requiredTools: [], schemaCheck: false, toolCall: null, oauth: null } };
    expect(parseCheck(input)).toHaveProperty("input");
    expect(parseCheck({ ...input, timeoutMs: 0 })).toHaveProperty("error");
    expect(parseCheck({ ...input, mcpConfig: { ...input.mcpConfig, oauth: { mode: "refresh_token", issuer: "https://auth.example", clientId: "id", refreshToken: "private-refresh" } } })).toHaveProperty("error");
  });

  it("validates HTTP body semantics before running a check", () => {
    expect(parseCheck({ ...check, method: "PATCH", requestBody: '{"ok":true}' })).toMatchObject({ input: { method: "PATCH", requestBody: '{"ok":true}' } });
    expect(parseCheck({ ...check, requestBody: "secret" })).toHaveProperty("error");
    expect(parseCheck({ ...check, method: "POST", requestBody: "你".repeat(5462) })).toHaveProperty("error");
    expect(parseCheck({ ...check, method: "POST", requestBody: 123 })).toHaveProperty("error");
    expect(parseCheck({ ...check, type: "tcp", method: "POST", requestBody: "secret" })).toHaveProperty("error");
  });

  it("will not be aimed at a private address", async () => {
    configureNetGuard({});
    const res = await handleProbe(await signed({ ...check, target: "http://169.254.169.254/latest/meta-data" }), { secret });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("target_not_allowed");
  });

  describe("body limits", () => {
    /** A request whose body is a stream that records how much of it the handler pulled. */
    function streamed(text: string, headers: Record<string, string>) {
      const bytes = new TextEncoder().encode(text);
      const read = { bytes: 0 };
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (offset >= bytes.length) return c.close();
          const chunk = bytes.subarray(offset, offset + 16 * 1024);
          offset += chunk.length; read.bytes += chunk.length;
          c.enqueue(chunk);
        },
      }, { highWaterMark: 0 });
      return { req: new Request("http://probe/", { method: "POST", headers, body, duplex: "half" } as RequestInit), read };
    }
    async function headersFor(text: string, o: { envelope?: boolean; length?: number } = {}) {
      const ts = Math.floor(Date.now() / 1000);
      const length = o.length ?? new TextEncoder().encode(text).byteLength;
      return {
        "content-length": String(length), [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: await signProbe(secret, ts, text),
        ...(o.envelope ? { [ENVELOPE_HEADER]: await signProbeEnvelope(secret, ts, length) } : {}),
      };
    }
    // ~80 KB of headers: over the small limit, valid for any check type
    const padded = (type: string) => JSON.stringify({ ...check, type, target: "http://169.254.169.254/mcp", headers: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`x-pad-${i}`, "p".repeat(2000)])) });

    it("refuses an unsigned or over-cap request without reading its body", async () => {
      const text = padded("mcp");
      const unsigned = streamed(text, { "content-length": String(text.length) });
      expect((await handleProbe(unsigned.req, { secret })).status).toBe(401);
      expect(unsigned.read.bytes).toBe(0);
      const huge = streamed(text, { ...(await headersFor(text, { envelope: true })), "content-length": String(MAX_BODY_BYTES + 1) });
      expect((await handleProbe(huge.req, { secret })).status).toBe(413);
      expect(huge.read.bytes).toBe(0);
    });

    it("keeps the small limit unless the scheduler signed the declared length", async () => {
      const text = padded("mcp");
      expect(text.length).toBeGreaterThan(SMALL_BODY_BYTES);
      const noEnvelope = streamed(text, await headersFor(text));
      expect((await handleProbe(noEnvelope.req, { secret })).status).toBe(413);
      expect(noEnvelope.read.bytes).toBe(0);
      const forged = streamed(text, { ...(await headersFor(text)), [ENVELOPE_HEADER]: "0".repeat(64) });
      expect((await handleProbe(forged.req, { secret })).status).toBe(413);
      expect(forged.read.bytes).toBe(0);
      // no declared length (chunked): read stops at the small limit
      const { "content-length": _, ...chunkedHeaders } = await headersFor(text);
      const chunked = streamed(text, chunkedHeaders);
      expect((await handleProbe(chunked.req, { secret })).status).toBe(413);
      expect(chunked.read.bytes).toBeLessThanOrEqual(SMALL_BODY_BYTES + 16 * 1024);
    });

    it("accepts a large signed MCP body and refuses a large body for any other check type", async () => {
      configureNetGuard({});
      const mcp = padded("mcp");
      const accepted = await handleProbe(streamed(mcp, await headersFor(mcp, { envelope: true })).req, { secret });
      // past every size and signature check; refused only for its private target
      expect(accepted.status).toBe(400);
      expect(((await accepted.json()) as { code: string }).code).toBe("target_not_allowed");
      const http = padded("http");
      expect((await handleProbe(streamed(http, await headersFor(http, { envelope: true })).req, { secret })).status).toBe(413);
      // a body longer than the length the envelope vouched for is cut off
      const short = streamed(mcp, await headersFor(mcp, { envelope: true, length: SMALL_BODY_BYTES + 1 }));
      expect((await handleProbe(short.req, { secret })).status).toBe(413);
    });
  });

  describe("running a check", () => {
    let server: Server;
    let url = "";
    beforeAll(async () => {
      // a loopback target is private; this suite opts in the way a self-hoster would
      configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
      server = createServer(async (req, res) => {
        if (req.url === "/mcp") {
          const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const result = body.method === "server/discover" ? { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} } } : { resultType: "complete", tools: [{ name: "lookup", inputSchema: { type: "object" } }] };
          res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result })); return;
        }
        res.statusCode = req.url === "/down" ? 503 : 200;
        res.end("hello from the target");
      });
      // just enough of a WebSocket server: accept the handshake and send one text frame
      server.on("upgrade", (req, socket) => {
        const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        const text = Buffer.from("hello over websocket");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]));
        socket.on("data", () => {});
        socket.on("error", () => {});
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => {
      configureNetGuard({});
      server.close();
    });

    it("returns the outcome of an http check", async () => {
      const up = await (await handleProbe(await signed({ ...check, target: `${url}/` }), { secret })).json() as { ok: boolean; statusCode: number; latencyMs: number };
      expect(up).toMatchObject({ ok: true, statusCode: 200 });
      expect(typeof up.latencyMs).toBe("number");
      const down = await (await handleProbe(await signed({ ...check, target: `${url}/down` }), { secret })).json() as { ok: boolean; statusCode: number };
      expect(down).toMatchObject({ ok: false, statusCode: 503 });
    });

    it("executes a signed MCP discovery against a private server and retains the complete schema", async () => {
      const response = await handleProbe(await signed({ ...check, type: "mcp", target: `${url}/mcp`, mcpConfig: { requiredTools: ["lookup"], schemaCheck: true, toolCall: null } }), { secret });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, mcp: { stage: "complete", toolsComplete: true, tools: [{ name: "lookup", inputSchema: { type: "object" } }] } });
    });

    it("returns the outcome of a tcp check", async () => {
      const port = new URL(url).port;
      const res = await (await handleProbe(await signed({ ...check, type: "tcp", target: `127.0.0.1:${port}` }), { secret })).json() as { ok: boolean };
      expect(res.ok).toBe(true);
    });

    it("returns the outcome of a websocket check", async () => {
      const target = url.replace("http:", "ws:") + "/socket";
      const up = await (await handleProbe(await signed({ ...check, type: "websocket", target, keyword: "over websocket" }), { secret })).json() as { ok: boolean; statusCode: number };
      expect(up).toMatchObject({ ok: true, statusCode: 101 });
      const miss = await (await handleProbe(await signed({ ...check, type: "websocket", target, keyword: "nope" }), { secret })).json() as { ok: boolean; error: string };
      expect(miss).toMatchObject({ ok: false, error: 'Keyword "nope" not found in the first message' });
    });
  });
});
