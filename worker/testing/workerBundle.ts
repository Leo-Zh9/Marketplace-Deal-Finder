/**
 * The Workflow/Cron test seam.
 *
 * `createTestDatabase` gives a D1 handle and nothing else, which is enough for a plain
 * function but not for a Cron trigger or a `WorkflowEntrypoint`: both only exist inside
 * workerd. This bundles THE REAL `worker/index.ts` with vite and hosts it in Miniflare, so
 * a test drives the real `scheduled()` handler, the real Workflow binding, the real
 * `step.do` and the real `cleanupStaleObservations` against the same D1 it holds a handle
 * to.
 *
 * `vite` is already a devDependency -- this adds no dependency. The `cloudflare:` imports
 * are marked external so the bundle keeps them for workerd to resolve; inlining them is
 * exactly what the Node-side stub is for, and is wrong here.
 */

import { build } from "vite";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { applyMigrations } from "./d1";

/** Relative to the vite root, which is the project root vitest runs from. */
const ENTRY = "worker/index.ts";

export interface ScheduledTestWorker {
  db: D1Database;
  /** Deliver a Cron trigger to the hosted Worker, exactly as the platform would. */
  fire: (cron: string, scheduledTimeSeconds: number) => Promise<void>;
  dispose: () => Promise<void>;
}

export const createScheduledTestWorker = async (): Promise<ScheduledTestWorker> => {
  const output = await build({
    configFile: false,
    logLevel: "error",
    build: {
      write: false,
      minify: false,
      target: "es2022",
      lib: { entry: ENTRY, formats: ["es"], fileName: "entry" },
      rollupOptions: { external: (id: string) => id.startsWith("cloudflare:") },
    },
  });
  const bundles = Array.isArray(output) ? output[0] : output;
  const chunk = (bundles as { output: Array<{ code?: string }> }).output[0];
  if (chunk.code === undefined) {
    throw new Error("createScheduledTestWorker: vite produced no bundle");
  }

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: chunk.code,
      compatibilityDate: "2026-09-11",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "test" },
      workflows: { CLEANUP_WORKFLOW: { name: "cleanup", className: "CleanupWorkflow" } },
    } as Parameters<typeof convertV4MiniflareOptions>[0]),
  );

  await mf.ready;
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);

  const worker = await mf.getWorker();
  return {
    db,
    fire: async (cron, scheduledTimeSeconds) => {
      // scheduledTime is delivered in MILLISECONDS, as the platform delivers it. The seam
      // takes seconds and multiplies, so a test cannot accidentally assert the conversion
      // it is trying to prove.
      await (
        worker as unknown as {
          scheduled: (options: { cron: string; scheduledTime: Date }) => Promise<unknown>;
        }
      ).scheduled({ cron, scheduledTime: new Date(scheduledTimeSeconds * 1000) });
    },
    dispose: () => mf.dispose(),
  };
};
