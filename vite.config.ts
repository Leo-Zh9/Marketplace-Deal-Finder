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
    // The heaviest tests -- runCleanup R2/R7, cleanupWorkflow H1 -- seed tens of groups and run
    // full cleanup passes against miniflare D1. Measured on this machine: R2 takes ~1.5s and R7
    // ~1.8s for a single suite, but ~3.2s when three suites run concurrently, which is what
    // happens when several agents verify at once. Against vitest's 5s default that is a 1.6x
    // margin, and it has crossed: `Error: Test timed out in 5000ms` at 5124ms, roughly 1 run in
    // 20. Nothing was slow or wrong -- the clock ran out under load, and a timeout failure is
    // indistinguishable from a real regression on a repo with no CI, where one local run is the
    // whole verification.
    //
    // 15s restores a ~8x margin on the slowest test. The cost: a genuinely hung test now takes
    // 15s to surface instead of 5s. Accepted -- only the hung test waits, and 5s was never a
    // deliberate performance assertion about these tests, just the default they happened to sit
    // near.
    testTimeout: 15_000,
    // runMonitor.test.ts R3 is the suite's only `console` spy. It restores itself on the success
    // path, but a failure between `spyOn` and `mockRestore` would leak a SILENCING spy into the
    // rest of that file -- only ever inside an already-red run, so it can never produce a false
    // green, but it can make a red run unreadable. One line, and the red run stays legible.
    restoreMocks: true,
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
