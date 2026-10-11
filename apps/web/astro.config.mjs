import cloudflare from "@astrojs/cloudflare";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

const API = process.env.API_ORIGIN ?? "http://localhost:8787";
// DEPLOY_TARGET=node builds the Docker flavour: a Node handler that apps/api serves next to /api (no Cloudflare bindings)
const NODE = process.env.DEPLOY_TARGET === "node";

export default defineConfig({
  output: "static",
  adapter: NODE ? node({ mode: "middleware" }) : cloudflare(),
  integrations: [react()],
  build: { format: "file" }, // /app is served from app.html: no redirect to /app/
  trailingSlash: "never",
  prefetch: false, // the back office is a client-routed SPA; public pages are single hops
  server: { port: 4321 },
  vite: {
    // the runtime image ships no node_modules: inline every dependency into the server build
    ssr: NODE ? { noExternal: true } : {},
    resolve: NODE ? { alias: { "cloudflare:workers": new URL("./src/lib/cf-stub.ts", import.meta.url).pathname } } : {},
    // same-origin /api in dev, so session cookies just work; in prod route /api/* to the API Worker
    server: { proxy: { "/api": API } },
  },
});
