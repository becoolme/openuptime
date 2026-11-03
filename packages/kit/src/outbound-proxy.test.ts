import { createServer, type Server } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from "node:net";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { pinnedFetch, useOutboundProxy } from "./pinnedfetch";

describe("outbound proxy", () => {
  const servers: (Server | TcpServer)[] = [];
  afterAll(() => servers.forEach((s) => s.close()));
  afterEach(() => useOutboundProxy(undefined));
  const listen = async (s: Server | TcpServer) => {
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return (s.address() as AddressInfo).port;
  };

  /** A CONNECT proxy that records what it was asked for and answers 407 without the expected credentials. */
  const proxy = async (auth?: string) => {
    const asked: { authority: string; auth?: string }[] = [];
    const s = createServer();
    s.on("connect", (req, client, head) => {
      asked.push({ authority: req.url!, auth: req.headers["proxy-authorization"] });
      if (auth && req.headers["proxy-authorization"] !== auth) return void client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      const [host, port] = [req.url!.slice(0, req.url!.lastIndexOf(":")), Number(req.url!.slice(req.url!.lastIndexOf(":") + 1))];
      const upstream = connect(port, host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
    });
    return { port: await listen(s), asked };
  };

  it("tunnels to the validated address, not the name, and keeps the name in the Host header", async () => {
    const target = await listen(createServer((req, res) => res.end(JSON.stringify({ host: req.headers.host, url: req.url }))));
    const p = await proxy();
    useOutboundProxy(`http://127.0.0.1:${p.port}`);
    // "pinned.test" resolves nowhere: the proxy only reaches the server because it was given the address
    const res = await pinnedFetch(`http://pinned.test:${target}/a?b=1`, { signal: AbortSignal.timeout(3000) }, ["127.0.0.1"]);
    expect(await res.json()).toEqual({ host: `pinned.test:${target}`, url: "/a?b=1" });
    expect(p.asked).toEqual([{ authority: `127.0.0.1:${target}`, auth: undefined }]);
  });

  it("sends the proxy's credentials, and reports a refusal", async () => {
    const target = await listen(createServer((_req, res) => res.end("ok")));
    const p = await proxy(`Basic ${Buffer.from("me:s3cret").toString("base64")}`);
    useOutboundProxy(`http://me:s3cret@127.0.0.1:${p.port}`);
    expect(await (await pinnedFetch(`http://pinned.test:${target}/`, {}, ["127.0.0.1"])).text()).toBe("ok");
    useOutboundProxy(`http://me:wrong@127.0.0.1:${p.port}`);
    const err = await pinnedFetch(`http://pinned.test:${target}/`, {}, ["127.0.0.1"]).catch((e) => e);
    expect((err as Error).cause).toMatchObject({ message: "The outbound proxy refused the connection (HTTP 407)" });
  });

  it("names the host when there is no address to pin (private targets allowed)", async () => {
    const target = await listen(createServer((_req, res) => res.end("ok")));
    const p = await proxy();
    useOutboundProxy(`http://127.0.0.1:${p.port}`);
    expect(await (await pinnedFetch(`http://localhost:${target}/`, {}, null)).text()).toBe("ok");
    expect(p.asked[0].authority).toBe(`localhost:${target}`);
  });

  it("opens TLS inside the tunnel, naming the host in the URL", async () => {
    // a bare TCP server stands in for the site: it only needs to see the TLS ClientHello that arrives through the tunnel
    let hello!: (b: Buffer) => void;
    const got = new Promise<Buffer>((r) => (hello = r));
    const target = await listen(createTcpServer((sock) => sock.once("data", (d) => { hello(d); sock.destroy(); })));
    const p = await proxy();
    useOutboundProxy(`http://127.0.0.1:${p.port}`);
    const err = await pinnedFetch(`https://pinned.test:${target}/`, { signal: AbortSignal.timeout(3000) }, ["127.0.0.1"]).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError); // the stand-in hangs up instead of answering
    const bytes = await got;
    expect(bytes[0]).toBe(0x16); // a TLS handshake record
    expect(bytes.includes(Buffer.from("pinned.test"))).toBe(true); // SNI carries the name, not the address
    expect(p.asked[0].authority).toBe(`127.0.0.1:${target}`);
  });

  it("fails when the proxy hangs up without answering", async () => {
    const silent = await listen(createTcpServer((sock) => sock.once("data", () => sock.end())));
    useOutboundProxy(`http://127.0.0.1:${silent}`);
    const err = await pinnedFetch("http://pinned.test/", { signal: AbortSignal.timeout(3000) }, ["127.0.0.1"]).catch((e) => e);
    expect((err as Error).cause).toMatchObject({ message: "The outbound proxy closed the connection before it answered" });
  });

  it("closes the connection to the proxy when the check is aborted while waiting for it", async () => {
    // a proxy that takes the connection and never answers CONNECT
    let closed!: () => void;
    const gone = new Promise<void>((r) => (closed = r));
    let accepted = 0;
    const port = await listen(createTcpServer((sock) => { accepted++; sock.resume().on("close", () => closed()); }));
    useOutboundProxy(`http://127.0.0.1:${port}`);
    const ac = new AbortController();
    const pending = pinnedFetch("http://pinned.test/", { signal: ac.signal }, ["127.0.0.1"]).catch((e) => e);
    await new Promise((r) => setTimeout(r, 100));
    expect(accepted).toBe(1);
    ac.abort(new Error("timed out"));
    expect(await pending).toMatchObject({ message: "timed out" });
    await gone;
  });

  it("accepts only http and https proxy URLs", () => {
    expect(() => useOutboundProxy("socks5://127.0.0.1:1080")).toThrow(/http:\/\/ or https:\/\//);
    expect(() => useOutboundProxy("not a url")).toThrow(/not a URL/);
    expect(() => useOutboundProxy("")).not.toThrow();
  });
});
