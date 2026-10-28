import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createTlsServer, type Server as TlsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { runCheck, type CheckInput } from "./checker";
import { configureNetGuard, targetProblem } from "./netguard";
import { MAX_MESSAGE_BYTES, OP, acceptFor, closeInfo, decodeFrame, encodeFrame, websocketUrl } from "./websocket";

describe("frames", () => {
  it("computes the accept value of the RFC 6455 example", async () => {
    expect(await acceptFor("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("masks what it sends and reads it back, at every length encoding", () => {
    for (const len of [0, 5, 125, 126, 65535, 65536, 200_000]) {
      const payload = new Uint8Array(len).map((_, i) => i % 251);
      const bytes = encodeFrame(OP.binary, payload, new Uint8Array([1, 2, 3, 4]));
      expect(bytes[1] & 0x80).toBe(0x80);
      expect(bytes[1] & 0x7f).toBe(len < 126 ? len : len < 65536 ? 126 : 127);
      const got = decodeFrame(bytes);
      expect(got?.size).toBe(bytes.length);
      expect(got?.frame).toMatchObject({ fin: true, opcode: OP.binary });
      expect(Buffer.from(got!.frame.payload).equals(Buffer.from(payload))).toBe(true);
    }
  });

  it("waits for the rest of a frame that has not fully arrived", () => {
    const bytes = encodeFrame(OP.text, new TextEncoder().encode("hello"));
    for (let cut = 0; cut < bytes.length; cut++) expect(decodeFrame(bytes.subarray(0, cut))).toBeNull();
    // two frames in one chunk: the first is read and its size says where the next starts
    const two = new Uint8Array([...bytes, ...bytes]);
    expect(decodeFrame(two)?.size).toBe(bytes.length);
  });

  it("reads unmasked server frames and refuses one over the limit before it arrives", () => {
    expect(decodeFrame(new Uint8Array([0x81, 0x02, 0x68, 0x69]))?.frame).toMatchObject({ fin: true, opcode: OP.text, payload: new Uint8Array([0x68, 0x69]) });
    expect(decodeFrame(new Uint8Array([0x01, 0x01, 0x68]))?.frame.fin).toBe(false);
    const huge = new Uint8Array(10);
    huge.set([0x82, 127]);
    new DataView(huge.buffer).setBigUint64(2, BigInt(MAX_MESSAGE_BYTES + 1));
    expect(() => decodeFrame(huge)).toThrow(/larger than 1 MB/);
    expect(() => decodeFrame(new Uint8Array([0x82, 126, 0x01, 0x00]), 100)).toThrow(/larger than 1 MB/);
  });

  it("reads close codes and reasons", () => {
    expect(closeInfo(new Uint8Array([0x0f, 0xa1, 0x62, 0x79, 0x65]))).toEqual({ code: 4001, reason: "bye" });
    expect(closeInfo(new Uint8Array())).toEqual({ reason: "" });
  });

  it("only takes ws:// and wss:// URLs", () => {
    expect(websocketUrl(" wss://example.com/socket ")).toBeInstanceOf(URL);
    expect(websocketUrl("ws://example.com:8080")).toBeInstanceOf(URL);
    expect(websocketUrl("https://example.com")).toMatch(/ws:\/\/ or wss:\/\//);
    expect(websocketUrl("example.com")).toMatch(/ws:\/\/ or wss:\/\//);
  });
});

describe("the private-target guard", () => {
  it("refuses private websocket targets and other schemes, by default", async () => {
    configureNetGuard({});
    expect(await targetProblem("websocket", "ws://127.0.0.1:8080/")).toMatch(/private or internal/);
    expect(await targetProblem("websocket", "wss://169.254.169.254/")).toMatch(/private or internal/);
    expect(await targetProblem("websocket", "https://example.com/")).toMatch(/ws:\/\/ and wss:\/\//);
    expect(await targetProblem("websocket", "wss://1.1.1.1/")).toBeNull();
    const r = await runCheck({ type: "websocket", method: "GET", expectedStatus: 101, target: "ws://127.0.0.1:1/", timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/ALLOW_PRIVATE_TARGETS/) });
  });
});

describe("websocket checks", () => {
  // these talk to servers on 127.0.0.1; the guard is covered above
  beforeAll(() => configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" }));
  afterAll(() => configureNetGuard({}));

  /** How the last connection to each path ended, as the server saw it. */
  const closes = new Map<string, Promise<number>>();
  const handshakes = new Map<string, IncomingMessage>();

  const wss = new WebSocketServer({ noServer: true });
  const server: Server = createServer((_q, res) => res.end("not a websocket"));
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const path = req.url ?? "/";
    const raw = (text: string) => { socket.end(text); };
    if (path === "/denied") return raw("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    if (path === "/moved") return raw("HTTP/1.1 302 Found\r\nLocation: wss://example.com/new\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    if (path === "/wrong-accept") return raw("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: bm9wZQ==\r\n\r\n");
    if (path === "/silent-handshake") return; // never answers
    handshakes.set(path, req);
    wss.handleUpgrade(req, socket, head, (ws) => {
      closes.set(path, new Promise((r) => ws.on("close", (code) => r(code))));
      behave(path, ws, req);
    });
  });

  function behave(path: string, ws: WebSocket, req: IncomingMessage) {
    switch (path) {
      case "/echo": return void ws.on("message", (d, binary) => ws.send(d, { binary }));
      case "/headers": return void ws.on("message", () => ws.send(JSON.stringify(req.headers)));
      case "/greeting": return void ws.send('{"type":"hello","status":"ready"}');
      case "/binary-greeting": return void ws.send(Buffer.from("binary ready"));
      case "/close-on-message": return void ws.on("message", () => ws.close(4001, "go away"));
      case "/silent": return;
      case "/ping-first":
        // the reply only comes once the ping was answered
        ws.on("pong", (d) => ws.send(`pong received: ${d.toString()}`));
        return void ws.ping("are you there");
      case "/fragments":
        ws.send("first part, ", { fin: false });
        ws.send("second part, ", { fin: false });
        return void ws.send("last part", { fin: true });
      case "/huge-frame": return void ws.send("x".repeat(MAX_MESSAGE_BYTES + 10));
      case "/huge-fragments":
        ws.send("needle " + "a".repeat(600_000), { fin: false });
        ws.send("b".repeat(600_000), { fin: false });
        return void ws.send("c".repeat(600_000), { fin: true });
    }
  }

  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    for (const c of wss.clients) c.terminate();
    server.closeAllConnections();
    server.close();
  });

  const check = (path: string, over: Partial<CheckInput> = {}) =>
    runCheck({ type: "websocket", method: "GET", expectedStatus: 101, target: base + path, timeoutMs: 3000, ...over });

  describe("handshake", () => {
    it("is up when the server switches protocols, and closes the connection normally", async () => {
      const r = await check("/silent");
      expect(r).toMatchObject({ ok: true, statusCode: 101 });
      expect(r.error).toBeUndefined();
      expect(typeof r.latencyMs).toBe("number");
      expect(await closes.get("/silent")).toBe(1000);
    });

    it("sends the handshake the protocol asks for", async () => {
      await check("/silent");
      const h = handshakes.get("/silent")!.headers;
      expect(h).toMatchObject({ upgrade: "websocket", "sec-websocket-version": "13" });
      expect(h.connection?.toLowerCase()).toContain("upgrade");
      expect(Buffer.from(h["sec-websocket-key"] as string, "base64")).toHaveLength(16);
      expect(h["user-agent"]).toMatch(/OpenUptime/i);
    });

    it("is down when the server refuses the upgrade", async () => {
      expect(await check("/denied")).toMatchObject({ ok: false, statusCode: 401, error: "Expected 101 Switching Protocols, got 401" });
    });

    it("does not follow a redirect, and says where it leads", async () => {
      const r = await check("/moved");
      expect(r).toMatchObject({ ok: false, statusCode: 302 });
      expect(r.error).toBe("Expected 101 Switching Protocols, got 302 (redirects to wss://example.com/new)");
    });

    it("is down when the endpoint is plain http", async () => {
      // an ordinary request handler answers 200 without upgrading
      const plain = createServer((_q, res) => res.end("hello"));
      await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
      const r = await runCheck({ type: "websocket", method: "GET", expectedStatus: 101, target: `ws://127.0.0.1:${(plain.address() as AddressInfo).port}/`, timeoutMs: 3000 });
      plain.close();
      expect(r).toMatchObject({ ok: false, statusCode: 200, error: "Expected 101 Switching Protocols, got 200" });
    });

    it("is down when the accept header does not match the key", async () => {
      expect(await check("/wrong-accept")).toMatchObject({ ok: false, statusCode: 101, error: "Server sent a wrong Sec-WebSocket-Accept" });
    });

    it("times out when the server never answers the handshake", async () => {
      const t = Date.now();
      const r = await check("/silent-handshake", { timeoutMs: 1000 });
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/timed out/i) });
      expect(Date.now() - t).toBeLessThan(2500);
    });

    it("is down when nothing listens", async () => {
      const closed = createServer();
      await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
      const port = (closed.address() as AddressInfo).port;
      await new Promise<void>((r) => closed.close(() => r()));
      const r = await runCheck({ type: "websocket", method: "GET", expectedStatus: 101, target: `ws://127.0.0.1:${port}/`, timeoutMs: 2000 });
      expect(r).toMatchObject({ ok: false });
      expect(r.error).toMatch(/refused|ECONNREFUSED/i);
    });

    it("refuses a target that is not a websocket URL", async () => {
      expect(await runCheck({ type: "websocket", method: "GET", expectedStatus: 101, target: "https://example.com/", timeoutMs: 1000 })).toMatchObject({ ok: false, error: expect.stringMatching(/ws:\/\/ or wss:\/\//) });
    });

    it("sends the monitor's headers, but never in place of the handshake's own", async () => {
      const r = await check("/headers", {
        wsMessage: "headers?",
        keyword: '"x-token":"t-123"',
        headers: { "X-Token": "t-123", Host: "evil.example", "Sec-WebSocket-Version": "8", Upgrade: "h2c", "User-Agent": "custom-agent" },
      });
      expect(r).toMatchObject({ ok: true, statusCode: 101 });
      const h = handshakes.get("/headers")!.headers;
      expect(h).toMatchObject({ "x-token": "t-123", "sec-websocket-version": "13", upgrade: "websocket", "user-agent": "custom-agent" });
      expect(h.host).toBe(new URL(base).host);
    });
  });

  describe("message and reply", () => {
    it("sends the message and is up when a reply comes back", async () => {
      const r = await check("/echo", { wsMessage: '{"op":"ping"}' });
      expect(r).toMatchObject({ ok: true, statusCode: 101 });
      expect(await closes.get("/echo")).toBe(1000);
    });

    it("checks the reply for the keyword", async () => {
      expect(await check("/echo", { wsMessage: "status: healthy", keyword: "healthy" })).toMatchObject({ ok: true });
      expect(await check("/echo", { wsMessage: "status: healthy", keyword: "Healthy" })).toMatchObject({ ok: false, error: 'Keyword "Healthy" not found in the reply' });
    });

    it("supports absent mode", async () => {
      expect(await check("/echo", { wsMessage: "status: error", keyword: "error", keywordMode: "absent" })).toMatchObject({ ok: false, error: 'Unexpected keyword "error" found in the reply' });
      expect(await check("/echo", { wsMessage: "status: fine", keyword: "error", keywordMode: "absent" })).toMatchObject({ ok: true });
    });

    it("waits for the first message when nothing is sent but a keyword is set", async () => {
      expect(await check("/greeting", { keyword: '"status":"ready"' })).toMatchObject({ ok: true });
      expect(await check("/greeting", { keyword: "maintenance" })).toMatchObject({ ok: false, error: 'Keyword "maintenance" not found in the first message' });
    });

    it("reads binary messages as text", async () => {
      expect(await check("/binary-greeting", { keyword: "ready" })).toMatchObject({ ok: true });
    });

    it("is down when the server closes before replying, with its code and reason", async () => {
      expect(await check("/close-on-message", { wsMessage: "hi" })).toMatchObject({ ok: false, statusCode: 101, error: "Connection closed before a reply arrived (code 4001: go away)" });
    });

    it("times out when no reply comes", async () => {
      const t = Date.now();
      const r = await check("/silent", { wsMessage: "anyone?", timeoutMs: 1000 });
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/timed out/i) });
      expect(Date.now() - t).toBeLessThan(2500);
    });

    it("answers a ping while it waits", async () => {
      expect(await check("/ping-first", { keyword: "pong received: are you there" })).toMatchObject({ ok: true });
    });

    it("joins a fragmented message", async () => {
      expect(await check("/fragments", { keyword: "first part, second part, last part" })).toMatchObject({ ok: true });
    });

    it("fails on a single frame over 1 MB rather than buffering it", async () => {
      expect(await check("/huge-frame", { keyword: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/larger than 1 MB/) });
    });

    it("checks the first 1 MB of a long fragmented message", async () => {
      expect(await check("/huge-fragments", { keyword: "needle" })).toMatchObject({ ok: true });
      expect(await check("/huge-fragments", { keyword: "cccc" })).toMatchObject({ ok: false });
    });
  });

  describe("wss", () => {
    let tls: TlsServer | undefined;
    let secureBase = "";
    let opensslMissing = false;
    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), "ws-tls-"));
      try {
        execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "1", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
      } catch {
        opensslMissing = true;
        return;
      }
      tls = createTlsServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) });
      const secure = new WebSocketServer({ server: tls });
      secure.on("connection", (ws) => ws.on("message", (d) => ws.send(d)));
      await new Promise<void>((r) => tls!.listen(0, "127.0.0.1", r));
      secureBase = `wss://127.0.0.1:${(tls.address() as AddressInfo).port}`;
    });
    afterAll(() => {
      tls?.closeAllConnections();
      tls?.close();
    });

    it("verifies the server's certificate", async (ctx) => {
      if (opensslMissing) ctx.skip();
      const r = await runCheck({ type: "websocket", method: "GET", expectedStatus: 101, target: `${secureBase}/`, timeoutMs: 3000 });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/certificate/i);
    });
  });
});
