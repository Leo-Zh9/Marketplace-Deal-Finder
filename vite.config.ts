import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    // A port conflict must be a startup error, not a silent move to a port that
    // the Worker's exact-origin CORS does not permit.
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
    css: true,
    // `test.alias` ONLY: the frontend build, `tsc` and eslint never see it, and neither
    // does the Worker bundle wrangler deploys. wrangler requires the Workflow class to be
    // exported from the main entry, so `worker/index.test.ts` -- which imports that entry
    // in Node -- would otherwise die with `Cannot find package 'cloudflare:workers'`.
    // Vitest resolves this bare relative string from the PROJECT ROOT, not from the
    // importing file. If that ever stops being true the failure is loud: every test that
    // imports the entry fails to resolve the module on the first run.
    alias: { "cloudflare:workers": "./worker/testing/cloudflareWorkers.ts" },
  },
});
