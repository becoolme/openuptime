import type { IncomingMessage, ServerResponse } from "node:http";
import { handleProbe } from "./handler";
import { send, toRequest } from "./node-adapter";

/** Vercel Node function. `scripts/build.mjs` pins one copy of this to each region it deploys. */
export default async function (req: IncomingMessage, res: ServerResponse) {
  const request = await toRequest(req);
  if (request === "too-large") {
    res.statusCode = 413;
    res.end('{"error":"Request too large"}');
    return;
  }
  await send(res, await handleProbe(request, { secret: process.env.PROBE_SECRET, region: process.env.VERCEL_REGION }));
}
