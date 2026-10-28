import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signProbe } from "../../api/src/probe-protocol";
import { configureNetGuard } from "../../api/src/netguard";
import { handleProbe, parseCheck } from "./handler";

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
    expect(await res.json()).toEqual({ ok: true, region: "fra1" });
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

  it("only runs http, tcp and websocket checks", async () => {
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

  it("will not be aimed at a private address", async () => {
    configureNetGuard({});
    const res = await handleProbe(await signed({ ...check, target: "http://169.254.169.254/latest/meta-data" }), { secret });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("target_not_allowed");
  });

  describe("running a check", () => {
    let server: Server;
    let url = "";
    beforeAll(async () => {
      // a loopback target is private; this suite opts in the way a self-hoster would
      configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
      server = createServer((req, res) => {
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
