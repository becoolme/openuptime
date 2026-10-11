import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const prerender = false;

/**
 * OAuth discovery documents live at the site root (RFC 8414 / RFC 9728), outside the zone's /api/* route,
 * so agents' discovery requests land here and are handed to the API Worker.
 */
export const GET: APIRoute = ({ request }) => {
  const api = (env as { API?: { fetch: typeof fetch } }).API;
  if (!api) return new Response(JSON.stringify({ error: "API binding missing" }), { status: 502, headers: { "content-type": "application/json" } });
  return api.fetch(request);
};
