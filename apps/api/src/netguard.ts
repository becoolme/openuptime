import { BlockedTarget, allowPrivateTargets, guardHost, hostPort, isWorkers, privateTargetsAllowed } from "@openuptime/kit/netguard";
import { useOutboundProxy } from "@openuptime/kit/pinnedfetch";
import { configureSelfCheck } from "@openuptime/kit/selfcheck";
import { domainName } from "./domain-name";
/**
 * The outbound-request guard as OpenUptime configures it. The guard itself lives in the kit; what is specific to
 * monitors stays here: the deployment's settings, the User-Agent checks send and which monitor targets are refused.
 */

export * from "@openuptime/kit/netguard";

let userAgent = "OpenUptime/0.1 (+https://github.com/becoolme/openuptime)";

/** Env values are constant per deployment, so a module-level config is safe in a Worker isolate. */
export function configureNetGuard(env: { ALLOW_PRIVATE_TARGETS?: string; CHECK_USER_AGENT?: string; SELFCHECK_URLS?: string; OUTBOUND_PROXY?: string }) {
  configureSelfCheck(env.SELFCHECK_URLS);
  allowPrivateTargets(env.ALLOW_PRIVATE_TARGETS === "true");
  // Node only: on Workers the platform makes the connection and there is no proxy to go through
  if (!isWorkers()) useOutboundProxy(env.OUTBOUND_PROXY);
  userAgent = env.CHECK_USER_AGENT?.trim() || "OpenUptime/0.1 (+https://github.com/becoolme/openuptime)";
}
export const checkUserAgent = () => userAgent;

/** Why a monitor target is refused, or null. Used when a monitor is created or its target changes. */
export async function targetProblem(type: string, target: string): Promise<string | null> {
  if (type === "domain") { try { domainName(target); return null; } catch (e) { return (e as Error).message; } }
  if (privateTargetsAllowed() || type === "heartbeat" || type === "dns") return null;
  let host: string | undefined;
  if (type === "http" || type === "websocket" || type === "mcp" || type === "evm" || type === "solana") {
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      return null; // reported by the check itself, as before
    }
    if ((type === "http" || type === "mcp" || type === "evm" || type === "solana") && u.protocol !== "http:" && u.protocol !== "https:") return "Only http:// and https:// URLs can be monitored.";
    if (type === "websocket" && u.protocol !== "ws:" && u.protocol !== "wss:") return "Only ws:// and wss:// URLs can be monitored.";
    host = u.hostname;
  } else {
    host = hostPort(target, 1)?.hostname;
  }
  if (!host) return null;
  try {
    await guardHost(host);
    return null;
  } catch (e) {
    if (e instanceof BlockedTarget) return e.message;
    return null; // a name that does not resolve is reported by the check itself, as before
  }
}

/** Why a webhook-style channel URL is refused, or null. */
export async function urlProblem(url: string): Promise<string | null> {
  return targetProblem("http", url);
}
