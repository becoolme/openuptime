import type { Monitor, RegionResult } from "@openuptime/repo";
import { runCheck, type CheckInput, type CheckOutcome } from "./checker";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signProbe } from "./probe-protocol";
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
export type ProbeRegion = { id: string; name: string; url: string };

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
    out.push({ id, name, url: u.toString() });
  }
  return { regions: out, problems };
}

/** Env values are constant per deployment, so a module-level config is safe in a Worker isolate; parsed once. */
export function configureProbes(env: { PROBE_REGIONS?: string; PROBE_SECRET?: string }) {
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

export const isRegionConfigured = (id: string) => id === AUTO || regions.has(id);

/** What running a check in one region came to: an outcome, or that the region could not be asked at all. */
export type RegionRun = { region: string; outcome: CheckOutcome } | { region: string; unreachable: string };

const outcomeOf = (v: unknown): CheckOutcome | null => {
  const o = v as { ok?: unknown; statusCode?: unknown; latencyMs?: unknown; error?: unknown } | null;
  if (!o || typeof o.ok !== "boolean") return null;
  return {
    ok: o.ok,
    ...(typeof o.statusCode === "number" ? { statusCode: o.statusCode } : {}),
    ...(typeof o.latencyMs === "number" ? { latencyMs: o.latencyMs } : {}),
    ...(typeof o.error === "string" ? { error: o.error.slice(0, 500) } : {}),
  };
};

/**
 * Run a check from `region`. A probe that cannot be reached, refuses us or answers nonsense is `unreachable`: that says
 * nothing about the target, so callers must not count it as a failed check.
 */
export async function runInRegion(region: string, input: CheckInput): Promise<RegionRun> {
  if (region === AUTO) return { region, outcome: await runCheck(input) };
  const probe = regions.get(region);
  if (!probe) return { region, unreachable: "Region is not configured on this deployment" };
  const body = JSON.stringify({
    type: input.type, target: input.target, method: input.method, expectedStatus: input.expectedStatus, timeoutMs: input.timeoutMs,
    keyword: input.keyword ?? null, keywordMode: input.keywordMode ?? "contains", headers: input.headers ?? {},
  });
  try {
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(probe.url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: await signProbe(secret, ts, body) },
      body,
      // the probe enforces timeoutMs itself; this only covers a probe that hangs
      signal: AbortSignal.timeout(input.timeoutMs + 8000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { region, unreachable: `Probe answered ${res.status}` };
    }
    const outcome = outcomeOf(await res.json().catch(() => null));
    return outcome ? { region, outcome } : { region, unreachable: "Probe answered with something that is not a result" };
  } catch (e) {
    const err = e as Error;
    return { region, unreachable: err.name === "TimeoutError" ? "Probe did not answer in time" : `Probe unreachable: ${err.message}` };
  }
}

/** One run of a monitor: what each answering region saw, and the single outcome the state machine works with. */
export type Measured = { out: CheckOutcome; results: RegionResult[] };

/**
 * Fold the answers of several regions into one run. The run fails when a strict majority of the regions that answered
 * failed, so one region's bad route or outage does not page anyone. Regions that could not be asked are left out: that
 * is our problem, not the target's. `null` when nobody answered.
 */
export function combine(runs: RegionRun[]): Measured | null {
  const answered = runs.flatMap((r) => ("outcome" in r ? [{ region: r.region, ...r.outcome }] : []));
  if (!answered.length) return null;
  const results: RegionResult[] = answered.map((a) => ({ region: a.region, ok: a.ok, statusCode: a.statusCode, latencyMs: a.latencyMs, error: a.error }));
  if (answered.length === 1) {
    const { region: _, ...out } = answered[0];
    return { out, results };
  }
  const failed = answered.filter((a) => !a.ok);
  if (failed.length * 2 > answered.length) {
    const first = failed[0];
    const why = first.error ?? (first.statusCode ? `HTTP ${first.statusCode}` : "Check failed");
    return {
      out: { ok: false, statusCode: first.statusCode, latencyMs: first.latencyMs, error: `Failed from ${failed.length} of ${answered.length} regions (${first.region}: ${why})` },
      results,
    };
  }
  const lat = answered.filter((a) => a.ok && a.latencyMs != null).map((a) => a.latencyMs!);
  const latencyMs = lat.length ? Math.round(lat.reduce((n, v) => n + v, 0) / lat.length) : undefined;
  const best = answered.find((a) => a.ok)!;
  return { out: { ok: true, statusCode: best.statusCode, latencyMs }, results };
}

/**
 * Run a monitor's check from the regions it asks for. A monitor on `auto` (the default) never touches a probe. If no
 * probe answers, the check falls back to this location so a probe outage cannot blind monitoring.
 */
export async function measure(m: Monitor): Promise<Measured> {
  const regions = effectiveRegions(m);
  if (regions.length === 1 && regions[0] === AUTO) {
    const out = await runCheck(m);
    return { out, results: [{ region: AUTO, ok: out.ok, statusCode: out.statusCode, latencyMs: out.latencyMs, error: out.error }] };
  }
  const runs = await Promise.all(regions.map((r) => runInRegion(r, m)));
  const lost = runs.flatMap((r) => ("unreachable" in r ? [`${r.region}: ${r.unreachable}`] : []));
  if (lost.length) console.warn(`probes unavailable for ${m.id}: ${lost.join("; ")}`);
  const combined = combine(runs);
  if (combined) return combined;
  const out = await runCheck(m);
  return { out, results: [{ region: AUTO, ok: out.ok, statusCode: out.statusCode, latencyMs: out.latencyMs, error: out.error }] };
}
