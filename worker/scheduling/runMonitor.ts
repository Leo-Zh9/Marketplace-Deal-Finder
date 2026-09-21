/**
 * The monitoring orchestration: the run lock, the settings load, the collection seam, the
 * evaluation drain and the run's own durable record. It reimplements none of the functions it
 * drives -- `evaluateBatch` is not modified by this phase, not one line.
 *
 * NOTHING HERE IMPORTS THE PLATFORM AT RUNTIME. The only `cloudflare:workers` reference is a
 * TYPE, erased at build time, so this module is a plain function a Node test can import and
 * drive with a fake stepper. `monitorWorkflow.ts` holds the one class that cannot be.
 *
 * WHAT THE STEP BOUNDARY IS AND IS NOT. `step.do` memoizes by name and guarantees at-most-once
 * per instance. IT IS NOT A TRANSACTION. The lock check and the work that follows it are two
 * D1 round trips with a real window between them; the only atomicity primitive is a single
 * db.batch, and the one thing this file requires to be indivisible -- record the run, prune the
 * log, release the lock -- is exactly one.
 *
 * EVERY DECISION THE ORCHESTRATOR MAKES IS DERIVED FROM STEP RETURN VALUES, never from state a
 * step body mutated: which sources are exhausted, the round-robin position, the usage totals.
 * A replay rebuilds identical decisions from memoized results. The lease token is the
 * deliberate exception -- it MUST be fresh per execution, and §"the lease token" below is why.
 */

import { evaluateBatch } from "../evaluation/evaluateBatch";
import { EVALUATION_BATCH_SIZE, type EvaluationSettings } from "../evaluation/types";
import { loadCurrentSettings } from "../search/settings";
import type { D1Usage } from "../storage/types";
import { COLLECTION_STEPS, type CollectionStep } from "./collection";
import {
  acquireMonitorLock,
  monitorLockHeld,
  releaseStatement,
  MONITOR_LOCK_SECONDS,
} from "./monitorLock";
import {
  readPreviousRun,
  recordMonitorRun,
  MONITOR_RUN_RETENTION,
  type MonitorRunRecord,
} from "./monitorRuns";
import type { WorkflowStepConfig } from "cloudflare:workers";

/**
 * THE WORKFLOW PAYLOAD IS ONE FIELD, AND THAT IS THE POINT.
 *
 * Every field on this type is a production input surface: `handleScheduled` puts it there, but
 * so does a hand-written `wrangler workflows trigger '<json>'`, which the runbook teaches. The
 * tuning knobs exist only so tests can override them, so they live in a fifth argument that
 * only tests pass -- and an unexpected key in a hand-written payload is then INERT, not merely
 * rejected. 3E-a measured what the alternative costs: with `staleAfterSeconds` reachable from
 * the cleanup payload, one hand-written trigger emptied two tables.
 */
export interface MonitorParams {
  now: number;
}

/** Test-only overrides. NEVER on the Workflow payload. */
export interface MonitorOptions {
  lockSeconds?: number;
  drainSteps?: number;
  batchesPerDrainStep?: number;
  batchSize?: number;
  maxSources?: number;
  retentionRuns?: number;
  collectionSteps?: readonly CollectionStep[];
}

export type MonitorStatus = "OK" | "SKIPPED_LOCKED" | "NO_SETTINGS" | "LOCK_LOST" | "DEGRADED";

/**
 * Status PRECEDENCE, lowest rank wins. A run can reach more than one of these -- a drain step
 * can fail after the lock was already lost -- and the one that must survive is the one that
 * explains the least work done. Assignment rather than escalation is a real mutation: it lets
 * a later OK overwrite SKIPPED_LOCKED, and a skipped run then reads as a successful one.
 */
const STATUS_RANK: Record<MonitorStatus, number> = {
  SKIPPED_LOCKED: 0,
  NO_SETTINGS: 1,
  LOCK_LOST: 2,
  DEGRADED: 3,
  OK: 4,
};

/**
 * Three drain steps of two batches: 6 batches x 15 tasks = 90 tasks per run.
 *
 * WHY MORE THAN ONE BATCH PER STEP HERE, when `runCleanup` pins BATCHES_PER_STEP = 1. That
 * constant exists because cleanup's granule cost is UNBOUNDED -- superlinear in the stale set,
 * measured at 443,301 rows for one 25-group batch -- so a budget checked at a coarser granule
 * bounds nothing. The drain's granule is BOUNDED AND FLAT: the tiered claim measures 141 rows
 * at 200, 5,000 and 20,000 eligible alike, and a full 15-task batch measures 150 read / 120
 * written, a partial 121/80, an empty-queue batch 14/0. A bounded granule is safe to multiply.
 *
 * THE READ FIGURE MOVES WITH HOW MANY CLAIM TIERS RUN, not with fixture size -- measured at 135
 * when tier 1 alone fills the batch, 146 across all four, and 14 on an empty queue, and measured
 * IDENTICAL (135/120) with and without a model_stats row. Review measured 135 where the probe
 * above measured 150; the spread is the tier count, and it does not touch the argument, because
 * THE WRITES ARE WHAT BIND and they are exactly 120 in every fixture either party built.
 * That asymmetry is the whole justification and is the first thing to re-check if either
 * constant moves.
 *
 * THE WRITE ALLOWANCE IS WHAT BINDS, not the read allowance. `rows_written` includes index
 * entries, so 120 written for 15 completions is 8 per task (three explicit indexes plus the
 * autoindex):
 *
 *   worst case per run = 6 x (15 x 8)   =    720 rows written
 *   per day (48 runs)                   = 34,560         -> 34.6% of D1's 100,000/day
 *
 * and it is why DRAIN_STEPS is 3 and not 4: at 8 batches/run that is 46,080/day (46%), and
 * collection has not spent anything yet. The worst case is the STEADY STATE, not an outlier --
 * tier 3 (NEEDS_REVIEW) is unconditionally eligible on every call by design, so any standing
 * backlog means every run spends all six batches forever. runMonitor.test.ts R12 pins the sum.
 */
export const DRAIN_STEPS = 3;
export const BATCHES_PER_DRAIN_STEP = 2;

/**
 * DERIVED FROM THE BUDGET, NOT CHOSEN -- and the derivation is the mechanism, not a check on
 * one. Discovery orders by MIN(source) ascending, so a cap below the source count starves THE
 * SAME sources every run, forever: the tier-3 fixed-point failure one layer up. With the cap
 * equal to the batch budget, `sources.length <= MAX_DRAIN_SOURCES <= totalBatches`, so every
 * discovered source receives at least one batch. That is arithmetic, not a fixture, and it
 * cannot be violated rather than merely being caught when it is -- which is why there is no
 * assertion here to go with it: against a derived constant, the condition can never be false,
 * and a line no mutation can kill is exactly what this design refuses elsewhere.
 *
 * Production safety is therefore BY CONSTRUCTION. Option-level starvation -- reachable only
 * through the test-only `maxSources` -- is BY REPORT: `undrainedSources` names the sources
 * that received zero batches, and runMonitor.test.ts R8 exercises it.
 */
export const MAX_DRAIN_SOURCES = DRAIN_STEPS * BATCHES_PER_DRAIN_STEP;

/**
 * ONE retry, not `runCleanup`'s two, and the retry count and the lease-token design are ONE
 * decision. Each retry re-claims up to `batchesPerDrainStep x batchSize` further tasks and
 * strands them in PROCESSING until the next fire -- and recovery is NOT within the same run:
 * `now` is frozen, so tier 2's `lease_expires_at <= ?5` evaluates as `T+300 <= T`, which is
 * false. The strand costs work, never corruption, and clears at the next fire.
 *
 * Measured: `limit: 1` produces exactly two body executions -- which is precisely why the
 * lease token must carry a fresh UUID per claim. See `drainLeaseToken`.
 */
export const MONITOR_STEP_CONFIG = {
  retries: { limit: 1, delay: "10 seconds", backoff: "exponential" },
} as const satisfies WorkflowStepConfig;

/** Bounded so one pathological run cannot write an unbounded TEXT column. */
export const MAX_RUN_ERRORS = 5;
export const MAX_RUN_ERROR_CHARS = 200;

/**
 * SOURCES ARE DISCOVERED FROM `evaluation_tasks` ITSELF, which is self-bootstrapping: a source
 * exists exactly when it has tasks. No config, no literal, nothing source-specific.
 *
 * A SEEK LOOP, NOT `SELECT DISTINCT source`. Measured:
 *
 *   1 source x 20,000 tasks   DISTINCT 20,000 rows read   seek 2 rows / 2 statements
 *   3 sources x 5,000 tasks   DISTINCT 15,000 rows read   seek 4 rows / 4 statements
 *   empty table               DISTINCT      1 rows read   seek 1 row  / 1 statement
 *
 * EXPLAIN: DISTINCT is `SCAN ... USING COVERING INDEX`; the seek is
 * `SEARCH ... (source>?)`. Flat in table size versus linear -- at 48 runs/day over 20,000
 * tasks, DISTINCT costs 960,000 rows read per day to learn one source name.
 */
export const DISCOVER_FIRST = `SELECT MIN(source) AS s FROM evaluation_tasks`;
/** ?1 = the previous source. `>` and not `>=`: `>=` returns the same source forever. */
export const DISCOVER_NEXT = `SELECT MIN(source) AS s FROM evaluation_tasks WHERE source > ?1`;

export interface DiscoveredSources {
  sources: string[];
  /** The cap was hit and at least one more source exists. */
  truncated: boolean;
  /** The first undiscovered source, or null. Reported, never used to drive anything. */
  overflow: string | null;
  usage: D1Usage;
}

/**
 * TRUNCATION IS RECORDED, AND IT IS FREE. The loop's shape already fetches the overflow name:
 * after it stops on the cap, `cursor` is either null (that was all of them) or the name of the
 * first source that did not fit. A `sources` array of four names cannot distinguish "there are
 * four" from "there are nine and five are starving"; one bit and one name can.
 */
export const discoverSources = async (
  db: D1Database,
  maxSources: number,
): Promise<DiscoveredSources> => {
  const usage: D1Usage = { rowsRead: 0, rowsWritten: 0 };
  const sources: string[] = [];
  let cursor: string | null = null;

  for (;;) {
    const statement: D1PreparedStatement =
      cursor === null ? db.prepare(DISCOVER_FIRST) : db.prepare(DISCOVER_NEXT).bind(cursor);
    const read = await statement.all<{ s: string | null }>();
    usage.rowsRead += read.meta.rows_read;
    usage.rowsWritten += read.meta.rows_written;

    cursor = read.results[0]?.s ?? null;
    if (cursor === null) break;
    // The cap is checked BEFORE the push, so `cursor` survives the loop holding the first
    // name that did not fit.
    if (sources.length >= maxSources) break;
    sources.push(cursor);
  }

  return { sources, truncated: cursor !== null, overflow: cursor, usage };
};

/**
 * THE LEASE TOKEN, FRESH PER CLAIM. The UUID is not decoration and the prefix is not either.
 *
 * 3D's fence is a contract about FRESHNESS PER CLAIM, not per run. `MONITOR_STEP_CONFIG` sets
 * `retries.limit = 1`, so a drain step body executes TWICE AT THE SAME stepIndex AND
 * batchIndex. Without the UUID both executions mint an identical token, and measured on one
 * fixture with a requeue between the two claims: the STALE completion applies (`changes: 1`),
 * the fresh one is discarded (`changes: 0`), `NOT_DEAL` is stored where `DEAL` was computed,
 * and the row becomes a FIXED POINT -- COMPLETE at the current revision, therefore ineligible
 * under all four claim tiers and unrecoverable without a manual revision bump. That is 3D's
 * exact bug, one layer up.
 *
 * The prefix earns its place separately: a stranded PROCESSING row names the run, step and
 * batch that stranded it --
 * `SELECT listing_id, lease_token FROM evaluation_tasks WHERE status='PROCESSING'`.
 */
export const drainLeaseToken = (runId: string, stepIndex: number, batchIndex: number): string =>
  `${runId}:${stepIndex}:${batchIndex}:${crypto.randomUUID()}`;

/**
 * The narrow slice of `WorkflowStep` this module uses. The real `WorkflowStep` is assignable
 * to it with no cast, which is what lets the tests drive the real code with a fake stepper.
 */
export interface MonitorStepper {
  do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
}

export interface MonitorRun {
  runId: string;
  status: MonitorStatus;
  /** The status of the run before this one; null on the first run ever. */
  previousStatus: string | null;
  scheduledAt: number;
  startedAt: number;
  finishedAt: number;
  searchRevision: number | null;
  sources: string[];
  sourcesTruncated: boolean;
  overflowSource: string | null;
  selectedComponents: string[];
  /** Discovered sources that received ZERO batches. Empty unless a configuration starves. */
  undrainedSources: string[];
  requestCount: number;
  resultCount: number;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  claimedCount: number;
  /** Committed outcomes. `discardedCount` is the fence-rejected remainder. */
  evaluationCount: number;
  /**
   * Outcomes whose reason is `evaluation-error`: a per-candidate `decide` throw that
   * `evaluateBatch` caught internally. NOT a failure of the run -- the task completes and the
   * other fourteen are unaffected -- but a nonzero count is a CODE-BUG signal nothing else in
   * the system surfaces. It does NOT move `status`, so no console.warn fires for it and the
   * instance output expires: `monitor_runs.evaluation_error_count` is the only place it is
   * durable, which is why it is a column and not just a field here.
   */
  evaluationErrorCount: number;
  discardedCount: number;
  batches: number;
  stepsUsed: number;
  stepFailures: number;
  usage: D1Usage;
  errors: string[];
}

/**
 * How far ahead of the real clock a `now` may be before it is refused. A day covers clock skew
 * and a Cron that fires late.
 *
 * DELIBERATELY DUPLICATED from `runCleanup.ts` rather than extracted. Sharing means refactoring
 * the most dangerous input check in a merged file whose Workflow DELETES DATA, for no
 * behavioural gain. runMonitor.test.ts R13 feeds the same table to both implementations and
 * asserts they reject identically, which catches the drift with none of that risk.
 */
const MAX_CLOCK_SKEW_SECONDS = 86_400;

const requirePositiveInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`runMonitor: ${name} must be a safe integer >= 1: ${value}`);
  }
  return value;
};

export const runMonitor = async (
  db: D1Database,
  step: MonitorStepper,
  params: MonitorParams,
  runId: string,
  options: MonitorOptions = {},
): Promise<MonitorRun> => {
  // POSITIONAL, not a payload field and not an option: `runId` is `event.instanceId`, which is
  // stable across replays and step retries and is not forgeable from a hand-written payload.
  // Empty, it would degenerate the lease-token prefix to ":0:0:<uuid>" -- which still passes
  // `evaluateBatch`'s own emptiness check -- and the lock would fence on '', the exact value
  // RELEASE_LOCK writes when the lock is FREE.
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error(`runMonitor: runId must be a non-empty string, got ${JSON.stringify(runId)}`);
  }

  // `now` is EPOCH SECONDS. 1e9 = 2001-09-09; 1e11 = year 5138. Milliseconds (~1.8e12) are
  // inside neither bound. See MAX_CLOCK_SKEW_SECONDS above for why this is not shared with
  // runCleanup.
  if (!Number.isSafeInteger(params.now) || params.now < 1e9 || params.now > 1e11) {
    throw new Error(`runMonitor: now must be epoch seconds, got ${params.now}`);
  }
  // ...AND IT MUST NOT BE IN THE FUTURE. The band above rejects a wrong UNIT; it does not
  // reject a wrong VALUE in the right unit. Here a far-future `now` cannot delete anything --
  // the drain has no cutoff -- but it writes `lease_expires_at = now + 300` on every task it
  // claims, stranding them until that instant, and it sets a lock lease nothing displaces.
  if (params.now > Date.now() / 1000 + MAX_CLOCK_SKEW_SECONDS) {
    throw new Error(`runMonitor: now must not be in the future, got ${params.now}`);
  }

  // Resolved from `options`, NEVER from `params`. This is the line that makes an extra payload
  // key inert. `lockSeconds` is validated inside `acquireMonitorLock` (before its own SQL, so
  // a bad value strands nothing) and `batchSize` inside `evaluateBatch`; both are guards those
  // functions own and neither is restated here.
  const lockSeconds = options.lockSeconds ?? MONITOR_LOCK_SECONDS;
  const batchSize = options.batchSize ?? EVALUATION_BATCH_SIZE;
  const collectionSteps = options.collectionSteps ?? COLLECTION_STEPS;
  const drainSteps = requirePositiveInteger("drainSteps", options.drainSteps ?? DRAIN_STEPS);
  const batchesPerDrainStep = requirePositiveInteger(
    "batchesPerDrainStep",
    options.batchesPerDrainStep ?? BATCHES_PER_DRAIN_STEP,
  );
  const maxSources = requirePositiveInteger("maxSources", options.maxSources ?? MAX_DRAIN_SOURCES);
  const retentionRuns = requirePositiveInteger(
    "retentionRuns",
    options.retentionRuns ?? MONITOR_RUN_RETENTION,
  );

  const run: MonitorRun = {
    runId,
    status: "OK",
    previousStatus: null,
    scheduledAt: params.now,
    startedAt: 0,
    finishedAt: 0,
    searchRevision: null,
    sources: [],
    sourcesTruncated: false,
    overflowSource: null,
    // FILLS ITSELF. `[]` today because collection is parked, and correct the moment
    // COLLECTION_STEPS is populated.
    selectedComponents: collectionSteps.map((entry) => entry.name),
    undrainedSources: [],
    requestCount: 0,
    resultCount: 0,
    newCount: 0,
    changedCount: 0,
    unchangedCount: 0,
    claimedCount: 0,
    evaluationCount: 0,
    evaluationErrorCount: 0,
    discardedCount: 0,
    batches: 0,
    stepsUsed: 0,
    stepFailures: 0,
    usage: { rowsRead: 0, rowsWritten: 0 },
    errors: [],
  };

  const escalate = (next: MonitorStatus): void => {
    if (STATUS_RANK[next] < STATUS_RANK[run.status]) run.status = next;
  };
  const spend = (usage: D1Usage): void => {
    run.usage.rowsRead += usage.rowsRead;
    run.usage.rowsWritten += usage.rowsWritten;
  };
  const recordError = (message: string): void => {
    if (run.errors.length >= MAX_RUN_ERRORS) return;
    run.errors.push(message.slice(0, MAX_RUN_ERROR_CHARS));
  };
  const runStep = async <T>(name: string, body: () => Promise<T>): Promise<T> => {
    // Counted BEFORE the call, so a step that ran and exhausted its retries is still a step
    // this run spent.
    run.stepsUsed += 1;
    return step.do(name, MONITOR_STEP_CONFIG, body);
  };

  /**
   * FINALIZE RUNS ON EVERY PATH, all five statuses included. A skipped run that leaves no
   * record is exactly what telemetry exists to prevent, and on the SKIPPED_LOCKED and
   * LOCK_LOST paths the fenced release simply matches nothing and reports `changes: 0` without
   * raising.
   */
  const finalize = async (): Promise<MonitorRun> => {
    const outcome = await runStep("finalize", async () => {
      const previous = await readPreviousRun(db);
      const finishedAt = Math.floor(Date.now() / 1000);

      // The ROW carries the usage known when it is written, which cannot include the batch
      // that writes it. The RETURNED run adds that batch afterwards, so the instance output is
      // complete and the stored row is short by exactly the finalize batch. Measured at 5 read
      // / 4 written; docs/phase-3e-monitoring.md says so.
      const record: MonitorRunRecord = {
        runId,
        scheduledAt: run.scheduledAt,
        startedAt: run.startedAt,
        finishedAt,
        status: run.status,
        searchRevision: run.searchRevision,
        sources: run.sources,
        sourcesTruncated: run.sourcesTruncated,
        selectedComponents: run.selectedComponents,
        requestCount: run.requestCount,
        resultCount: run.resultCount,
        newCount: run.newCount,
        changedCount: run.changedCount,
        unchangedCount: run.unchangedCount,
        claimedCount: run.claimedCount,
        evaluationCount: run.evaluationCount,
        evaluationErrorCount: run.evaluationErrorCount,
        discardedCount: run.discardedCount,
        batches: run.batches,
        stepsUsed: run.stepsUsed,
        stepFailures: run.stepFailures,
        rowsRead: run.usage.rowsRead + previous.usage.rowsRead,
        rowsWritten: run.usage.rowsWritten + previous.usage.rowsWritten,
        errors: run.errors,
      };

      // ONE db.batch: record, prune, release. D1 rolls a whole batch back on a failing
      // statement, so a run that recorded itself without releasing -- or released without
      // recording -- is unrepresentable rather than merely unlikely.
      const applied = await db.batch([
        ...recordMonitorRun(db, record, retentionRuns),
        releaseStatement(db, runId),
      ]);

      const usage: D1Usage = { ...previous.usage };
      for (const statement of applied) {
        usage.rowsRead += statement.meta.rows_read;
        usage.rowsWritten += statement.meta.rows_written;
      }
      return { previousStatus: previous.previous?.status ?? null, finishedAt, usage };
    });

    run.previousStatus = outcome.previousStatus;
    run.finishedAt = outcome.finishedAt;
    spend(outcome.usage);

    // The only signal a run gives without a database query, and there is no alerting until
    // Phase 4. Truncation is not a failure, so it does not set a status -- but an operator who
    // never learns the source list was incomplete cannot act on it either.
    if (run.status !== "OK" || run.sourcesTruncated) {
      console.warn(
        `monitor ${runId}: ${run.status}`,
        JSON.stringify({
          errors: run.errors,
          overflowSource: run.overflowSource,
          undrainedSources: run.undrainedSources,
        }),
      );
    }
    return run;
  };

  // 1. THE LOCK. Not acquired means another run owns it; the loser learns it lost BEFORE it
  //    writes anything but its own telemetry row.
  const lock = await runStep("acquire-lock", async () => {
    const acquired = await acquireMonitorLock(db, { runId, now: params.now, lockSeconds });
    return {
      acquired: acquired.acquired,
      // Wall clock, captured INSIDE the memoized body so a replay reports the original
      // instant. `scheduledAt` is params.now, and the gap between the two is the cron delivery
      // delay -- which is lease this run has already spent before it started.
      startedAt: Math.floor(Date.now() / 1000),
      usage: acquired.usage,
    };
  });
  run.startedAt = lock.startedAt;
  spend(lock.usage);
  if (!lock.acquired) {
    escalate("SKIPPED_LOCKED");
    return finalize();
  }

  // 2. THE SETTINGS. `search_settings` is EMPTY until someone runs the documented bootstrap,
  //    so `null` is the state of production right now and a run that throws on it is a silent
  //    failure every 30 minutes.
  //
  //    IT DOES NOT DEFAULT, and that is the load-bearing half. A drain under a fabricated
  //    revision 0, followed by an operator bootstrapping their own revision 0, leaves every
  //    task it touched COMPLETE at the current revision -- ineligible under all four claim
  //    tiers, carrying a verdict computed from settings nobody chose, unrecoverable without a
  //    manual revision bump.
  const loaded = await runStep("load-settings", async () => loadCurrentSettings(db));
  spend(loaded.usage);
  if (loaded.settings === null) {
    escalate("NO_SETTINGS");
    return finalize();
  }
  const settings: EvaluationSettings = loaded.settings;
  run.searchRevision = settings.searchRevision;

  // 3-4. COLLECTION. Zero iterations today; see collection.ts for the contract. The loop
  //      already exists and already runs, so filling COLLECTION_STEPS is an addition rather
  //      than a redesign.
  for (const collectionStep of collectionSteps) {
    let outcome;
    try {
      outcome = await runStep(`collect-${collectionStep.name}`, async () => {
        // ADVISORY. It bounds wasted work and gives LOCK_LOST somewhere to be reported; it is
        // not a transaction and collection steps may not build on it.
        if (!(await monitorLockHeld(db, runId))) return null;
        return collectionStep.run({
          db,
          now: params.now,
          searchRevision: settings.searchRevision,
          runId,
        });
      });
    } catch (error) {
      run.stepFailures += 1;
      recordError(`collect-${collectionStep.name}: ${String(error)}`);
      escalate("DEGRADED");
      break;
    }
    if (outcome === null) {
      escalate("LOCK_LOST");
      return finalize();
    }
    spend(outcome.usage);
    run.requestCount += outcome.requestCount;
    run.resultCount += outcome.resultCount;
    run.newCount += outcome.newCount;
    run.changedCount += outcome.changedCount;
    run.unchangedCount += outcome.unchangedCount;
    if (outcome.degraded) {
      escalate("DEGRADED");
      recordError(`collect-${collectionStep.name}: provider degraded`);
    }
  }

  // 5. THE DRAIN.
  const discovered = await runStep("discover-sources", async () => discoverSources(db, maxSources));
  spend(discovered.usage);
  run.sources = discovered.sources;
  run.sourcesTruncated = discovered.truncated;
  run.overflowSource = discovered.overflow;

  if (run.sources.length > 0) {
    // Both derived from step RETURN VALUES, so a replay rebuilds them identically.
    const exhausted: string[] = [];
    const drained = new Set<string>();

    for (let stepIndex = 0; stepIndex < drainSteps; stepIndex += 1) {
      if (exhausted.length === run.sources.length) break;

      let outcome;
      try {
        outcome = await runStep(`drain-${stepIndex}`, async () => {
          if (!(await monitorLockHeld(db, runId))) return null;

          const usage: D1Usage = { rowsRead: 0, rowsWritten: 0 };
          const stepExhausted = [...exhausted];
          const stepDrained: string[] = [];
          let batches = 0;
          let claimed = 0;
          let committed = 0;
          let evaluationErrors = 0;
          let discarded = 0;

          for (let batchIndex = 0; batchIndex < batchesPerDrainStep; batchIndex += 1) {
            const active = run.sources.filter((source) => !stepExhausted.includes(source));
            if (active.length === 0) break;
            // ROUND-ROBIN over the GLOBAL batch position, so the first source does not get
            // every step's first batch.
            const position = stepIndex * batchesPerDrainStep + batchIndex;
            const source = active[position % active.length];

            const report = await evaluateBatch(db, {
              source,
              settings,
              now: params.now,
              batchSize,
              leaseToken: drainLeaseToken(runId, stepIndex, batchIndex),
            });

            batches += 1;
            claimed += report.claimed;
            committed += report.outcomes.length;
            discarded += report.discarded.length;
            evaluationErrors += report.outcomes.filter(
              (outcome_) => outcome_.reason === "evaluation-error",
            ).length;
            usage.rowsRead += report.usage.rowsRead;
            usage.rowsWritten += report.usage.rowsWritten;
            stepDrained.push(source);

            // `claimed === 0` -- the conjunction of ALL FOUR tiers -- is the only exhaustion
            // signal. Note the asymmetry with evaluateBatch's INTERNAL tier loop, which must
            // never break on a zero tier: in the ordinary steady state nothing is PENDING.
            if (report.claimed === 0) stepExhausted.push(source);
          }

          return {
            batches,
            claimed,
            committed,
            discarded,
            evaluationErrors,
            // Only the sources THIS step retired; the orchestrator owns the union.
            exhausted: stepExhausted.filter((source) => !exhausted.includes(source)),
            drained: stepDrained,
            usage,
          };
        });
      } catch (error) {
        // A step that exhausted its retries. The claimed rows it stranded in PROCESSING are
        // recovered at the NEXT fire, not inside this run -- `now` is frozen, so tier 2's
        // `lease_expires_at <= now` cannot match a lease this run just wrote.
        run.stepFailures += 1;
        recordError(`drain-${stepIndex}: ${String(error)}`);
        escalate("DEGRADED");
        break;
      }

      if (outcome === null) {
        escalate("LOCK_LOST");
        break;
      }

      run.batches += outcome.batches;
      run.claimedCount += outcome.claimed;
      run.evaluationCount += outcome.committed;
      // NOT a failure: the fence rejected a completion because the task changed underneath.
      // Throwing would retry the step and re-claim for nothing.
      run.discardedCount += outcome.discarded;
      run.evaluationErrorCount += outcome.evaluationErrors;
      spend(outcome.usage);
      exhausted.push(...outcome.exhausted);
      for (const source of outcome.drained) drained.add(source);
    }

    run.undrainedSources = run.sources.filter((source) => !drained.has(source));
  }

  // 6-7. FINALIZE AND RELEASE, in one db.batch.
  return finalize();
};
