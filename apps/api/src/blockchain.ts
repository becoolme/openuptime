import { checkUserAgent, guardedFetch, readCapped } from "./netguard";
import type { CheckInput, CheckOutcome } from "./checker";

/** Check the node's own view of its health; this does not compare it with a reference chain. */
export async function blockchainCheck(input: CheckInput, started: number): Promise<CheckOutcome> {
  const method = input.type === "evm" ? "eth_syncing" : "getHealth";
  const headers = new Headers({ "user-agent": checkUserAgent(), ...input.headers });
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  const { res } = await guardedFetch(input.target, {
    method: "POST", headers, signal: AbortSignal.timeout(input.timeoutMs),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
  }, { follow: false, protectBody: true });
  const statusCode = res.status;
  if (!res.ok) {
    await res.body?.cancel();
    return { ok: false, statusCode, latencyMs: Date.now() - started, error: `RPC returned HTTP ${statusCode}` };
  }
  let value: unknown;
  try { value = JSON.parse(await readCapped(res, 64 * 1024)); }
  catch { return { ok: false, statusCode, latencyMs: Date.now() - started, error: "Invalid JSON-RPC response" }; }
  const response = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const valid = response?.jsonrpc === "2.0" && response.id === 1 && Object.hasOwn(response, "result") && !Object.hasOwn(response, "error");
  const ok = valid && (input.type === "evm" ? response.result === false : response.result === "ok");
  const error = !valid ? "Invalid or failed JSON-RPC response" : input.type === "evm" && response.result && typeof response.result === "object" && !Array.isArray(response.result) ? "EVM node is syncing" : "Node reported unhealthy or invalid status";
  return { ok: !!ok, statusCode, latencyMs: Date.now() - started, ...(ok ? {} : { error }) };
}
