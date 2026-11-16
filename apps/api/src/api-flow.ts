import { z } from "zod";
import type { ApiExtract, ApiFlow, ApiStepResult, CheckDiagnosis } from "@openuptime/repo";
import { httpCheck, type CheckInput, type CheckOutcome, type Seen } from "./checker";
import { classifyError, redactText, secretsOf } from "./diagnosis";
import { HTTP_METHODS, MAX_REQUEST_BODY_BYTES } from "./http-request";
import { MASK } from "./secrets";
import { jsonAssertionsSchema, jsonValueAt, parsePath } from "./json-assert";

/**
 * Multi-step API checks: the monitor's own request runs first, then each step in order. A step can use what earlier
 * answers returned (a token, an id) as {{name}} in its URL, headers and body. Extracted values are treated as secrets:
 * they never appear in errors, diagnoses or alerts.
 */

export const API_FLOW_CAPABILITY = "api-flow-v1";
export const MAX_API_STEPS = 5;
const MAX_EXTRACTS = 10;
const MAX_VALUE_CHARS = 8192;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const VAR = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,31})\s*\}\}/g;

const extractSchema = z.object({
  name: z.string().trim().regex(NAME, "Use letters, digits and _ (starting with a letter), up to 32 characters"),
  from: z.enum(["json", "header"]).default("json"),
  path: z.string().trim().min(1).max(256),
}).superRefine((x, ctx) => {
  if (x.from === "json") { const r = parsePath(x.path); if (typeof r === "string") ctx.addIssue({ code: "custom", path: ["path"], message: r }); }
  else if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(x.path)) ctx.addIssue({ code: "custom", path: ["path"], message: "Not a header name" });
});

const stepSchema = z.object({
  name: z.string().trim().min(1).max(60),
  method: z.enum(HTTP_METHODS).default("GET"),
  url: z.string().trim().min(1).max(2048)
    .refine((u) => { try { return ["http:", "https:"].includes(new URL(fillBlank(u)).protocol); } catch { return false; } }, "Use an absolute http(s) URL; {{name}} may stand for a value read earlier")
    // the host is fixed when saving: an answer must never decide where the next request (and its headers) goes
    .refine((u) => !/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*\{\{/i.test(u), "{{name}} can be used in the path, query and headers, not in the host"),
  headers: z.record(z.string().max(100), z.string().max(2000)).default({}),
  body: z.string().max(MAX_REQUEST_BODY_BYTES).nullable().default(null).transform((v) => v || null),
  expectedStatus: z.number().int().min(100).max(599).default(200),
  jsonAssertions: jsonAssertionsSchema.default([]),
  extract: z.array(extractSchema).max(MAX_EXTRACTS).default([]),
}).refine((s) => !(s.body && (s.method === "GET" || s.method === "HEAD")), { message: "GET and HEAD requests cannot have a body", path: ["body"] });

/** Every {{name}} a step uses must be read by an earlier request, and a name is read only once. */
export const apiFlowSchema = z.object({
  extract: z.array(extractSchema).max(MAX_EXTRACTS).default([]),
  steps: z.array(stepSchema).min(1).max(MAX_API_STEPS),
}).superRefine((f, ctx) => {
  const known = new Set<string>();
  const read = (xs: ApiExtract[], where: (string | number)[]) => {
    for (const [i, x] of xs.entries()) {
      if (known.has(x.name)) ctx.addIssue({ code: "custom", path: [...where, i, "name"], message: `{{${x.name}}} is already read by an earlier request` });
      known.add(x.name);
    }
  };
  read(f.extract, ["extract"]);
  f.steps.forEach((s, i) => {
    const used = [s.url, s.body ?? "", ...Object.values(s.headers)].flatMap((t) => [...t.matchAll(VAR)].map((m) => m[1]));
    for (const u of used) if (!known.has(u)) ctx.addIssue({ code: "custom", path: ["steps", i], message: `{{${u}}} is not read by an earlier request` });
    read(s.extract, ["steps", i, "extract"]);
  });
});

const fill = (text: string, vars: Map<string, string>) => text.replace(VAR, (all, name: string) => vars.get(name) ?? all);
/** A step URL with each {{name}} replaced by a harmless placeholder: what is checked when saving. */
export const fillBlank = (url: string) => url.replace(VAR, "x");

/** Step header values and bodies are often credentials: only owners and admins see them, like the monitor's own. */
export const maskFlow = (f: ApiFlow | null | undefined): ApiFlow | null => f ? {
  ...f, steps: f.steps.map((s) => ({ ...s, headers: Object.fromEntries(Object.keys(s.headers).map((k) => [k, MASK])), body: s.body ? MASK : null })),
} : null;

/** Placeholders keep the stored value of the same header (or body) in the step at the same position. */
export function restoreFlow<F extends ApiFlow>(incoming: F | null, current: ApiFlow | null | undefined): F | null {
  if (!incoming) return null;
  return {
    ...incoming,
    steps: incoming.steps.map((s, i) => {
      const was = current?.steps[i];
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.headers)) { if (v !== MASK) headers[k] = v; else if (was?.headers[k] !== undefined) headers[k] = was.headers[k]; }
      return { ...s, headers, body: s.body === MASK ? was?.body ?? null : s.body };
    }),
  };
}

/** Whether stored steps carry values a member who is not an owner or admin cannot see. */
export const flowHasSecrets = (f: ApiFlow | null | undefined) => Boolean(f?.steps.some((s) => Object.keys(s.headers).length || s.body));
export const flowHasMask = (f: ApiFlow | null | undefined) => Boolean(f?.steps.some((s) => s.body === MASK || Object.values(s.headers).includes(MASK)));

/** The value an extraction reads from a passing answer, as text; an error message when it is not there. */
function readValue(x: ApiExtract, seen: Seen): { value: string } | { error: string } {
  if (x.from === "header") {
    const v = seen.headers?.get(x.path);
    return v ? { value: v.slice(0, MAX_VALUE_CHARS) } : { error: `Header ${x.path} is missing, so {{${x.name}}} could not be read` };
  }
  let doc: unknown;
  try { doc = JSON.parse(seen.body ?? ""); } catch { return { error: `Response is not valid JSON, so {{${x.name}}} could not be read` }; }
  const got = jsonValueAt(doc, x.path);
  if (!got.found || got.value == null) return { error: `JSON ${x.path} is missing, so {{${x.name}}} could not be read` };
  const v = typeof got.value === "string" ? got.value : JSON.stringify(got.value);
  return { value: v.slice(0, MAX_VALUE_CHARS) };
}

/**
 * Runs the monitor's request and then every step. The first request that fails ends the run and fails the check; the
 * diagnosis lists each request with its time, and the error names the step. The monitor's timeout covers all requests
 * together, so a flow takes no longer than a single check would.
 */
export async function apiFlowCheck(m: CheckInput & { apiFlow: ApiFlow }, started: number): Promise<CheckOutcome> {
  const flow = m.apiFlow;
  const requests = [
    { name: "Request 1", input: m, extract: flow.extract },
    ...flow.steps.map((s) => ({
      name: s.name, extract: s.extract,
      input: { ...m, target: s.url, method: s.method, headers: s.headers, requestBody: s.body, expectedStatus: s.expectedStatus, jsonAssertions: s.jsonAssertions, keyword: null, expectedLocation: null } as CheckInput,
    })),
  ];
  const vars = new Map<string, string>();
  const steps: ApiStepResult[] = [];
  // the monitor's own credentials and every value read on the way
  const secrets = () => [...new Set([...requests.flatMap((r) => secretsOf(r.input.target, r.input.headers)), ...vars.values()].filter((v) => v.length >= 4))].sort((a, b) => b.length - a.length);
  const clean = (t: string) => redactText(t, secrets());
  let last: CheckOutcome = { ok: true };
  const deadline = started + m.timeoutMs;
  for (const [i, r] of requests.entries()) {
    const left = deadline - Date.now();
    if (left < 250) {
      steps.push({ name: r.name, ok: false, ms: 0, error: "Not run: the monitor's timeout was used up by earlier requests" });
      const latencyMs = Date.now() - started;
      return { ok: false, latencyMs, error: `Step ${i + 1} (${r.name}): not run, the timeout of ${m.timeoutMs} ms was used up`, diagnosis: { kind: "timeout", timings: { totalMs: latencyMs }, steps } };
    }
    const input: CheckInput = i === 0 ? { ...r.input, timeoutMs: left } : {
      ...r.input,
      timeoutMs: left,
      target: fill(r.input.target, vars),
      requestBody: r.input.requestBody ? fill(r.input.requestBody, vars) : null,
      headers: Object.fromEntries(Object.entries(r.input.headers ?? {}).map(([k, v]) => [k, fill(v, vars)])),
    };
    const seen: Seen = {};
    const t0 = Date.now();
    let out: CheckOutcome;
    try {
      out = await httpCheck(input, t0, r.extract.length ? seen : undefined);
    } catch (e) {
      out = { ok: false, error: e instanceof Error ? e.message : String(e), diagnosis: { kind: classifyError(e), timings: { totalMs: Date.now() - t0 } } };
    }
    // the prober itself is offline: that says nothing about the target, at any step
    if (out.inconclusive) return out;
    const ms = Date.now() - t0;
    let error = out.ok ? undefined : out.error ?? "Request failed";
    let kind: CheckDiagnosis["kind"] | undefined = out.diagnosis?.kind;
    if (out.ok) {
      for (const x of r.extract) {
        const got = readValue(x, seen);
        if ("error" in got) { error = got.error; kind = "assertion"; break; }
        vars.set(x.name, got.value);
      }
    }
    steps.push({ name: r.name, ok: !error, ...(out.statusCode != null ? { statusCode: out.statusCode } : {}), ms, ...(error ? { error: clean(error) } : {}) });
    if (error) {
      const latencyMs = Date.now() - started;
      const d = out.diagnosis;
      const diagnosis: CheckDiagnosis = {
        kind: kind ?? "other",
        timings: { ...(d?.timings?.firstByteMs != null ? { firstByteMs: d.timings.firstByteMs } : {}), totalMs: latencyMs },
        steps,
        ...(d?.redirects ? { redirects: d.redirects.map((h) => ({ ...h, url: clean(h.url), location: h.location ? clean(h.location) : null })) } : {}),
        ...(d?.headers ? { headers: Object.fromEntries(Object.entries(d.headers).map(([k, v]) => [k, clean(v)])) } : {}),
        ...(d?.body ? { body: clean(d.body) } : {}),
      };
      return { ok: false, statusCode: out.statusCode, latencyMs, error: clean(`Step ${i + 1} (${r.name}): ${error}`), diagnosis };
    }
    last = out;
  }
  return { ok: true, statusCode: last.statusCode, latencyMs: Date.now() - started, steps };
}
