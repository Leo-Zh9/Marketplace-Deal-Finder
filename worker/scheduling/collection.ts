/**
 * Steps 3-4 of the Monitoring Workflow -- "bootstrap the source once" and "for each
 * component: retrieve / normalize / persist / aggregate / queue".
 *
 * COLLECTION IS PARKED (3A/3B), SO THIS FILE HAS NO LOGIC AND ONE EMPTY ARRAY. What it does
 * have is the contract, so that filling it later is an addition rather than a redesign: the
 * loop that will drive collection ALREADY EXISTS AND ALREADY RUNS in runMonitor -- it
 * iterates an empty list. Nothing about the shape of a run changes when the array is
 * populated.
 *
 * A `readonly []` rather than a `CollectionStep | null` constant is deliberate: a nullable
 * const invites TypeScript to narrow it to `null` at the use site and turns the guard into an
 * always-false condition lint flags. An empty array types cleanly, executes zero times and
 * needs no guard.
 */

import type { D1Usage } from "../storage/types";

export interface CollectionContext {
  db: D1Database;
  /** The frozen scheduled instant, epoch SECONDS -- the same `now` the whole run uses. */
  now: number;
  searchRevision: number;
  runId: string;
}

export interface CollectionOutcome {
  /** OPAQUE. runMonitor never branches on it, and nothing here names a provider. */
  source: string;
  requestCount: number;
  resultCount: number;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  /** The provider was unavailable: the counts are partial and the aggregate is untouched. */
  degraded: boolean;
  usage: D1Usage;
}

export interface CollectionStep {
  /** Unique; becomes the `collect-${name}` step name and one `selected_components` entry. */
  name: string;
  run: (context: CollectionContext) => Promise<CollectionOutcome>;
}

/**
 * THE CONTRACT, stated so an implementer needs nothing else:
 *
 * 1. ONE ENTRY PER SELECTED COMPONENT. Each runs as its own `step.do(`collect-${name}`)`, and
 *    distinct names are load-bearing: `step.do` memoizes BY NAME, so two steps sharing a name
 *    return the first one's result forever.
 *
 * 2. ALL OF A STEP'S WRITING GOES THROUGH ONE db.batch. That is the only atomicity primitive
 *    D1 offers and the only one this design has. BEGIN TRANSACTION and SAVEPOINT are
 *    rejected.
 *
 * 3. THE LOCK IS ADVISORY AND YOU MAY NOT BUILD ON IT. runMonitor checks the fence inside the
 *    same step body before calling `run()`, but MEMOIZATION IS NOT ATOMICITY: the check and
 *    the work are two D1 round trips with a real window between them, and `step.do`
 *    guarantees at-most-once, not indivisibility. The check bounds wasted work and gives
 *    LOCK_LOST somewhere to be reported -- nothing more. Every collection step's writes must
 *    be idempotent under replay THE WAY recordSightings' are: JavaScript chooses which
 *    statements to send, SQL computes every amount from the row's current stored value inside
 *    the transaction. If you find yourself binding a number you read a moment ago, stop.
 *
 * 4. A PROVIDER OUTAGE SETS `degraded: true` AND LEAVES THE AGGREGATE ALONE -- the spec's
 *    "source unavailable" branch. runMonitor reports the run DEGRADED and continues.
 *
 * 5. `selected_components` FILLS ITSELF from this array. `[]` today for a real reason, and
 *    correct the moment the array is populated.
 *
 * 6. THE DRAIN NEEDS NOTHING FROM COLLECTION. Sources are discovered from evaluation_tasks,
 *    where collection will have just written them.
 *
 * 7. ADDING A SOURCE IS A DRAIN-BUDGET CHANGE. MAX_DRAIN_SOURCES is DERIVED from the batch
 *    budget (DRAIN_STEPS * BATCHES_PER_DRAIN_STEP), so a source beyond the budget cannot be
 *    introduced by editing a cap in isolation. Discovery orders ascending, so a cap below the
 *    source count would starve THE SAME sources every run, forever.
 */
export const COLLECTION_STEPS: readonly CollectionStep[] = [];
