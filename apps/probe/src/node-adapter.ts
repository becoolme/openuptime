import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_BODY_BYTES } from "./handler";

/** Turn a Node request into a Fetch `Request`, refusing bodies that are already larger than a check ever is. */
export async function toRequest(req: IncomingMessage): Promise<Request | "too-large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return "too-large";
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const method = req.method ?? "GET";
  return new Request(`http://probe${req.url ?? "/"}`, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }) });
}

export async function send(res: ServerResponse, out: Response) {
  res.statusCode = out.status;
  out.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await out.arrayBuffer()));
}
