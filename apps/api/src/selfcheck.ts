/**
 * Is it the target that is down, or is it us? A check that fails at the network level (DNS, connect, timeout) says
 * nothing about the target when the machine running it has lost its own connection. Before such a failure is recorded
 * the prober therefore fetches a few well-known public URLs; if none answers, the result is discarded as inconclusive
 * instead of opening an outage.
 */

export const REFERENCE_URLS = [
  "https://www.cloudflare.com/cdn-cgi/trace",
  "https://www.gstatic.com/generate_204",
  "https://www.apple.com/library/test/success.html",
];
let configured: string[] | undefined;

/**
 * `SELFCHECK_URLS`: comma-separated reference URLs; an empty value switches the self-check off; unset keeps the defaults.
 * A value with no usable URL in it is a typo, not a wish to switch off: it is reported and the defaults stay.
 */
export function configureSelfCheck(value: string | undefined) {
  if (value === undefined) {
    configured = undefined;
    return;
  }
  if (!value.trim()) {
    configured = [];
    return;
  }
  const urls = value.split(",").map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u));
  if (!urls.length) console.warn("SELFCHECK_URLS has no valid http(s) URL; using the default reference URLs. Set it to an empty value to switch the self-check off.");
  configured = urls.length ? urls : undefined;
}

const REFERENCE_TIMEOUT_MS = 2500;
/** A verdict is shared for this long, so a burst of failing checks asks the network once. */
const VERDICT_TTL_MS = 5000;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Sequential on purpose: the usual case is one request, and a Worker has few subrequests to spare. */
async function probeReferences(urls: string[], doFetch: Fetcher): Promise<boolean> {
  for (const url of urls) {
    try {
      const res = await doFetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(REFERENCE_TIMEOUT_MS) });
      await res.body?.cancel().catch(() => {});
      return true; // any HTTP answer proves DNS, routing and TLS work from here
    } catch { /* try the next one */ }
  }
  return false;
}

let inflight: Promise<boolean> | undefined;
let last: { at: number; online: boolean } | undefined;

/** Resolves true when this machine can reach the internet. Concurrent callers share one verdict. */
export function proberOnline(opts: { urls?: string[]; fetch?: Fetcher; now?: () => number } = {}): Promise<boolean> {
  const urls = opts.urls ?? configured ?? REFERENCE_URLS;
  // no reference URLs: the self-check is off, every failure counts against the target
  if (!urls.length) return Promise.resolve(true);
  const now = (opts.now ?? Date.now)();
  if (last && now - last.at < VERDICT_TTL_MS) return Promise.resolve(last.online);
  if (inflight) return inflight;
  const run = probeReferences(urls, opts.fetch ?? ((u, i) => fetch(u, i)))
    .then((online) => {
      last = { at: now, online };
      return online;
    })
    .finally(() => { inflight = undefined; });
  inflight = run;
  return run;
}

/** Forgets the shared verdict (tests). */
export function resetSelfCheck() {
  inflight = undefined;
  last = undefined;
}

// ---- classifying errors --------------------------------------------------------------------------------------------

/** Errors that come from this machine's own network stack, whatever the target is: no route, no address family. */
const PROBER_SIDE = new Set(["EADDRNOTAVAIL", "ENETUNREACH", "ENETDOWN", "EAFNOSUPPORT"]);

/**
 * An aggregate (several addresses tried) is prober-side only when every attempt is: an attempt with no code at all (a
 * slice that timed out, an abort) may well be the target being slow, and one reachable-but-failing address is the target's.
 */
function proberSide(e: unknown, depth = 0): boolean {
  if (!e || typeof e !== "object" || depth > 3) return false;
  const o = e as { code?: unknown; cause?: unknown; errors?: unknown };
  if (Array.isArray(o.errors) && o.errors.length) return o.errors.every((x) => proberSide(x, depth + 1));
  if (typeof o.code === "string") return PROBER_SIDE.has(o.code);
  return proberSide(o.cause, depth + 1);
}

/** True when the failure (every attempt of it, for an aggregate) is one only the prober's own network can cause (e.g. IPv6 requested, no IPv6 route). */
export function proberSideError(e: unknown): boolean {
  return proberSide(e);
}

/** A failure that happened while reaching the target (as opposed to a refused target or a bad answer). */
export function networkLevelError(e: unknown): boolean {
  return !(e instanceof Error && e.name === "BlockedTarget");
}
