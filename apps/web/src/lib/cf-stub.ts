/** Stand-in for `cloudflare:workers` in the Node (Docker) build: there are no bindings, SSR reaches the API over HTTP. */
export const env: Record<string, unknown> = {};
