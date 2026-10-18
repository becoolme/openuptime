/**
 * A fetch() for Node that connects to addresses the caller already validated, whatever the name resolves to later.
 * fetch() resolves the name again on its own, which leaves a window for DNS rebinding: a name that answers with a public
 * address when it is checked and a private one when it is dialled. Here the connection can only go to `addresses`, while
 * the URL, the Host header and TLS server name stay those of the original name, so virtual hosting and certificate
 * checks work as usual.
 *
 * Deliberately small: the body is a string or bytes, redirects are not followed (guardedFetch does that, hop by hop),
 * and the response is sent uncompressed so byte budgets count what is on the wire.
 */

/**
 * "deflate" is zlib-wrapped by the standard, but some servers send the raw stream: look at the first two bytes (the zlib
 * header) and inflate accordingly.
 */
function inflateAuto(zlib: typeof import("node:zlib"), TransformClass: typeof import("node:stream").Transform) {
  let inner: import("node:stream").Duplex | undefined;
  let head = Buffer.alloc(0);
  const start = (t: import("node:stream").Transform, first: Buffer) => {
    const zlibHeader = first.length >= 2 && (first[0] & 0x0f) === 8 && ((first[0] << 8) | first[1]) % 31 === 0;
    inner = zlibHeader ? zlib.createInflate() : zlib.createInflateRaw();
    inner.on("data", (d) => t.push(d));
    inner.on("error", (e) => t.destroy(e));
    return inner;
  };
  return new TransformClass({
    transform(chunk: Buffer, _enc, cb) {
      if (inner) return void inner.write(chunk, () => cb());
      head = Buffer.concat([head, chunk]);
      if (head.length < 2) return cb();
      start(this, head).write(head, () => cb());
    },
    flush(cb) {
      if (!inner && head.length) start(this, head).write(head);
      if (!inner) return cb();
      inner.once("end", () => cb());
      inner.end();
    },
  });
}

export async function pinnedFetch(url: string, init: RequestInit, addresses: string[]): Promise<Response> {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? await import("node:https") : await import("node:http");
  const { Readable } = await import("node:stream");
  const zlib = await import("node:zlib");
  const { PassThrough, Transform } = await import("node:stream");
  const headers = new Headers(init.headers);
  // always uncompressed on the wire (a caller's own accept-encoding is overridden), so byte budgets count what is received
  headers.set("accept-encoding", "identity");
  const body = init.body == null ? undefined : typeof init.body === "string" ? init.body : init.body instanceof Uint8Array ? init.body : null;
  if (body === null) throw new TypeError("pinnedFetch supports string and byte bodies only");
  if (body !== undefined && !headers.has("content-length")) headers.set("content-length", String(typeof body === "string" ? Buffer.byteLength(body) : body.byteLength));

  const headerObject: Record<string, string> = {};
  headers.forEach((v, k) => { headerObject[k] = v; });

  return new Promise<Response>((resolve, reject) => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) return reject(signal.reason);
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname.replace(/^\[|\]$/g, ""),
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: init.method ?? "GET",
        headers: headerObject,
        // dns.lookup contract: hand back only validated addresses, in the order given
        lookup: (_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          const list = addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
          if (opts?.all) cb(null, list);
          else cb(null, list[0].address, list[0].family);
        },
        // names that are IP literals carry no SNI; named hosts verify the certificate against the name, not the address
        ...(u.protocol === "https:" && !/^[\d.]+$|:/.test(u.hostname) ? { servername: u.hostname } : {}),
      } as import("node:http").RequestOptions,
      (res) => {
        const noBody = [101, 204, 205, 304].includes(res.statusCode ?? 0) || req.method === "HEAD";
        const out = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        if (noBody) res.resume();
        // a server may compress anyway: undo it, so callers always read the real bytes
        const encoding = (out.get("content-encoding") ?? "").trim().toLowerCase();
        const inflate = noBody ? null : encoding === "gzip" || encoding === "x-gzip" ? zlib.createGunzip() : encoding === "deflate" ? inflateAuto(zlib, Transform) : encoding === "br" ? zlib.createBrotliDecompress() : null;
        let source: import("node:stream").Readable | null = noBody ? null : res;
        if (inflate && source) {
          out.delete("content-encoding");
          out.delete("content-length");
          // an empty body has nothing to decode, whatever the header claims: it stays empty instead of failing
          let received = 0;
          res.on("data", (d: Buffer) => { received += d.length; });
          const decoded = new PassThrough();
          inflate.on("error", (e) => (received === 0 ? decoded.end() : decoded.destroy(e)));
          res.on("error", (e) => inflate.destroy(e));
          inflate.pipe(decoded);
          res.pipe(inflate);
          source = decoded;
          // dropping the response (a capped read) must stop the download too
          source.on("close", () => res.destroy());
        }
        resolve(new Response(source ? (Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>) : null, { status: res.statusCode ?? 502, statusText: res.statusMessage, headers: out }));
      },
    );
    req.on("error", (err) => reject(signal?.aborted ? signal.reason : new TypeError("fetch failed", { cause: err })));
    signal?.addEventListener("abort", () => req.destroy(signal.reason as Error), { once: true });
    req.end(body);
  });
}
