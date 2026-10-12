import type { AddressInfo } from "node:net";
import { configureNetGuard } from "../../api/src/netguard";
import { createProbeServer } from "./node-server";

// A probe on any machine you run:  PROBE_SECRET=… node dist/server.mjs  (or the Docker image), then list its URL in
// the API's PROBE_REGIONS.
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST || "0.0.0.0";
const region = process.env.PROBE_REGION?.trim() || undefined;
const secret = process.env.PROBE_SECRET?.trim() || undefined;

// Same names as on the API, so the probe's requests look like the scheduler's. Private targets stay refused unless the
// operator of this probe opts in: that is how a probe inside an office or home network checks internal services.
configureNetGuard({ CHECK_USER_AGENT: process.env.CHECK_USER_AGENT, ALLOW_PRIVATE_TARGETS: process.env.ALLOW_PRIVATE_TARGETS });

const server = createProbeServer({ secret, region });
server.listen(port, host, () => console.log(`OpenUptime probe${region ? ` (${region})` : ""} listening on ${host}:${(server.address() as AddressInfo).port}`));

if (!secret) console.warn("PROBE_SECRET is not set: every check request will be refused");
else if (secret.length < 16) console.warn("PROBE_SECRET is short: use a long random value (openssl rand -hex 32)");
if (process.env.ALLOW_PRIVATE_TARGETS === "true") console.warn("ALLOW_PRIVATE_TARGETS is on: this probe can reach private and internal addresses");

// a container is stopped with SIGTERM: finish the checks in flight, then leave
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`${sig}: shutting down`);
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 35_000).unref();
  });
}
