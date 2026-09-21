/**
 * The cleanup orchestration: bounding, continuation and reporting around 3C's
 * `cleanupStaleObservations`. It reimplements none of that function's logic.
 *
 * NOTHING HERE IMPORTS THE PLATFORM AT RUNTIME. The only `cloudflare:workers` reference is
 * a TYPE, erased at build time, so this module is a plain function a Node test can import
 * and drive with a fake stepper. `cleanupWorkflow.ts` holds the one class that cannot be.
 *
 * WHAT THE STEP BOUNDARY IS AND IS NOT. Idempotence lives in `cleanupStaleObservations`'
 * SQL: CLEAN_A and CLEAN_B share one `db.batch` and one predicate, and the amounts are
 * computed by subqueries at execution time, so a re-run matches nothing and subtracts
 * nothing. The Workflow contributes BOUNDING AND CONTINUATION and contributes nothing to
 * correctness under retry. That is why a divergence between miniflare's local step
 * semantics and production's costs repeated work, never wrong data.
 */

import { cleanupStaleObservations } from "../storage/cleanupStaleObservations";
import { STALE_AFTER_SECONDS, type CleanupReport, type D1Usage } from "../storage/types";
import type { WorkflowStepConfig } from "cloudflare:workers";

/**
 * THE WORKFLOW PAYLOAD IS ONE FIELD, AND THAT IS THE POINT.
 *
 * Every field on this type is a production input surface: `handleScheduled` puts it there,
 * but so does a hand-written `wrangler workflows trigger '<json>'`, which the runbook
 * teaches. The tuning knobs exist only so tests can override them, so they live in a fourth
 * argument that only tests pass -- and an unexpected key in a hand-written payload is then
 * INERT, not merely rejected. Measured: with `staleAfterSeconds` reachable from the payload,
 * `{"now":...,"staleAfterSeconds":0}` empties both price_observations and model_stats.
 */
export interface CleanupParams {
  now: number;
}

/** Test-only overrides. NEVER on the Workflow payload. */
export interface CleanupOptions {
  staleAfterSeconds?: number;
  groupsPerBatch?: number;
  batchesPerStep?: number;
  maxSteps?: number;
  rowsReadBudget?: number;
}

export const GROUPS_PER_BATCH = 25;

/**
 * THE UN-INTERRUPTIBLE GRANULE: one batch per step.
 *
 * Cost is superlinear in the stale set, because only `last_seen_at` is indexed and each
 * group re-walks the expired range -- ~160 rows per group in steady state, ~4,600 at mass
 * expiry, ~16,600 at 400 groups. A budget checked at a coarse granule bounds nothing,
 * because the granule's own cost is unbounded. At one batch per step the budget is checked
 * after at most 25 groups, so the effective cap is the budget plus one granule.
 */
export const BATCHES_PER_STEP = 1;
export const MAX_STEPS = 32;
export const ROWS_READ_BUDGET = 1_000_000;

/**
 * Two retries, not the platform default. Measured against miniflare: the default ladder is
 * SIX body executions over ~31s, and at up to ~415k rows read for a worst-case granule that
 * is a budget event rather than a retry. See docs/phase-3e-scheduling.md.
 */
export const CLEANUP_STEP_CONFIG = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
} as const satisfies WorkflowStepConfig;

/**
 * The narrow slice of `WorkflowStep` this module uses. The real `WorkflowStep` is assignable
 * to it with no cast, which is what lets the tests drive the real code with a fake stepper.
 */
export interface CleanupStepper {
  do(
    name: string,
    config: WorkflowStepConfig,
    callback: () => Promise<CleanupReport>,
  ): Promise<CleanupReport>;
}

export type CleanupStop = "exhausted" | "budget" | "step-cap";

export interface CleanupRun {
  cutoff: number;
  steps: number;
  groups: number;
  observationsDeleted: number;
  aggregatesPruned: number;
  remaining: boolean;
  stoppedBecause: CleanupStop;
  usage: D1Usage;
}

export const runCleanup = async (
  db: D1Database,
  step: CleanupStepper,
  params: CleanupParams,
  options: CleanupOptions = {},
): Promise<CleanupRun> => {
  // `now` is EPOCH SECONDS, and the catastrophic failure mode of this Workflow is a wrong
  // cutoff. 1e9 = 2001-09-09; 1e11 = year 5138. Milliseconds (~1.8e12) are inside neither
  // bound; microseconds (~1.8e15) and nanoseconds (~1.8e18) are above the band, and
  // nanoseconds also fail isSafeInteger.
  if (!Number.isSafeInteger(params.now) || params.now < 1e9 || params.now > 1e11) {
    throw new Error(`runCleanup: now must be epoch seconds, got ${params.now}`);
  }

  // Resolved from `options`, NEVER from `params`. This is the line that makes an extra
  // payload key inert.
  const staleAfterSeconds = options.staleAfterSeconds ?? STALE_AFTER_SECONDS;
  const groupsPerBatch = options.groupsPerBatch ?? GROUPS_PER_BATCH;
  const batchesPerStep = options.batchesPerStep ?? BATCHES_PER_STEP;
  const maxSteps = options.maxSteps ?? MAX_STEPS;
  const rowsReadBudget = options.rowsReadBudget ?? ROWS_READ_BUDGET;

  const run: CleanupRun = {
    // `now` is captured once from controller.scheduledTime, so the cutoff is stable across
    // every continuation of this instance -- and it is REPORTED, so a wrong cutoff is
    // visible in `wrangler workflows instances describe` without a database query.
    cutoff: params.now - staleAfterSeconds,
    steps: 0,
    groups: 0,
    observationsDeleted: 0,
    aggregatesPruned: 0,
    remaining: false,
    stoppedBecause: "exhausted",
    usage: { rowsRead: 0, rowsWritten: 0 },
  };

  for (let index = 0; index < maxSteps; index += 1) {
    // DISTINCT STEP NAMES, and that is load-bearing: `step.do` memoizes by name, so a
    // constant name would return step 0's report forever and the loop would never advance.
    const report = await step.do(`cleanup-${index}`, CLEANUP_STEP_CONFIG, () =>
      cleanupStaleObservations(db, {
        now: params.now,
        staleAfterSeconds,
        groupsPerBatch,
        maxBatches: batchesPerStep,
      }),
    );

    run.steps += 1;
    run.groups += report.groups;
    run.observationsDeleted += report.observationsDeleted;
    run.aggregatesPruned += report.aggregatesPruned;
    run.usage.rowsRead += report.usage.rowsRead;
    run.usage.rowsWritten += report.usage.rowsWritten;
    run.remaining = report.remaining;

    // `remaining: true` is the ONLY continue condition. It is set only when the batch loop
    // stopped at maxBatches with the previous batch full; a short batch proves exhaustion.
    if (!report.remaining) {
      run.stoppedBecause = "exhausted";
      return run;
    }
    if (run.usage.rowsRead >= rowsReadBudget) {
      run.stoppedBecause = "budget";
      return run;
    }
  }

  // Out of steps with work left. Unfinished work is persisted by simply not having been
  // done: the rows stay stale and tomorrow's Cron finishes them.
  run.stoppedBecause = "step-cap";
  return run;
};
