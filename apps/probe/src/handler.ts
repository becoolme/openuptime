import { HTTP_METHODS, HTTP_REQUEST_CAPABILITY, requestBodyProblem } from "../../api/src/http-request";
import { runCheck, type CheckInput } from "../../api/src/checker";
import { targetProblem } from "../../api/src/netguard";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyProbe } from "../../api/src/probe-protocol";

/** Bounds the signed envelope, including escaped request text and custom headers. */
export const MAX_BODY_BYTES = 256 * 1024;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** The scheduler's request, or the reason it is not acceptable. Only the types a probe runs; nothing else is let through. */
export function parseCheck(raw: unknown): { input: CheckInput } | { error: string } {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return { error: "Expected a JSON object" };
  if (o.type !== "http" && o.type !== "tcp" && o.type !== "websocket") return { error: "type must be http, tcp or websocket" };
  if (typeof o.target !== "string" || !o.target || o.target.length > 2048) return { error: "target is required" };
  const method = o.method ?? "GET";
  if (typeof method !== "string" || !(HTTP_METHODS as readonly string[]).includes(method)) return { error: "Unsupported HTTP method" };
  const requestBody = o.requestBody ?? null;
  if (requestBody !== null && typeof requestBody !== "string") return { error: "requestBody must be a string" };
  const problem = requestBodyProblem({ type: o.type, method, requestBody });
  if (problem) return { error: problem };
  const expectedStatus = o.expectedStatus ?? 200;
  if (!Number.isInteger(expectedStatus) || (expectedStatus as number) < 100 || (expectedStatus as number) > 599) return { error: "expectedStatus is out of range" };
  const timeoutMs = o.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1000 || (timeoutMs as number) > 30000) return { error: "timeoutMs must be between 1000 and 30000" };
  const keyword = o.keyword ?? null;
  if (keyword !== null && (typeof keyword !== "string" || keyword.length > 500)) return { error: "keyword must be a string" };
  const keywordMode = o.keywordMode ?? "contains";
  if (keywordMode !== "contains" && keywordMode !== "absent") return { error: "keywordMode must be contains or absent" };
  const expectedLocation = o.expectedLocation ?? null;
  if (expectedLocation !== null && (typeof expectedLocation !== "string" || expectedLocation.length > 2048)) return { error: "expectedLocation must be a string" };
  const headers = o.headers ?? {};
  if (typeof headers !== "object" || Array.isArray(headers) || headers === null) return { error: "headers must be an object" };
  const entries = Object.entries(headers as Record<string, unknown>);
  if (entries.length > 50 || entries.some(([k, v]) => typeof v !== "string" || k.length > 100 || v.length > 2000)) return { error: "headers are not acceptable" };
  const wsMessage = o.wsMessage ?? null;
  if (wsMessage !== null && (typeof wsMessage !== "string" || wsMessage.length > 2000)) return { error: "wsMessage must be a string" };
  return {
    input: {
      type: o.type, target: o.target, method, expectedStatus: expectedStatus as number, timeoutMs: timeoutMs as number,
      keyword: keyword as string | null, keywordMode, expectedLocation: expectedLocation as string | null, headers: Object.fromEntries(entries) as Record<string, string>,
      wsMessage: wsMessage as string | null, requestBody,
    },
  };
}

/**
 * One check on request. The same code answers on every platform (Vercel function, plain Node server); only the thin
 * adapters around it differ. Nothing here depends on where it runs, so the region a result comes from is the place the
 * function is deployed to.
 */
export async function handleProbe(req: Request, o: { secret: string | undefined; region?: string }): Promise<Response> {
  if (req.method === "GET") return json(200, { ok: true, region: o.region ?? null, capabilities: [HTTP_REQUEST_CAPABILITY] });
  if (req.method !== "POST") return json(405, { error: "POST a check to this endpoint" });
  if (!o.secret) return json(503, { error: "Probe has no PROBE_SECRET configured" });
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return json(413, { error: "Request too large" });
  const verified = await verifyProbe(o.secret, { timestamp: req.headers.get(TIMESTAMP_HEADER), signature: req.headers.get(SIGNATURE_HEADER), body: text });
  if (!verified) return json(401, { error: "Bad or expired signature" });
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return json(400, { error: "Body is not valid JSON" }); }
  const parsed = parseCheck(raw);
  if ("error" in parsed) return json(400, { error: parsed.error });
  // a signed request is still not allowed to aim the probe at a private address
  const blocked = await targetProblem(parsed.input.type, parsed.input.target);
  if (blocked) return json(400, { error: blocked, code: "target_not_allowed" });
  const outcome = await runCheck(parsed.input);
  return json(200, outcome);
}
