import cloudflare from "@astrojs/cloudflare";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import { listPrecache, stampWorker } from "./src/sw/stamp.mjs";

const API = process.env.API_ORIGIN ?? "http://localhost:8787";
// DEPLOY_TARGET=node builds the Docker flavour: a Node handler that apps/api serves next to /api (no Cloudflare bindings)
const NODE = process.env.DEPLOY_TARGET === "node";

// Writes /sw.js after the build: the worker template with this build's file list and id stamped in (src/sw/stamp.mjs).
const serviceWorker = {
  name: "ou-service-worker",
  hooks: {
    "astro:build:done": ({ dir }) => {
      const root = fileURLToPath(dir);
      const client = [root, join(root, "client")].find((d) => existsSync(join(d, "_astro")));
      if (!client) throw new Error(`service worker: no client build found under ${root}`);
      const template = readFileSync(new URL("./src/sw/sw.js", import.meta.url), "utf8");
      writeFileSync(join(client, "sw.js"), stampWorker(template, listPrecache(client)));
    },
  },
};

export default defineConfig({
  output: "static",
  adapter: NODE ? node({ mode: "middleware" }) : cloudflare(),
  integrations: [react(), serviceWorker],
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
