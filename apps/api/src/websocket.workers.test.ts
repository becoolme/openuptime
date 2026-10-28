import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { CheckInput, CheckOutcome } from "./checker";

/**
 * The same check inside workerd, where the runtime's own WebSocket client makes the connection (the Cloudflare
 * deployment). The checker is bundled the way a Worker is and runs in Miniflare against a local ws server.
 */

const ENTRY = `
import { runCheck } from "./checker";
import { configureNetGuard } from "./netguard";
// a loopback target is private; on Cloudflare the platform refuses those itself, Miniflare does not
configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
export default {
  async fetch(req) {
    return Response.json({ ua: navigator.userAgent, outcome: await runCheck(await req.json()) });
  },
};`;

let mf: Miniflare;
const handshakes = new Map<string, IncomingMessage>();
const closes = new Map<string, Promise<number>>();
const wss = new WebSocketServer({ noServer: true });
const server: Server = createServer((_q, res) => res.end("not a websocket"));
let base = "";

server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
  const path = req.url ?? "/";
  if (path === "/denied") return void socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  if (path === "/moved") return void socket.end("HTTP/1.1 302 Found\r\nLocation: wss://example.com/new\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  if (path === "/wrong-accept") return void socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: bm9wZQ==\r\n\r\n");
  if (path === "/silent-handshake") return;
  handshakes.set(path, req);
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    closes.set(path, new Promise((r) => ws.on("close", (code) => r(code))));
    if (path === "/echo") ws.on("message", (d, binary) => ws.send(d, { binary }));
    if (path === "/greeting") ws.send('{"status":"ready"}');
    if (path === "/binary-greeting") ws.send(Buffer.from("binary ready"));
    if (path === "/close-on-message") ws.on("message", () => ws.close(4001, "go away"));
    if (path === "/fragments") {
      ws.send("first part, ", { fin: false });
      ws.send("last part", { fin: true });
    }
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const out = await build({
    stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["node:*", "cloudflare:*"],
    logLevel: "silent",
  });
  mf = new Miniflare({
    workers: [{
      config: {
        name: "websocket-check",
        compatibilityDate: "2026-09-01",
        compatibilityFlags: ["nodejs_compat"],
        manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: out.outputFiles[0].text } } },
      },
    }],
  });
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  for (const c of wss.clients) c.terminate();
  server.closeAllConnections();
  server.close();
});

async function check(path: string, over: Partial<CheckInput> = {}): Promise<CheckOutcome> {
  const input: CheckInput = { type: "websocket", method: "GET", expectedStatus: 101, target: base + path, timeoutMs: 3000, ...over };
  const res = await mf.dispatchFetch("http://checker/", { method: "POST", body: JSON.stringify(input) });
  const { ua, outcome } = (await res.json()) as { ua: string; outcome: CheckOutcome };
  // the transport is chosen by this: make sure the Workers one ran
  expect(ua).toBe("Cloudflare-Workers");
  return outcome;
}

describe("websocket checks on Workers", () => {
  it("is up when the server switches protocols, and closes the connection", async () => {
    expect(await check("/silent")).toMatchObject({ ok: true, statusCode: 101 });
    expect(await closes.get("/silent")).toBe(1000);
  });

  it("sends the monitor's headers with the handshake", async () => {
    await check("/silent", { headers: { "X-Token": "t-123", "User-Agent": "custom-agent", Host: "evil.example" } });
    const h = handshakes.get("/silent")!.headers;
    expect(h).toMatchObject({ "x-token": "t-123", "user-agent": "custom-agent", upgrade: "websocket" });
    expect(h.host).toBe(new URL(base).host);
  });

  it("is down when the server refuses the upgrade", async () => {
    expect(await check("/denied")).toMatchObject({ ok: false, statusCode: 401, error: "Expected 101 Switching Protocols, got 401" });
  });

  it("does not follow a redirect", async () => {
    expect(await check("/moved")).toMatchObject({ ok: false, statusCode: 302, error: "Expected 101 Switching Protocols, got 302 (redirects to wss://example.com/new)" });
  });

  it("is down when the accept header does not match, which the runtime checks itself", async () => {
    expect(await check("/wrong-accept")).toMatchObject({ ok: false });
  });

  it("times out when the server never answers the handshake", async () => {
    expect(await check("/silent-handshake", { timeoutMs: 1000 })).toMatchObject({ ok: false, error: expect.stringMatching(/timed out/i) });
  });

  it("sends the message and checks the reply", async () => {
    expect(await check("/echo", { wsMessage: "status: healthy", keyword: "healthy" })).toMatchObject({ ok: true, statusCode: 101 });
    expect(await check("/echo", { wsMessage: "status: healthy", keyword: "sick" })).toMatchObject({ ok: false, error: 'Keyword "sick" not found in the reply' });
    expect(await check("/echo", { wsMessage: "status: error", keyword: "error", keywordMode: "absent" })).toMatchObject({ ok: false, error: 'Unexpected keyword "error" found in the reply' });
  });

  it("waits for the first message when nothing is sent", async () => {
    expect(await check("/greeting", { keyword: '"status":"ready"' })).toMatchObject({ ok: true });
    expect(await check("/binary-greeting", { keyword: "ready" })).toMatchObject({ ok: true });
    expect(await check("/fragments", { keyword: "first part, last part" })).toMatchObject({ ok: true });
  });

  it("is down when the server closes before replying", async () => {
    expect(await check("/close-on-message", { wsMessage: "hi" })).toMatchObject({ ok: false, error: "Connection closed before a reply arrived (code 4001: go away)" });
  });

  it("times out when no reply comes", async () => {
    const t = Date.now();
    expect(await check("/silent", { wsMessage: "anyone?", timeoutMs: 1000 })).toMatchObject({ ok: false, error: expect.stringMatching(/timed out/i) });
    expect(Date.now() - t).toBeLessThan(2500);
  });

  it("is down when nothing listens", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    expect(await check("/", { target: `ws://127.0.0.1:${port}/`, timeoutMs: 2000 })).toMatchObject({ ok: false });
  });
});
