// Prints a VAPID key pair for browser push notifications (see /docs/self-host#web-push).
//   node scripts/gen-vapid-keys.mjs
// Put VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in your environment. Keep the private key secret; keep the pair stable,
// because browsers that subscribed with one public key only accept messages signed by the same pair.
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = privateKey.export({ format: "jwk" });
const b64 = (s) => Buffer.from(s, "base64url");
const pub = Buffer.concat([Buffer.from([4]), b64(jwk.x), b64(jwk.y)]).toString("base64url");
console.log(`VAPID_PUBLIC_KEY=${pub}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.log("VAPID_SUBJECT=mailto:you@example.com");
