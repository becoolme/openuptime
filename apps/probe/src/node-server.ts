import { createServer, type Server } from "node:http";
import { handleProbe } from "./handler";
import { send, toRequest } from "./node-adapter";

/** The probe as a plain Node HTTP server: what runs in the Docker image and on any host with Node. */
export function createProbeServer(o: { secret: string | undefined; region?: string }): Server {
  const server = createServer(async (req, res) => {
    try {
      const request = await toRequest(req);
      if (request === "too-large") {
        res.statusCode = 413;
        res.end('{"error":"Request too large"}');
        return;
      }
      await send(res, await handleProbe(request, o));
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.statusCode = 500;
      res.end('{"error":"Probe failed"}');
    }
  });
  // a check request is a few hundred bytes: a client that dribbles one in is not a scheduler
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return server;
}
