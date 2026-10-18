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

export async function pinnedFetch(url: string, init: RequestInit, addresses: string[]): Promise<Response> {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? await import("node:https") : await import("node:http");
  const { Readable } = await import("node:stream");
  const zlib = await import("node:zlib");
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
        const inflate = noBody ? null : encoding === "gzip" || encoding === "x-gzip" ? zlib.createGunzip() : encoding === "deflate" ? zlib.createInflate() : encoding === "br" ? zlib.createBrotliDecompress() : null;
        let source: import("node:stream").Readable | null = noBody ? null : res;
        if (inflate && source) {
          out.delete("content-encoding");
          out.delete("content-length");
          res.on("error", (e) => inflate.destroy(e));
          source = res.pipe(inflate);
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
