import { env } from "cloudflare:workers";

/** Server-side access to the API Worker (SSR pages). */
// the Docker image sets API_ORIGIN at runtime (same process, loopback); elsewhere it is a build-time value
export const API_ORIGIN: string = (typeof process !== "undefined" ? process.env.API_ORIGIN : undefined) ?? import.meta.env.API_ORIGIN ?? "http://localhost:8787";

/** Where "Powered by OpenUptime" points: the product's own site. Set PRODUCT_URL (a Worker var, or the process environment) to change it. */
export const PRODUCT_URL: string =
  (typeof process !== "undefined" ? process.env.PRODUCT_URL : undefined) ?? (env as { PRODUCT_URL?: string }).PRODUCT_URL ?? import.meta.env.PRODUCT_URL ?? "https://openuptime.app";

/** In production the API Worker is reached through a service binding (a same-zone fetch would not hit its route). */
// (in `astro dev` the binding points at a Worker that is not running, so use API_ORIGIN there)
const binding = import.meta.env.PROD ? (env as { API?: { fetch: typeof fetch } }).API : undefined;

export async function apiFetch<T>(path: string, request?: Request): Promise<{ status: number; data: T | null; privateResponse: boolean }> {
  const init = { headers: { cookie: request?.headers.get("cookie") ?? "" } };
  const res = binding ? await binding.fetch(`https://openuptime.internal${path}`, init) : await fetch(`${API_ORIGIN}${path}`, init);
  return { status: res.status, privateResponse: /private|no-store/i.test(res.headers.get("cache-control") ?? ""), data: res.ok ? ((await res.json()) as T) : null };
}

/** Fetches several API GETs in parallel for SSR; failed ones are simply left out (the client falls back to its own request). */
export async function preload(request: Request, paths: string[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  await Promise.all(
    paths.map(async (p) => {
      try {
        const r = await apiFetch<unknown>(p, request);
        if (r.data != null) out[p] = r.data;
      } catch {}
    }),
  );
  return out;
}
