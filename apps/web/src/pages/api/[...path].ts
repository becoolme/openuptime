import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const prerender = false;

/**
 * Same-origin /api for deployments without a zone route (a plain workers.dev install):
 * forwards to the API Worker through the service binding so session cookies stay first-party.
 * When a zone route sends /api/* straight to the API Worker this never runs.
 */
export const ALL: APIRoute = ({ request }) => {
  const api = (env as { API?: { fetch: typeof fetch } }).API;
  if (!api) return new Response(JSON.stringify({ error: "API binding missing" }), { status: 502, headers: { "content-type": "application/json" } });
  return api.fetch(request);
};
