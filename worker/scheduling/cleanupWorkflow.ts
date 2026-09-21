/**
 * The one module that imports the platform at runtime, and therefore the one a Node test
 * cannot import without the vitest alias in vite.config.ts.
 *
 * IT CONTAINS NO LOGIC ON PURPOSE. Everything testable is in runCleanup.ts, so the stub the
 * alias substitutes in Node can never hide a behavioural bug: there is no behaviour here to
 * hide. `cleanupWorkflow.test.ts` drives this class for real, inside workerd, through the
 * bundled entry.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { runCleanup, type CleanupParams, type CleanupRun } from "./runCleanup";

export interface CleanupEnvironment {
  DB: D1Database;
}

export class CleanupWorkflow extends WorkflowEntrypoint<CleanupEnvironment, CleanupParams> {
  override async run(
    event: Readonly<WorkflowEvent<CleanupParams>>,
    step: WorkflowStep,
  ): Promise<CleanupRun> {
    // No fourth argument. Production never tunes: every knob is a module constant.
    return runCleanup(this.env.DB, step, event.payload);
  }
}
