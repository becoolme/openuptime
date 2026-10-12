import { createServer } from "node:http";
import { handleProbe } from "./handler";
import { send, toRequest } from "./node-adapter";

// A probe on any machine you run: `PROBE_SECRET=… node dist/server.mjs`, then list its URL in PROBE_REGIONS.
const port = Number(process.env.PORT ?? 8787);
const region = process.env.PROBE_REGION;

createServer(async (req, res) => {
  try {
    const request = await toRequest(req);
    if (request === "too-large") {
      res.statusCode = 413;
      res.end('{"error":"Request too large"}');
      return;
    }
    await send(res, await handleProbe(request, { secret: process.env.PROBE_SECRET, region }));
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end('{"error":"Probe failed"}');
  }
}).listen(port, () => console.log(`OpenUptime probe${region ? ` (${region})` : ""} listening on :${port}`));
if (!process.env.PROBE_SECRET) console.warn("PROBE_SECRET is not set: every check request will be refused");
