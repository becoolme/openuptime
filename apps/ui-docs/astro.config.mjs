import react from "@astrojs/react";
import { defineConfig } from "astro/config";

// Reference pages for packages/ui, generated from its source (scripts/gen-api.mjs). Never deployed.
export default defineConfig({
  output: "static",
  integrations: [react()],
  devToolbar: { enabled: false },
  server: { port: 4330 },
});
