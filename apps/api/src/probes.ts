import { prepareMcpOAuth, addOAuthTiming } from "./mcp-oauth";
import { mcpToolsEqual } from "./mcp-monitor-schema";
import { mcpObservationSchema } from "./mcp-config";
import { readCapped } from "./netguard";
import { HTTP_REQUEST_CAPABILITY } from "./http-request";
import type { Monitor, RegionResult, Repo } from "@openuptime/repo";
import { runCheck, type CheckInput, type CheckOutcome } from "./checker";
import { ENVELOPE_HEADER, MCP_MONITOR_CAPABILITY, SIGNATURE_HEADER, TIMESTAMP_HEADER, signProbe, signProbeEnvelope } from "./probe-protocol";
import { AUTO, REGION_ID, REGION_NAMES, effectiveRegions } from "./regions";

/**
 * Remote probes. A region is an HTTP endpoint (apps/probe, deployed to several places) that runs one check on request
 * and answers with its outcome. Which regions exist is deployment configuration:
 *
 *   PROBE_REGIONS = {"us-east":"https://probe.example.app/api/probe/us-east","eu-central":{"url":"…","name":"Frankfurt"}}
 *   PROBE_SECRET  = shared secret the probes verify requests with
 *
 * Nothing configured means only `auto` (the scheduler's own location), exactly as before.
 */
export type ProbeRegion = { id: string; name: string; url: string; private?: boolean };

let regions = new Map<string, ProbeRegion>();
let secret = "";
let configured: string | undefined;

/** Parses `PROBE_REGIONS`. Entries that cannot be used are reported in `problems` and left out. */
export function parseProbeRegions(raw: string | undefined): { regions: ProbeRegion[]; problems: string[] } {
  const out: ProbeRegion[] = [];
  const problems: string[] = [];
  if (!raw?.trim()) return { regions: out, problems };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { regions: out, problems: ["PROBE_REGIONS is not valid JSON"] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { regions: out, problems: ["PROBE_REGIONS must be a JSON object of region id to URL"] };
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = typeof value === "string" ? { url: value } : (value as { url?: unknown; name?: unknown } | null);
    const url = typeof entry?.url === "string" ? entry.url.trim() : "";
    if (id === AUTO || !REGION_ID.test(id)) { problems.push(`${id}: not a valid region id (lowercase letters, digits and dashes, 2 to 24 characters, not "auto")`); continue; }
    let u: URL;
    try { u = new URL(url); } catch { problems.push(`${id}: url is not a valid URL`); continue; }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) { problems.push(`${id}: url must use https`); continue; }
    const name = typeof (entry as { name?: unknown })?.name === "string" && (entry as { name: string }).name.trim() ? (entry as { name: string }).name.trim().slice(0, 60) : (REGION_NAMES[id] ?? id);
    out.push({ id, name, url: u.toString(), ...((entry as { private?: unknown })?.private === true ? { private: true } : {}) });
  }
  return { regions: out, problems };
}

/** Env values are constant per deployment, so a module-level config is safe in a Worker isolate; parsed once. */
export function configureProbes(env: { PROBE_REGIONS?: string; PROBE_SECRET?: string }) {
  capable.clear();
  const key = `${env.PROBE_REGIONS ?? ""}\u0000${env.PROBE_SECRET ?? ""}`;
  if (key === configured) return;
  configured = key;
  const parsed = parseProbeRegions(env.PROBE_REGIONS);
  for (const p of parsed.problems) console.warn(`probes: ${p}`);
  secret = env.PROBE_SECRET?.trim() ?? "";
  if (parsed.regions.length && !secret) console.warn("probes: PROBE_REGIONS is set but PROBE_SECRET is not; regions stay disabled");
  regions = new Map(secret ? parsed.regions.map((r) => [r.id, r] as const) : []);
}

/** The regions a monitor may use here, `auto` first. */
export function availableRegions(): { id: string; name: string }[] {
  return [{ id: AUTO, name: "Auto" }, ...[...regions.values()].map(({ id, name }) => ({ id, name }))];
}

export const usesOnlyPrivateProbes = (type: string, ids: string[]) => type === "mcp" && ids.length > 0 && ids.every(id => regions.get(id)?.private === true);

export const isRegionConfigured = (id: string) => id === AUTO || regions.has(id);

/** What running a check in one region came to: an outcome, or that the region could not be asked at all. */
export type RegionRun = { region: string; outcome: CheckOutcome } | { region: string; unreachable: string };

const outcomeOf = (v: unknown): CheckOutcome | null => {
  const o = v as { ok?: unknown; statusCode?: unknown; latencyMs?: unknown; error?: unknown; mcp?: unknown; degraded?: unknown } | null;
  if (!o || typeof o.ok !== "boolean") return null;
  return {
    ok: o.ok,
    ...(typeof o.degraded === "boolean" ? { degraded: o.degraded } : {}),
    ...(o.mcp && mcpObservationSchema.safeParse(o.mcp).success ? { mcp: mcpObservationSchema.parse(o.mcp) } : {}),
    ...(typeof o.statusCode === "number" ? { statusCode: o.statusCode } : {}),
    ...(typeof o.latencyMs === "number" ? { latencyMs: o.latencyMs } : {}),
    ...(typeof o.error === "string" ? { error: o.error.slice(0, 500) } : {}),
  };
};

/**
 * Run a check from `region`. A probe that cannot be reached, refuses us or answers nonsense is `unreachable`: that says
 * nothing about the target, so callers must not count it as a failed check.
 */
const CAPABILITY_TTL_MS = 30_000;
const capable = new Map<string, number>();
/** Forgets which probes were seen supporting request bodies (tests, and a configuration reload). */
export function resetProbeCapabilities() { capable.clear(); }

export async function runInRegion(region: string, input: CheckInput, repo?: Repo): Promise<RegionRun> {
  if (input.type === "mcp" && input.mcpConfig?.oauth) {
    const snapshot = "id" in input && "organizationId" in input ? input as Monitor : undefined;
    const prepared = await prepareMcpOAuth(input, repo, snapshot);
    if ("outcome" in prepared) return prepared.outcome.inconclusive ? { region, unreachable: "OAuth refresh unavailable" } : { region, outcome: prepared.outcome };
    const result = await runInRegion(region, prepared.input, repo);
    return "outcome" in result ? { ...result, outcome: addOAuthTiming(result.outcome, prepared.elapsedMs) } : result;
  }

  if (region === AUTO) {
    const outcome = await runCheck(input, repo);
    return outcome.inconclusive ? { region, unreachable: "This location is offline" } : { region, outcome };
  }
  const probe = regions.get(region);
  if (!probe) return { region, unreachable: "Region is not configured on this deployment" };
  const body = JSON.stringify({
    type: input.type, target: input.target, method: input.method, expectedStatus: input.expectedStatus, timeoutMs: input.timeoutMs,
    keyword: input.keyword ?? null, keywordMode: input.keywordMode ?? "contains", expectedLocation: input.expectedLocation ?? null, headers: input.headers ?? {},
    wsMessage: input.wsMessage ?? null, requestBody: input.requestBody ?? null,
    ...(input.type === "mcp" ? { mcpConfig: input.mcpConfig ?? null, mcpBaseline: input.mcpBaseline ?? null } : {}),
  });
  try {
    if (input.type === "mcp") {
      const health = await fetch(probe.url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      const advertised: unknown = health.ok ? JSON.parse(await readCapped(health, 4096)) : null;
      if (!health.ok) void health.body?.cancel();
      if (!Array.isArray((advertised as {capabilities?: unknown} | null)?.capabilities) || !(advertised as {capabilities: unknown[]}).capabilities.includes(MCP_MONITOR_CAPABILITY)) return { region, unreachable: "Probe upgrade required for MCP monitoring" };
    }
    // Old probes ignore unknown fields: verify support BEFORE sending a payload. A positive answer is remembered
    // briefly so every check does not pay for a second request; a rolled-back probe is noticed within CAPABILITY_TTL_MS.
    if (input.type === "http" && (input.requestBody || !["GET", "HEAD", "POST"].includes(input.method)) && (capable.get(probe.url) ?? 0) <= Date.now()) {
      const health = await fetch(probe.url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      const capabilities: unknown = health.ok ? JSON.parse(await readCapped(health, 4096)) : null;
      if (!health.ok) await health.body?.cancel();
      const advertised = (capabilities as { capabilities?: unknown } | null)?.capabilities;
      if (!Array.isArray(advertised) || !advertised.includes(HTTP_REQUEST_CAPABILITY)) {
        capable.delete(probe.url);
        return { region, unreachable: "Probe upgrade required for HTTP request bodies and methods" };
      }
      capable.set(probe.url, Date.now() + CAPABILITY_TTL_MS);
    }
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(probe.url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: await signProbe(secret, ts, body), [ENVELOPE_HEADER]: await signProbeEnvelope(secret, ts, new TextEncoder().encode(body).byteLength) },
      body,
      // the probe enforces timeoutMs itself; this only covers a probe that hangs
      signal: AbortSignal.timeout(input.timeoutMs + 8000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { region, unreachable: `Probe answered ${res.status}` };
    }
    const answer = await (async () => { try { return JSON.parse(await readCapped(res, input.type === "mcp" ? 5 * 1024 * 1024 : 64 * 1024)); } catch { return null; } })();
    // the probe could not even reach the internet: that says nothing about the target, same as a probe we cannot reach
    if ((answer as { inconclusive?: unknown } | null)?.inconclusive === true) return { region, unreachable: "Probe is offline" };
    const outcome = outcomeOf(answer);
    return outcome && (input.type !== "mcp" || outcome.mcp) ? { region, outcome } : { region, unreachable: "Probe answered with something that is not a result" };
  } catch (e) {
    const err = e as Error;
    return { region, unreachable: err.name === "TimeoutError" ? "Probe did not answer in time" : `Probe unreachable: ${err.message}` };
  }
}

/** One run of a monitor: what each answering region saw, and the single outcome the state machine works with. */
export type Measured = { out: CheckOutcome; results: RegionResult[]; note?: string };

/** A run that could not be carried out from here at all: nothing is recorded for it. */
const inconclusive = (out: CheckOutcome): Measured => ({ out, results: [] });

/**
 * Fold the answers of several regions into one run. With `minFailing` 0 the run fails when a strict majority of the
 * regions that answered failed; otherwise when at least that many did, never asking for more than the regions that
 * answered (so a region that is down itself cannot keep a real outage from alerting). One region's bad route or outage
 * therefore pages nobody unless the monitor asks for it. Regions that could not be asked are left out: that is our
 * problem, not the target's. `null` when nobody answered. `note` says in a few words how the regions voted.
 */
export function combine(runs: RegionRun[], minFailing = 0): Measured | null {
  const answered = runs.flatMap((r) => ("outcome" in r ? [{ region: r.region, ...r.outcome }] : []));
  if (!answered.length) return null;
  const results: RegionResult[] = answered.map((a) => ({ region: a.region, ok: a.ok, statusCode: a.statusCode, latencyMs: a.latencyMs, error: a.error }));
  if (answered.length === 1) {
    const { region: _, ...out } = answered[0];
    return { out, results };
  }
  const failed = answered.filter((a) => !a.ok);
  const needed = minFailing > 0 ? Math.min(minFailing, answered.length) : Math.floor(answered.length / 2) + 1;
  if (failed.length >= needed) {
    const first = failed[0];
    const why = first.error ?? (first.statusCode ? `HTTP ${first.statusCode}` : "Check failed");
    return {
      out: { ok: false, statusCode: first.statusCode, latencyMs: first.latencyMs, error: `Failed from ${failed.length} of ${answered.length} regions (${first.region}: ${why})` },
      results,
      note: `${failed.length} of ${answered.length} regions failed`,
    };
  }
  const lat = answered.filter((a) => a.ok && a.latencyMs != null).map((a) => a.latencyMs!);
  const latencyMs = lat.length ? Math.round(lat.reduce((n, v) => n + v, 0) / lat.length) : undefined;
  const best = answered.find((a) => a.ok)!;
  return {
    out: { ok: true, statusCode: best.statusCode, latencyMs },
    results,
    ...(failed.length ? { note: `${failed.length} of ${answered.length} regions failed, ${needed} needed` } : {}),
  };
}

/**
 * Run a monitor's check from the regions it asks for. A monitor on `auto` (the default) never touches a probe. If no
 * probe answers, the check falls back to this location so a probe outage cannot blind monitoring.
 */
export async function measure(m: Monitor, repo?: Repo): Promise<Measured> {
  if (m.type === "mcp" && m.mcpConfig?.oauth) {
    const prepared = await prepareMcpOAuth(m, repo, m);
    if ("outcome" in prepared) return { out: prepared.outcome, results: prepared.outcome.inconclusive ? [] : [{ region: AUTO, ...prepared.outcome }] };
    const result = await measure({ ...m, ...prepared.input }, repo);
    return { ...result, out: addOAuthTiming(result.out, prepared.elapsedMs) };
  }
  const regions = effectiveRegions(m);
  if (regions.length === 1 && regions[0] === AUTO) {
    const out = await runCheck(m, repo);
    if (out.inconclusive) return inconclusive(out);
    return { out, results: [{ region: AUTO, ok: out.ok, statusCode: out.statusCode, latencyMs: out.latencyMs, error: out.error }] };
  }
  const runs = await Promise.all(regions.map((r) => runInRegion(r, m, repo)));
  const lost = runs.flatMap((r) => ("unreachable" in r ? [`${r.region}: ${r.unreachable}`] : []));
  if (lost.length) console.warn(`probes unavailable for ${m.id}: ${lost.join("; ")}`);
  const combined = combine(runs, m.minRegionsFailing);
  if (combined) {
    if (m.type === "mcp") return combineMcp(runs, combined, m);
    return combined;
  }
  // An unreachable MCP probe must never cause an extra potentially mutating call elsewhere.
  if (m.type === "mcp") return inconclusive({ ok: false, inconclusive: true, error: "No MCP probe could execute this check" });
  const out = await runCheck(m, repo);
  if (out.inconclusive) return inconclusive(out);
  return { out, results: [{ region: AUTO, ok: out.ok, statusCode: out.statusCode, latencyMs: out.latencyMs, error: out.error }] };
}


function combineMcp(runs: RegionRun[], combined: Measured, m: Monitor): Measured {
  const answered = runs.flatMap(r => "outcome" in r && r.outcome.mcp ? [{ region: r.region, out: r.outcome, mcp: r.outcome.mcp }] : []);
  const chosen = (combined.out.ok ? answered.find(r => r.out.ok && r.out.degraded) ?? answered.find(r => r.out.ok) : answered.find(r => !r.out.ok)) ?? answered[0];
  if (!chosen) return inconclusive({ ok: false, inconclusive: true, error: "MCP probe returned no diagnostics" });
  const timings: Record<string, number> = {};
  for (const r of answered) for (const [stage, ms] of Object.entries(r.mcp.timings)) timings[stage] = Math.max(timings[stage] ?? 0, ms);
  const sameContract = answered.every(r => r.mcp.toolsComplete === true && mcpToolsEqual(r.mcp.tools, chosen.mcp.tools));
  const prefix = (region: string, message: string) => answered.length > 1 ? `[${region}] ${message}`.slice(0, 500) : message;
  const rank = { breaking: 0, warning: 1, info: 2 };
  const drift = answered.flatMap(r => (r.mcp.drift ?? []).map(change => ({ ...change, message: prefix(r.region, change.message) })))
    .sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 100);
  const changes = answered.flatMap(r => r.mcp.changes.map(change => prefix(r.region, change))).slice(0, 100);
  const observation = { ...chosen.mcp, toolsComplete: sameContract, changes, drift, timings, regions: answered.map(r => ({ region: r.region, ok: r.out.ok, stage: r.mcp.stage, timings: r.mcp.timings, error: r.out.error, degraded: r.out.degraded })) };
  if (!m.mcpBaseline && m.mcpConfig?.schemaCheck && (answered.some(r => !r.out.ok) || !sameContract)) {
    return { ...combined, out: { ...combined.out, ok: false, error: "MCP schema: regions disagree; baseline was not established", mcp: { ...observation, toolsComplete: false, stage: "schema", changes: ["Regions returned different tool schemas or incomplete discovery"] } } };
  }
  return { ...combined, out: { ...combined.out, ...(combined.out.ok && answered.some(r => r.out.ok && r.out.degraded) ? { degraded: true } : {}), mcp: observation } };
}
