import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Turn a Node request into a Fetch `Request` without reading its body. The body is passed on as a stream so the handler
 * can refuse an unsigned or oversized request from its headers alone, and reads at most the limit it allows.
 */
export function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") return new Request(`http://probe${req.url ?? "/"}`, { method, headers });
  // pulled lazily: a request refused from its headers is never read here, and Node discards its body as for any
  // unread request (bounded by the server's requestTimeout) so the client still receives the refusal
  let chunks: AsyncIterator<Buffer> | undefined;
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      chunks ??= req[Symbol.asyncIterator]();
      const next = await chunks.next();
      if (next.done) c.close();
      else c.enqueue(new Uint8Array(next.value));
    },
    async cancel() { await chunks?.return?.(); },
  }, { highWaterMark: 0 });
  return new Request(`http://probe${req.url ?? "/"}`, { method, headers, body, duplex: "half" } as RequestInit);
}

export async function send(res: ServerResponse, out: Response) {
  res.statusCode = out.status;
  out.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await out.arrayBuffer()));
}
