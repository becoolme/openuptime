import type { IncomingMessage, ServerResponse } from "node:http";
import { configureNetGuard } from "../../api/src/netguard";
import { handleProbe } from "./handler";
import { send, toRequest } from "./node-adapter";

// private targets are never allowed here (no ALLOW_PRIVATE_TARGETS): a hosted function has no internal network to check
configureNetGuard({ CHECK_USER_AGENT: process.env.CHECK_USER_AGENT });

/** Vercel Node function. `scripts/build.mjs` pins one copy of this to each region it deploys. */
export default async function (req: IncomingMessage, res: ServerResponse) {
  await send(res, await handleProbe(toRequest(req), { secret: process.env.PROBE_SECRET, region: process.env.VERCEL_REGION }));
}
