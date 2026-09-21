// @vitest-environment node

/**
 * The monitoring orchestration, against REAL D1 with the real migrations, the real
 * `loadCurrentSettings` and the real `evaluateBatch`. Only the Workflow step is faked, and the
 * fake memoizes BY NAME exactly as the platform does -- so a constant step name is a test
 * failure here, not a surprise in production.
 *
 * FIXTURE CORRELATION. No two parameters that reach the code under test share a value, and
 * none equals a default. The defaults reachable from `runMonitor` are MONITOR_LOCK_SECONDS
 * 1500, DRAIN_STEPS 3, BATCHES_PER_DRAIN_STEP 2, MAX_DRAIN_SOURCES 6, MONITOR_RUN_RETENTION
 * 336 and, through `evaluateBatch`, EVALUATION_BATCH_SIZE 15, EVALUATION_LEASE_SECONDS 300,
 * MAX_EVALUATION_BATCH_SIZE 98 and MINIMUM_REFERENCE_COUNT 5 -- plus the degenerate 0 and 1,
 * which hide a multiplier. Every fixture below is audited against that list INDIVIDUALLY: a
 * value legal in one test may equal a default only that test overrides. R8 is the one
 * deliberate exception and says so in its own comment.
 *
 * Fixture SIZES that never reach runMonitor -- seed counts, prices, source names -- are outside
 * the rule, as runCleanup.test.ts states for `seed`.
 *
 * ANCHORING. `claimed: 0` is satisfied by a correct empty queue AND by a drain that never ran;
 * "tasks untouched" by a correct skip AND by a crash; "the lock was released" by "it was never
 * acquired". Every test below that could pass by emptiness carries a literal count, a named
 * survivor set, or a paired positive half against the same fixture.
 */

import {
  claimEvaluationTasks,
  completionStatement,
} from "../evaluation/evaluateBatch";
import { EVALUATION_BATCH_SIZE } from "../evaluation/types";
import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";
import { COLLECTION_STEPS, type CollectionOutcome, type CollectionStep } from "./collection";
import { acquireMonitorLock, MONITOR_LOCK_SECONDS } from "./monitorLock";
import { MAX_STEPS, runCleanup } from "./runCleanup";
import {
  discoverSources,
  drainLeaseToken,
  runMonitor,
  BATCHES_PER_DRAIN_STEP,
  DRAIN_STEPS,
  MONITOR_STEP_CONFIG,
  type MonitorOptions,
  type MonitorParams,
  type MonitorStepper,
} from "./runMonitor";

/**
 * R17 needs `decide` to throw for exactly one candidate. The wrapper delegates to the real
 * implementation unless a test arms it, so every other test in this file still runs the
 * production function and still carries any mutation applied to it. Same seam, same shape as
 * evaluateBatch.test.ts E20.
 */
const stub = vi.hoisted(() => ({ throwForPriceCents: null as number | null }));

vi.mock("../evaluation/dealRules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../evaluation/dealRules")>();
  return {
    ...actual,
    decide: (
      reference: Parameters<typeof actual.decide>[0],
      settings: Parameters<typeof actual.decide>[1],
    ) => {
      if (
        stub.throwForPriceCents !== null &&
        reference?.candidatePriceCents === stub.throwForPriceCents
      ) {
        throw new Error("stubbed decide failure");
      }
      return actual.decide(reference, settings);
    },
  };
});

/** Frozen and in the PAST: the future guard refuses anything ahead of the real clock. */
const T = 1_700_000_000;

/** ≠ 0, the state an unbootstrapped database would fabricate if the run defaulted. */
const REVISION = 11;
const MAX_PRICE_CENTS = 43_700;
const MIN_DISCOUNT_PERCENT = 17.5;
/** Comfortably under MAX_PRICE_CENTS, so MAXIMUM_PRICE mode gives DEAL / COMPLETE. */
const PRICE_CENTS = 12_900;
/** The one candidate R17 arms `decide` to throw for. Distinct from PRICE_CENTS. */
const POISON_PRICE_CENTS = 30_100;

let database!: TestDatabase;
let db!: D1Database;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
}, 120_000);

afterAll(async () => {
  await database.dispose();
});

beforeEach(async () => {
  stub.throwForPriceCents = null;
  await truncateAll(db);
});

/**
 * A stepper that memoizes by name, records what it was asked to do, can be told to throw on
 * the n-th BODY execution, and can run an arbitrary interleaving just before a named body.
 * `before` is what lets a second run, or a lock thief, land between two steps of the first --
 * the interleaving monitorWorkflow.test.ts W3 produces for real inside workerd.
 */
const recording = (options: { failAt?: number; before?: (name: string) => Promise<void> } = {}) => {
  const memo = new Map<string, unknown>();
  const names: string[] = [];
  const configs: unknown[] = [];
  let executed = 0;

  const stepper: MonitorStepper = {
    async do<T2>(name: string, config: unknown, callback: () => Promise<T2>): Promise<T2> {
      names.push(name);
      configs.push(config);
      if (memo.has(name)) return memo.get(name) as T2;
      if (options.before !== undefined) await options.before(name);
      if (options.failAt === executed) {
        executed += 1;
        throw new Error("step exploded");
      }
      executed += 1;
      const value = await callback();
      memo.set(name, value);
      return value;
    },
  } as MonitorStepper;

  return { stepper, names, configs };
};

const bootstrapSettings = async (input: {
  mode: "DISCOUNT" | "MAXIMUM_PRICE";
  percent: number | null;
  maxCents: number | null;
}) => {
  await db.batch([
    db
      .prepare(
        `INSERT INTO search_revisions
           (revision, mode, minimum_discount_percent, maximum_price_cents, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(REVISION, input.mode, input.percent, input.maxCents, T),
    db
      .prepare(
        `INSERT INTO search_settings (id, current_revision) VALUES (1, ?1)
         ON CONFLICT(id) DO UPDATE SET current_revision = ?1`,
      )
      .bind(REVISION),
  ]);
};

/** Verdicts are terminal: DEAL / COMPLETE at the current revision, ineligible thereafter. */
const maximumPriceSettings = () =>
  bootstrapSettings({ mode: "MAXIMUM_PRICE", percent: null, maxCents: MAX_PRICE_CENTS });

/**
 * DISCOUNT with no `model_stats` row at all: `reference_count` is NULL, so every candidate
 * lands on `insufficient-evidence` -> status NEEDS_REVIEW -> UNCONDITIONALLY ELIGIBLE IN TIER 3
 * ON EVERY CALL. That is what lets a handful of rows sustain a full batch budget without the
 * drain exhausting, which is exactly the production steady state the budget is sized for.
 */
const rotatingSettings = () =>
  bootstrapSettings({ mode: "DISCOUNT", percent: MIN_DISCOUNT_PERCENT, maxCents: null });

/**
 * `count` tasks in `source`, with matching `listings` rows so the candidate read finds them.
 * One recursive CTE per table: 20,000 rows cost two statements, not 20,000.
 */
const seed = async (source: string, count: number, priceCents: number = PRICE_CENTS) => {
  await db.batch([
    db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
         INSERT INTO listings
         SELECT ?1, ?1 || '-' || i, 'M', 'gpu', 'MODEL', '', 'title', ?3, NULL,
                'https://example.test/l', 'VALID', 'hash', ?4, ?4 FROM n`,
      )
      .bind(source, count, priceCents, T),
    db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
         INSERT INTO evaluation_tasks (source, listing_id, status, created_at)
         SELECT ?1, ?1 || '-' || i, 'PENDING', ?3 FROM n`,
      )
      .bind(source, count, T),
  ]);
};

const taskStatuses = async () =>
  (
    await db
      .prepare("SELECT status, COUNT(*) AS n FROM evaluation_tasks GROUP BY status ORDER BY status")
      .all<{ status: string; n: number }>()
  ).results;

const storedRun = async (runId: string) =>
  (
    await db.prepare("SELECT * FROM monitor_runs WHERE run_id = ?1").bind(runId).all()
  ).results[0] as Record<string, unknown>;

const runRows = async () =>
  (
    await db
      .prepare("SELECT run_id, status, batches, steps_used FROM monitor_runs ORDER BY run_seq")
      .all<{ run_id: string; status: string; batches: number; steps_used: number }>()
  ).results;

const lockRow = async () =>
  (
    await db
      .prepare("SELECT run_id, acquired_at, expires_at FROM monitor_lock")
      .all<{ run_id: string; acquired_at: number; expires_at: number }>()
  ).results[0];

describe("runMonitor", () => {
  /**
   * R1. The step-name list, EXACTLY. `step.do` memoizes by name, so a constant name returns
   * step 0's result forever and the drain silently never advances; a missing step vanishes
   * from here and nowhere else.
   *
   * 4 drain steps x 7 batches, and the fixture rotates in tier 3 so nothing exhausts and all
   * four steps are reached. 4, 7, 9 are mutually distinct and none is a default.
   */
  it("R1: runs exactly the named steps, in order, with the shared step config", async () => {
    await rotatingSettings();
    // Small on purpose: the drain's cost here is 28 batches of round trips, not rows, and five
    // rotating tasks sustain all 28 exactly as well as fifty would.
    await seed("alpha", 5);

    const recorder = recording();
    const run = await runMonitor(db, recorder.stepper, { now: T }, "run-one", {
      drainSteps: 4,
      batchesPerDrainStep: 7,
      batchSize: 9,
    });

    expect(recorder.names).toEqual([
      "acquire-lock",
      "load-settings",
      "discover-sources",
      "drain-0",
      "drain-1",
      "drain-2",
      "drain-3",
      "finalize",
    ]);
    expect(run.stepsUsed).toBe(8);
    expect(run.status).toBe("OK");
    // ONE retry, not runCleanup's two: each retry re-claims up to a step's worth of further
    // tasks and strands them until the next fire.
    expect(recorder.configs.every((config) => config === MONITOR_STEP_CONFIG)).toBe(true);
    expect(MONITOR_STEP_CONFIG.retries.limit).toBe(1);
  });

  /**
   * R2. `claimed === 0` -- the conjunction of all four tiers -- is the only exhaustion signal,
   * and the drain must spend a batch to learn it. 40 tasks at batchSize 13 is 13, 13, 13, 1,
   * then the empty fifth.
   */
  it("R2: drains a source to exhaustion and stops on the empty batch", async () => {
    await maximumPriceSettings();
    await seed("alpha", 40);

    const run = await runMonitor(db, recording().stepper, { now: T }, "run-two", {
      drainSteps: 4,
      batchesPerDrainStep: 7,
      batchSize: 13,
    });

    expect({
      status: run.status,
      batches: run.batches,
      claimedCount: run.claimedCount,
      evaluationCount: run.evaluationCount,
      discardedCount: run.discardedCount,
      // The drain stopped inside drain-0; drain-1 was never started.
      stepsUsed: run.stepsUsed,
      sources: run.sources,
      undrainedSources: run.undrainedSources,
    }).toEqual({
      status: "OK",
      batches: 5,
      claimedCount: 40,
      evaluationCount: 40,
      discardedCount: 0,
      stepsUsed: 5,
      sources: ["alpha"],
      undrainedSources: [],
    });
    // A literal count, not "no PENDING left": both are satisfied by an empty table.
    expect(await taskStatuses()).toEqual([{ status: "COMPLETE", n: 40 }]);

    // THE STORED ROW, not just the returned object. `INSERT_RUN` binds 23 POSITIONAL
    // parameters against the column list in 0004; a bind swapped with its neighbour is
    // invisible from `run` alone and shows up only here.
    const row = await storedRun("run-two");
    expect({
      run_id: row.run_id,
      scheduled_at: row.scheduled_at,
      status: row.status,
      search_revision: row.search_revision,
      sources: row.sources,
      sources_truncated: row.sources_truncated,
      selected_components: row.selected_components,
      claimed_count: row.claimed_count,
      evaluation_count: row.evaluation_count,
      evaluation_error_count: row.evaluation_error_count,
      discarded_count: row.discarded_count,
      batches: row.batches,
      steps_used: row.steps_used,
      step_failures: row.step_failures,
      errors: row.errors,
    }).toEqual({
      run_id: "run-two",
      scheduled_at: T,
      status: "OK",
      search_revision: REVISION,
      sources: '["alpha"]',
      sources_truncated: 0,
      selected_components: "[]",
      claimed_count: 40,
      evaluation_count: 40,
      evaluation_error_count: 0,
      discarded_count: 0,
      batches: 5,
      steps_used: 5,
      step_failures: 0,
      errors: "[]",
    });
    // Three timestamps, not two: `scheduled_at` is the payload's frozen instant and the other
    // two are wall clock, so a slow run and a late Cron are distinguishable.
    expect(row.started_at as number).toBeGreaterThan(T);
    expect(row.finished_at as number).toBeGreaterThanOrEqual(row.started_at as number);
    // The row cannot include the batch that writes it; the returned run adds it afterwards.
    expect(run.usage.rowsWritten).toBeGreaterThan(row.rows_written as number);
  });

  /**
   * R3. Paired on ONE fixture. The negative half alone is satisfied by a crash -- a drain that
   * throws on null settings also leaves every task PENDING -- so the STATUS assertion is what
   * kills it, and the positive half is what kills "skip the drain unconditionally".
   */
  it("R3: no settings means NO_SETTINGS and no drain; the same fixture drains once bootstrapped", async () => {
    await seed("alpha", 11);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const absent = await runMonitor(db, recording().stepper, { now: T }, "run-absent", {
      drainSteps: 4,
      batchesPerDrainStep: 7,
      batchSize: 13,
    });

    expect({
      status: absent.status,
      batches: absent.batches,
      claimedCount: absent.claimedCount,
      searchRevision: absent.searchRevision,
      sources: absent.sources,
      // acquire-lock, load-settings, finalize. Discovery never ran.
      stepsUsed: absent.stepsUsed,
    }).toEqual({
      status: "NO_SETTINGS",
      batches: 0,
      claimedCount: 0,
      searchRevision: null,
      sources: [],
      stepsUsed: 3,
    });
    expect(await taskStatuses()).toEqual([{ status: "PENDING", n: 11 }]);
    // It still recorded itself and still released: a skipped run leaving no record is exactly
    // what telemetry exists to prevent.
    expect((await runRows()).map((row) => row.status)).toEqual(["NO_SETTINGS"]);
    expect(await lockRow()).toEqual({ run_id: "", acquired_at: T, expires_at: 0 });
    // THE ONLY SIGNAL A RUN GIVES WITHOUT A DATABASE QUERY, and there is no alerting until
    // Phase 4. It names the instance and the status, so `wrangler tail` distinguishes this run
    // from the 47 others that fire the same day.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("run-absent");
    expect(String(warn.mock.calls[0][0])).toContain("NO_SETTINGS");
    warn.mockClear();

    await maximumPriceSettings();
    const present = await runMonitor(db, recording().stepper, { now: T }, "run-present", {
      drainSteps: 4,
      batchesPerDrainStep: 7,
      batchSize: 13,
    });

    expect({
      status: present.status,
      claimedCount: present.claimedCount,
      searchRevision: present.searchRevision,
    }).toEqual({ status: "OK", claimedCount: 11, searchRevision: REVISION });
    expect(await taskStatuses()).toEqual([{ status: "COMPLETE", n: 11 }]);
    // ...and a healthy run is SILENT. Without this half, a warn on every run passes too.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  /**
   * R4. Two runs, one lock, interleaved for real: B runs to completion from inside A's
   * `drain-0` step. Both halves are asserted -- "A drained" alone is satisfied by a lock that
   * does nothing, and "B skipped" alone by a run that crashed before it started.
   */
  it("R4: a second run loses the lock, records SKIPPED_LOCKED and mutates nothing else", async () => {
    await maximumPriceSettings();
    await seed("alpha", 11);

    let loser: Awaited<ReturnType<typeof runMonitor>> | null = null;
    const options: MonitorOptions = { drainSteps: 4, batchesPerDrainStep: 7, batchSize: 13 };
    const winnerRecorder = recording({
      before: async (name) => {
        if (name !== "drain-0" || loser !== null) return;
        loser = await runMonitor(db, recording().stepper, { now: T }, "run-loser", options);
      },
    });

    const winner = await runMonitor(db, winnerRecorder.stepper, { now: T }, "run-winner", options);

    expect({ status: winner.status, claimedCount: winner.claimedCount }).toEqual({
      status: "OK",
      claimedCount: 11,
    });
    expect(loser).not.toBeNull();
    expect({
      status: loser!.status,
      // acquire-lock then finalize, and nothing in between.
      stepsUsed: loser!.stepsUsed,
      batches: loser!.batches,
      claimedCount: loser!.claimedCount,
      searchRevision: loser!.searchRevision,
      previousStatus: loser!.previousStatus,
    }).toEqual({
      status: "SKIPPED_LOCKED",
      stepsUsed: 2,
      batches: 0,
      claimedCount: 0,
      searchRevision: null,
      previousStatus: null,
    });
    // The loser's fenced release matched nothing, so the winner kept the lock and released it
    // itself -- and the winner's finalize read the loser's row.
    expect(winner.previousStatus).toBe("SKIPPED_LOCKED");
    expect(await lockRow()).toEqual({ run_id: "", acquired_at: T, expires_at: 0 });
    expect(await runRows()).toEqual([
      { run_id: "run-loser", status: "SKIPPED_LOCKED", batches: 0, steps_used: 2 },
      { run_id: "run-winner", status: "OK", batches: 2, steps_used: 5 },
    ]);
    expect(await taskStatuses()).toEqual([{ status: "COMPLETE", n: 11 }]);
  });

  /**
   * R5. The lock stolen between two steps. The aborting run must report LOCK_LOST, stop
   * draining, still finalize -- and its release must NOT free the thief's lock. Unfenced, the
   * last line of this test is the one that fails.
   */
  it("R5: a stolen lock aborts the drain and the release does not touch the thief", async () => {
    await rotatingSettings();
    await seed("alpha", 11);

    const thiefAcquiredAt = T + 601;
    const recorder = recording({
      before: async (name) => {
        if (name !== "drain-1") return;
        // The victim's lease was 601s and the thief's `now` is exactly its expiry: the
        // inclusive boundary, which L4 pins separately.
        const stolen = await acquireMonitorLock(db, {
          runId: "run-thief",
          now: thiefAcquiredAt,
          lockSeconds: 709,
        });
        expect(stolen.acquired).toBe(true);
      },
    });

    const run = await runMonitor(db, recorder.stepper, { now: T }, "run-victim", {
      lockSeconds: 601,
      drainSteps: 4,
      batchesPerDrainStep: 7,
      batchSize: 9,
    });

    expect({
      status: run.status,
      // drain-0's seven batches landed; drain-1 found the fence gone and returned immediately.
      batches: run.batches,
      stepFailures: run.stepFailures,
      stepsUsed: run.stepsUsed,
    }).toEqual({ status: "LOCK_LOST", batches: 7, stepFailures: 0, stepsUsed: 6 });
    expect((await runRows()).map((row) => row.status)).toEqual(["LOCK_LOST"]);
    expect(await lockRow()).toEqual({
      run_id: "run-thief",
      acquired_at: thiefAcquiredAt,
      expires_at: thiefAcquiredAt + 709,
    });
  });

  /**
   * R6. A drain step that exhausts its retries. Letting the failure propagate errors the
   * instance, and an errored instance HOLDS THE LOCK FOR THE FULL LEASE -- so the last two
   * assertions are the point of the test, not decoration.
   *
   * failAt 4 counts BODY executions: 0 acquire-lock, 1 load-settings, 2 discover-sources,
   * 3 drain-0, 4 drain-1.
   */
  it("R6: a failed drain step degrades the run, records the message, and still releases", async () => {
    await rotatingSettings();
    await seed("alpha", 11);

    const run = await runMonitor(db, recording({ failAt: 4 }).stepper, { now: T }, "run-degraded", {
      drainSteps: 4,
      batchesPerDrainStep: 7,
      batchSize: 9,
    });

    expect({
      status: run.status,
      stepFailures: run.stepFailures,
      batches: run.batches,
      stepsUsed: run.stepsUsed,
    }).toEqual({ status: "DEGRADED", stepFailures: 1, batches: 7, stepsUsed: 6 });
    expect(run.errors).toHaveLength(1);
    expect(run.errors[0]).toMatch(/^drain-1: .*step exploded/);
    expect((await runRows()).map((row) => row.status)).toEqual(["DEGRADED"]);
    expect(await lockRow()).toEqual({ run_id: "", acquired_at: T, expires_at: 0 });
  });

  /**
   * R7. Discovery is a SEEK LOOP, not `SELECT DISTINCT source`. The read bound is what kills
   * DISTINCT (20,000 rows, not 4), and the exact list is what kills `source > ?1` becoming
   * `>= ?1` -- which returns the same name forever and reports it as truncation.
   */
  it("R7: discovery is flat in table size and returns the sources in order", async () => {
    await seed("solo", 20_000);

    const big = await discoverSources(db, 8);
    expect(big.sources).toEqual(["solo"]);
    expect(big.usage.rowsRead).toBeLessThanOrEqual(4);

    await truncateAll(db);
    await seed("alpha", 7);
    await seed("bravo", 7);
    await seed("charlie", 7);

    const three = await discoverSources(db, 8);
    expect(three.sources).toEqual(["alpha", "bravo", "charlie"]);
    expect(three.usage.rowsRead).toBeLessThanOrEqual(8);
    expect({ truncated: three.truncated, overflow: three.overflow }).toEqual({
      truncated: false,
      overflow: null,
    });

    await truncateAll(db);
    const empty = await discoverSources(db, 8);
    expect({ sources: empty.sources, truncated: empty.truncated }).toEqual({
      sources: [],
      truncated: false,
    });
  });

  /**
   * R8. STARVATION, AND THE ONLY PLACE A STARVING CONFIGURATION IS LEGAL. In production
   * MAX_DRAIN_SOURCES is DERIVED from the batch budget, so `sources.length <= budget` is
   * arithmetic and starvation is unreachable; `maxSources` is a test-only option and this is
   * what it is for.
   *
   * 2 drain steps x 3 batches = 6 batches against 8 sources, so exactly two starve.
   *
   * THE BUDGET IS A PRODUCT, so 2x3 and 3x2 give the same six batches and the same two starved
   * sources: a swapped binding is invisible to `undrainedSources` alone. What discriminates it
   * is the step count -- `stepsUsed` below, and the step-NAME list R1 pins. Keep R1 and R8
   * reading each other.
   *
   * 2, 3 and 8 are mutually distinct; 8 is not a default; 2 and 3 are each the OTHER knob's
   * default, which is why the binding is pinned by stepsUsed rather than by the outcome.
   */
  it("R8: a cap above the batch budget starves the tail, and the run names it", async () => {
    await maximumPriceSettings();
    for (const source of [
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
      "golf",
      "hotel",
    ]) {
      await seed(source, 3);
    }

    const run = await runMonitor(db, recording().stepper, { now: T }, "run-starved", {
      drainSteps: 2,
      batchesPerDrainStep: 3,
      maxSources: 8,
      batchSize: 13,
    });

    expect(run.sources).toHaveLength(8);
    expect(run.sourcesTruncated).toBe(false);
    expect(run.batches).toBe(6);
    // acquire-lock, load-settings, discover-sources, drain-0, drain-1, finalize.
    expect(run.stepsUsed).toBe(6);
    // NAMED, not counted: an operator can act on two names and cannot act on "2".
    expect(run.undrainedSources).toEqual(["golf", "hotel"]);
    // ...and the starvation is real, not merely reported: those two sources still hold every
    // task they started with.
    expect(
      (
        await db
          .prepare(
            `SELECT source, COUNT(*) AS n FROM evaluation_tasks
              WHERE status = 'PENDING' GROUP BY source ORDER BY source`,
          )
          .all<{ source: string; n: number }>()
      ).results,
    ).toEqual([
      { source: "golf", n: 3 },
      { source: "hotel", n: 3 },
    ]);

    // The SAME eight sources under a cap below the source count. R9 proves the mechanism inside
    // `discoverSources`; this is the plumbing OUT of it -- through the run object and into the
    // stored column WITH A TRUTHY VALUE. `sources_truncated: 0` everywhere else cannot tell a
    // working bit from a hardcoded zero.
    const truncated = await runMonitor(db, recording().stepper, { now: T }, "run-truncated", {
      drainSteps: 2,
      batchesPerDrainStep: 3,
      maxSources: 4,
      batchSize: 13,
    });
    expect({
      sources: truncated.sources,
      sourcesTruncated: truncated.sourcesTruncated,
      overflowSource: truncated.overflowSource,
    }).toEqual({
      sources: ["alpha", "bravo", "charlie", "delta"],
      sourcesTruncated: true,
      overflowSource: "echo",
    });
    expect((await storedRun("run-truncated")).sources_truncated).toBe(1);
  });

  /**
   * R9. Truncation, which r1 of the plan claimed telemetry recorded and it did not. A `sources`
   * array of four names cannot distinguish "there are four" from "there are seven and three are
   * starving"; one bit and one name can, and the loop's shape already had the name in hand.
   */
  it("R9: hitting the source cap is reported, with the first name that did not fit", async () => {
    for (const source of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"]) {
      await seed(source, 3);
    }

    const capped = await discoverSources(db, 4);
    expect({
      sources: capped.sources,
      truncated: capped.truncated,
      overflow: capped.overflow,
    }).toEqual({
      sources: ["alpha", "bravo", "charlie", "delta"],
      truncated: true,
      overflow: "echo",
    });

    await truncateAll(db);
    await seed("alpha", 3);
    await seed("bravo", 3);
    await seed("charlie", 3);

    const under = await discoverSources(db, 4);
    expect({ sources: under.sources, truncated: under.truncated, overflow: under.overflow }).toEqual(
      { sources: ["alpha", "bravo", "charlie"], truncated: false, overflow: null },
    );
  });

  /**
   * R10. The retention boundary, with NAMED SURVIVORS. A count alone is satisfied by pruning
   * the wrong end; `<` for `<=` leaves ten; dropping `- ?1` leaves none.
   *
   * 9 is not any constant's default, and the survivor list was measured twice independently.
   */
  it("R10: retention keeps exactly the newest N runs, named", async () => {
    await maximumPriceSettings();

    for (let index = 0; index < 14; index += 1) {
      await runMonitor(db, recording().stepper, { now: T }, `run-${index}`, { retentionRuns: 9 });
    }

    const rows = await runRows();
    expect(rows.map((row) => row.run_id)).toEqual([
      "run-5",
      "run-6",
      "run-7",
      "run-8",
      "run-9",
      "run-10",
      "run-11",
      "run-12",
      "run-13",
    ]);
    expect(rows).toHaveLength(9);
  });

  /**
   * R11. `previousStatus` is monitor_runs' in-code reader, and it is what makes ANY SINGLE
   * instance output distinguish a blip from the 400th consecutive failure. The three runs carry
   * three different statuses, so a read that returns a constant dies here.
   */
  it("R11: each run reports the previous run's status, and null on the first", async () => {
    const first = await runMonitor(db, recording().stepper, { now: T }, "run-first");
    expect({ status: first.status, previousStatus: first.previousStatus }).toEqual({
      status: "NO_SETTINGS",
      previousStatus: null,
    });

    await maximumPriceSettings();
    const second = await runMonitor(db, recording().stepper, { now: T }, "run-second");
    expect({ status: second.status, previousStatus: second.previousStatus }).toEqual({
      status: "OK",
      previousStatus: "NO_SETTINGS",
    });

    const third = await runMonitor(db, recording().stepper, { now: T }, "run-third");
    expect(third.previousStatus).toBe("OK");
  });

  /**
   * R12. A BOUND WITH AN ORACLE, not a constant mirrored to itself. Raising either drain
   * constant past what D1's daily allowance can absorb fails here -- and so does a 3D constant
   * moving underneath, which is why the per-task figure is written as
   * `EVALUATION_BATCH_SIZE * 8` and never as the measured literal 120.
   */
  it("R12: the worst-case run stays inside D1's daily write and step allowances", () => {
    const D1_DAILY_ROW_WRITES = 100_000;
    const D1_DAILY_WORKFLOW_STEPS = 3_000;
    /** The monitoring cron is every 30 minutes. */
    const RUNS_PER_DAY = 48;
    /**
     * MEASURED: 120 rows written for 15 completions. `rows_written` includes index entries and
     * evaluation_tasks carries three explicit indexes plus its autoindex.
     */
    const ROWS_WRITTEN_PER_TASK = 8;

    const worstCasePerRun =
      DRAIN_STEPS * BATCHES_PER_DRAIN_STEP * (EVALUATION_BATCH_SIZE * ROWS_WRITTEN_PER_TASK);
    expect(worstCasePerRun * RUNS_PER_DAY).toBeLessThan(D1_DAILY_ROW_WRITES);

    // acquire + load-settings + discover + finalize, plus one per collection component and one
    // per drain step. The collection term is 0 today and is written as the array's length so it
    // tracks when the seam is filled.
    const stepsPerRun = 4 + COLLECTION_STEPS.length + DRAIN_STEPS;
    expect(stepsPerRun * RUNS_PER_DAY + MAX_STEPS).toBeLessThan(D1_DAILY_WORKFLOW_STEPS);
  });

  /**
   * R13. THE SAME TABLE IS FED TO BOTH IMPLEMENTATIONS. `MAX_CLOCK_SKEW_SECONDS` and the epoch
   * band are duplicated in runCleanup.ts and runMonitor.ts deliberately -- sharing them means
   * refactoring the most dangerous input check in a merged file whose Workflow DELETES DATA --
   * and this is what catches the two copies drifting apart.
   *
   * THE CLAIM IS BOUNDED AND IS WORDED AS ONE. This is a SAMPLE -- seven rejected values and two
   * accepted ones -- not a proof that the two guards agree everywhere. It pins them at the
   * points where they could plausibly diverge (the unit band's two edges, a wrong value in the
   * right unit, and one hour of legitimate skew either side); it does not bracket the skew
   * bound and cannot show agreement at an unsampled instant.
   */
  it("R13: runMonitor and runCleanup reject the same SAMPLED `now` values", async () => {
    const rejected = [
      { now: T * 1000, pattern: /epoch seconds/ },
      { now: 0, pattern: /epoch seconds/ },
      { now: 1e9 - 1, pattern: /epoch seconds/ },
      { now: 1e11 + 1, pattern: /epoch seconds/ },
      { now: 1.5, pattern: /epoch seconds/ },
      { now: Number.NaN, pattern: /epoch seconds/ },
      // A wrong VALUE in the right unit: 1_800_000_000 with one extra digit. A safe integer,
      // inside the band, and its lease strands every task it claims until the year 2540.
      { now: 18_000_000_000, pattern: /must not be in the future/ },
    ];

    for (const { now, pattern } of rejected) {
      await expect(runMonitor(db, recording().stepper, { now }, "run-guard")).rejects.toThrow(
        pattern,
      );
      await expect(runCleanup(db, recording().stepper as never, { now })).rejects.toThrow(pattern);
    }
    // A rejection writes nothing at all -- not even the lock.
    expect(await lockRow()).toEqual({ run_id: "", acquired_at: 0, expires_at: 0 });
    expect(await runRows()).toEqual([]);

    // A boundary, not a blanket refusal: an hour of skew is still accepted by both.
    const realNow = Math.floor(Date.now() / 1000);
    await maximumPriceSettings();
    const skewed = await runMonitor(db, recording().stepper, { now: realNow + 3_600 }, "run-skew");
    expect(skewed.status).toBe("OK");
    await expect(runCleanup(db, recording().stepper as never, { now: realNow + 3_600 })).resolves
      .toBeDefined();
  });

  /**
   * R14. THE LEASE TOKEN, FRESH PER CLAIM -- the bug 3D already paid for, reintroduced one layer
   * up by a token that is unique per RUN instead of per CLAIM.
   *
   * `MONITOR_STEP_CONFIG` retries once, so a drain step body executes TWICE at the same step and
   * batch index. Both arms run against ONE fixture and both assert BOTH `changes` values: "the
   * stored verdict is DEAL" is otherwise satisfied by a fixture where the stale completion never
   * ran at all.
   */
  it("R14: two claims at the same step and batch index cannot share a token", async () => {
    await seed("alpha", 1);
    const listingId = "alpha-1";

    const claim = (leaseToken: string) =>
      claimEvaluationTasks(db, {
        source: "alpha",
        batchSize: 9,
        now: T,
        leaseSeconds: 601,
        leaseToken,
        searchRevision: REVISION,
      });
    const complete = (verdict: "DEAL" | "NOT_DEAL", leaseToken: string) =>
      completionStatement(db, {
        source: "alpha",
        listingId,
        status: "COMPLETE",
        verdict,
        searchRevision: REVISION,
        now: T,
        leaseToken,
      }).run();
    // What `recordSightings`' QUEUE_TASK does on a content change: status back to PENDING,
    // neither lease column touched.
    const requeue = () =>
      db
        .prepare("UPDATE evaluation_tasks SET status='PENDING' WHERE source='alpha' AND listing_id=?1")
        .bind(listingId)
        .run();
    const stored = async () =>
      (
        await db
          .prepare("SELECT status, verdict, evaluated_revision FROM evaluation_tasks")
          .all<{ status: string; verdict: string; evaluated_revision: number }>()
      ).results[0];

    // ---- the shipped format ----
    const tokenA = drainLeaseToken("run-token", 2, 1);
    const tokenB = drainLeaseToken("run-token", 2, 1);
    expect(tokenA).not.toBe(tokenB);
    // The prefix is not decoration either: a stranded PROCESSING row names the run, step and
    // batch that stranded it.
    expect(tokenA.startsWith("run-token:2:1:")).toBe(true);

    expect((await claim(tokenA)).tasks).toHaveLength(1);
    await requeue();
    expect((await claim(tokenB)).tasks).toHaveLength(1);

    const staleFresh = await complete("NOT_DEAL", tokenA);
    const freshFresh = await complete("DEAL", tokenB);
    expect({ stale: staleFresh.meta.changes, fresh: freshFresh.meta.changes }).toEqual({
      stale: 0,
      fresh: 1,
    });
    expect(await stored()).toEqual({
      status: "COMPLETE",
      verdict: "DEAL",
      evaluated_revision: REVISION,
    });

    // ---- the mutation arm: a token unique per run, not per claim ----
    await db.prepare("UPDATE evaluation_tasks SET status='PENDING', verdict=NULL, evaluated_revision=NULL, lease_token=''").run();
    const shared = "run-token:2:1";

    expect((await claim(shared)).tasks).toHaveLength(1);
    await requeue();
    expect((await claim(shared)).tasks).toHaveLength(1);

    const staleShared = await complete("NOT_DEAL", shared);
    const freshShared = await complete("DEAL", shared);
    expect({ stale: staleShared.meta.changes, fresh: freshShared.meta.changes }).toEqual({
      stale: 1,
      fresh: 0,
    });
    expect(await stored()).toEqual({
      status: "COMPLETE",
      verdict: "NOT_DEAL",
      evaluated_revision: REVISION,
    });
    // ...and the wrong row is a FIXED POINT: COMPLETE at the current revision is ineligible
    // under all four tiers, so nothing re-derives it without a manual revision bump.
    expect(
      (
        await claimEvaluationTasks(db, {
          source: "alpha",
          batchSize: 9,
          now: T + 709,
          leaseSeconds: 601,
          leaseToken: "run-later:0:0:probe",
          searchRevision: REVISION,
        })
      ).tasks,
    ).toEqual([]);
  });

  /**
   * R15. Every guard throws BEFORE the acquire, so a bad input strands nothing. An empty
   * `runId` is the dangerous one: it degenerates the lease-token prefix past `evaluateBatch`'s
   * own emptiness check, and it fences the lock on '' -- the exact value RELEASE_LOCK writes
   * when the lock is free.
   */
  it("R15: a bad runId or a bad option throws before anything is acquired", async () => {
    await expect(runMonitor(db, recording().stepper, { now: T }, "")).rejects.toThrow(/runId/);
    await expect(
      runMonitor(db, recording().stepper, { now: T }, 42 as unknown as string),
    ).rejects.toThrow(/runId/);

    const bad: MonitorOptions[] = [
      { drainSteps: 0 },
      { batchesPerDrainStep: -1 },
      { maxSources: 1.5 },
      { retentionRuns: Number.NaN },
    ];
    for (const options of bad) {
      await expect(
        runMonitor(db, recording().stepper, { now: T }, "run-bad", options),
      ).rejects.toThrow(/safe integer/);
    }

    expect(await lockRow()).toEqual({ run_id: "", acquired_at: 0, expires_at: 0 });
    expect(await runRows()).toEqual([]);
  });

  /**
   * R16. The collection seam, driven through the option that exists for it. Without this every
   * line of the loop -- the step name, the context, the five counters, the usage, the
   * `degraded` branch -- is a changed line no mutation reaches, and "the seam is fillable
   * without redesign" would be an assertion about code nothing has ever executed.
   *
   * The five counters carry five DISTINCT primes per component, so a crossed accumulator fails.
   */
  it("R16: collection steps run in order, are named, and their counts and usage are summed", async () => {
    await maximumPriceSettings();

    const contexts: Array<{ now: number; searchRevision: number; runId: string }> = [];
    const component = (name: string, values: number[], degraded: boolean): CollectionStep => ({
      name,
      run: async (context) => {
        contexts.push({
          now: context.now,
          searchRevision: context.searchRevision,
          runId: context.runId,
        });
        const outcome: CollectionOutcome = {
          source: name,
          requestCount: values[0],
          resultCount: values[1],
          newCount: values[2],
          changedCount: values[3],
          unchangedCount: values[4],
          degraded,
          usage: { rowsRead: values[5], rowsWritten: values[6] },
        };
        return outcome;
      },
    });

    // Five distinct primes per component for the counters, and usage figures four orders of
    // magnitude above anything a real statement costs, so a dropped sum is unmistakable.
    const ALPHA = [101, 103, 107, 109, 113, 1_000_003, 1_000_007];
    const BRAVO = [127, 131, 137, 139, 149, 2_000_011, 2_000_017];

    const recorder = recording();
    const run = await runMonitor(db, recorder.stepper, { now: T }, "run-collect", {
      collectionSteps: [component("alpha-provider", ALPHA, false), component("bravo-provider", BRAVO, true)],
    });

    expect(recorder.names).toEqual([
      "acquire-lock",
      "load-settings",
      "collect-alpha-provider",
      "collect-bravo-provider",
      "discover-sources",
      "finalize",
    ]);
    expect(contexts).toEqual([
      { now: T, searchRevision: REVISION, runId: "run-collect" },
      { now: T, searchRevision: REVISION, runId: "run-collect" },
    ]);
    expect({
      selectedComponents: run.selectedComponents,
      requestCount: run.requestCount,
      resultCount: run.resultCount,
      newCount: run.newCount,
      changedCount: run.changedCount,
      unchangedCount: run.unchangedCount,
      status: run.status,
    }).toEqual({
      selectedComponents: ["alpha-provider", "bravo-provider"],
      requestCount: 228,
      resultCount: 234,
      newCount: 244,
      changedCount: 248,
      unchangedCount: 262,
      // A provider outage is DEGRADED, not a failure: the counts are partial and the aggregate
      // is untouched.
      status: "DEGRADED",
    });
    expect(run.errors).toEqual(["collect-bravo-provider: provider degraded"]);
    // The same five sums, read back out of the stored row: five DISTINCT values across five
    // adjacent positional binds, so a swap between any two of them fails here.
    const row = await storedRun("run-collect");
    expect({
      selected_components: row.selected_components,
      request_count: row.request_count,
      result_count: row.result_count,
      new_count: row.new_count,
      changed_count: row.changed_count,
      unchanged_count: row.unchanged_count,
      status: row.status,
      errors: row.errors,
    }).toEqual({
      selected_components: '["alpha-provider","bravo-provider"]',
      request_count: 228,
      result_count: 234,
      new_count: 244,
      changed_count: 248,
      unchanged_count: 262,
      status: "DEGRADED",
      errors: '["collect-bravo-provider: provider degraded"]',
    });
    // AN EXACT PIN, NOT A WINDOW, AND THAT IS THE POINT. A window wide enough to be comfortable
    // is how a dropped `spend()` hides: at ~100 rows of slack, deleting the acquire step's own
    // usage (2 read / 1 written) is invisible. Telemetry is a deliverable of this phase and
    // nothing else holds its totals.
    //
    // These are the run's OWN statements on top of what the two collection steps reported:
    // acquire-lock, load-settings, discover-sources, the previous-run read, and the finalize
    // batch's insert + prune + release. MEASURED, and the same discipline as the cost table in
    // docs/phase-3e-monitoring.md. If a statement is added or removed this number MUST move --
    // editing it back to green is the wrong fix.
    //
    // IT IS ALSO SENSITIVE TO TABLE STATE, and that is worth knowing before you debug it: the
    // finalize batch costs 3r/3w while monitor_runs is below the retention window and 5r/4w once
    // the prune starts deleting. A second runMonitor call in this test, or a missing beforeEach
    // truncate, moves it by 2/1. Loud, not silent -- but the fix is the fixture, not the number.
    const OWN_ROWS_READ = 9;
    const OWN_ROWS_WRITTEN = 4;
    expect({ read: run.usage.rowsRead, written: run.usage.rowsWritten }).toEqual({
      read: ALPHA[5] + BRAVO[5] + OWN_ROWS_READ,
      written: ALPHA[6] + BRAVO[6] + OWN_ROWS_WRITTEN,
    });
  });

  it("R16b: a collection step whose fence is gone reports LOCK_LOST and never calls the provider", async () => {
    await maximumPriceSettings();

    let called = 0;
    const component = (name: string): CollectionStep => ({
      name,
      run: async () => {
        called += 1;
        return {
          source: name,
          requestCount: 0,
          resultCount: 0,
          newCount: 0,
          changedCount: 0,
          unchangedCount: 0,
          degraded: false,
          usage: { rowsRead: 0, rowsWritten: 0 },
        };
      },
    });

    const recorder = recording({
      before: async (name) => {
        if (name !== "collect-bravo-provider") return;
        await acquireMonitorLock(db, { runId: "run-thief", now: T + 601, lockSeconds: 709 });
      },
    });

    const run = await runMonitor(db, recorder.stepper, { now: T }, "run-collect-lost", {
      lockSeconds: 601,
      collectionSteps: [component("alpha-provider"), component("bravo-provider")],
    });

    expect(run.status).toBe("LOCK_LOST");
    // alpha ran, bravo did not: the fence is checked INSIDE the step body, before the work.
    expect(called).toBe(1);
    expect(recorder.names).toEqual([
      "acquire-lock",
      "load-settings",
      "collect-alpha-provider",
      "collect-bravo-provider",
      "finalize",
    ]);
    // Discovery and the drain never started, and the thief still holds the lock.
    expect(run.sources).toEqual([]);
    expect((await lockRow()).run_id).toBe("run-thief");
  });

  /**
   * R18. A REPLAYED FINALIZE. The platform can redeliver an instance, and a step body can be
   * retried after its write already landed -- so the finalize insert must be idempotent.
   * Without `ON CONFLICT(run_id) DO UPDATE` the second write is a UNIQUE violation, and D1
   * rolls back the WHOLE batch on a failing statement -- taking the prune AND the lock release
   * with it, so the redelivered run would also leave the lock held for its full lease.
   */
  it("R18: a run replayed under the same instance id upserts its row and still releases", async () => {
    await maximumPriceSettings();

    const first = await runMonitor(db, recording().stepper, { now: T }, "run-replayed");
    expect(first.status).toBe("OK");

    // A fresh stepper: nothing is memoized, exactly as a redelivery from the top behaves. The
    // lock is re-acquired because `OR monitor_lock.run_id = ?1` makes it re-entrant.
    const replay = await runMonitor(db, recording().stepper, { now: T }, "run-replayed");

    expect(replay.status).toBe("OK");
    expect(await runRows()).toEqual([
      { run_id: "run-replayed", status: "OK", batches: 0, steps_used: 4 },
    ]);
    expect(await lockRow()).toEqual({ run_id: "", acquired_at: T, expires_at: 0 });
    // The replay saw its own row, which is the only honest answer to "what came before me".
    expect(replay.previousStatus).toBe("OK");
  });

  /**
   * R17. `evaluation-error` -- a per-candidate `decide` throw that `evaluateBatch` caught -- is
   * NOT a failure of the run: the task completes and the other candidates are unaffected. It is
   * counted separately because a nonzero count is a CODE-BUG signal nothing else in the system
   * surfaces, and folding it into `evaluationCount` would hide it completely.
   */
  it("R17: a caught per-candidate failure completes the task and is counted on its own", async () => {
    await maximumPriceSettings();
    await seed("alpha", 3);
    await db.batch([
      db
        .prepare(
          `INSERT INTO listings VALUES ('alpha','alpha-poison','M','gpu','MODEL','','title',?1,
             NULL,'https://example.test/l','VALID','hash',?2,?2)`,
        )
        .bind(POISON_PRICE_CENTS, T),
      db
        .prepare(
          "INSERT INTO evaluation_tasks (source, listing_id, status, created_at) VALUES ('alpha','alpha-poison','PENDING',?1)",
        )
        .bind(T),
    ]);
    stub.throwForPriceCents = POISON_PRICE_CENTS;

    const run = await runMonitor(db, recording().stepper, { now: T }, "run-poison", {
      drainSteps: 4,
      batchesPerDrainStep: 7,
      batchSize: 9,
    });

    // All four candidates were claimed in one batch and the second batch proved exhaustion.
    // `evaluationCount` counts the poisoned task too -- it DID complete -- which is exactly why
    // the error count has to be its own number rather than a subtraction.
    expect({
      status: run.status,
      batches: run.batches,
      claimedCount: run.claimedCount,
      evaluationCount: run.evaluationCount,
      evaluationErrorCount: run.evaluationErrorCount,
      discardedCount: run.discardedCount,
      stepFailures: run.stepFailures,
    }).toEqual({
      status: "OK",
      batches: 2,
      claimedCount: 4,
      evaluationCount: 4,
      evaluationErrorCount: 1,
      discardedCount: 0,
      // A caught per-candidate failure is NOT a step failure and must not degrade the run.
      stepFailures: 0,
    });
    // The catch writes status COMPLETE with verdict NEEDS_REVIEW: terminal, not a poison loop.
    // The other three are untouched, which is the half that says the failure was contained.
    expect(await taskStatuses()).toEqual([{ status: "COMPLETE", n: 4 }]);
    expect(
      (
        await db
          .prepare("SELECT listing_id, verdict FROM evaluation_tasks ORDER BY listing_id")
          .all<{ listing_id: string; verdict: string }>()
      ).results,
    ).toEqual([
      { listing_id: "alpha-1", verdict: "DEAL" },
      { listing_id: "alpha-2", verdict: "DEAL" },
      { listing_id: "alpha-3", verdict: "DEAL" },
      { listing_id: "alpha-poison", verdict: "NEEDS_REVIEW" },
    ]);
    // THE DURABLE HALF, and it is the point of the column. The count does not move `status`, so
    // no console.warn fires for it, and the Workflow instance output expires -- a `decide` bug
    // that degraded every verdict to NEEDS_REVIEW would otherwise leave no evidence anywhere.
    expect((await storedRun("run-poison")).evaluation_error_count).toBe(1);
  });

  /**
   * R19. THE WORKFLOW PAYLOAD IS A PRODUCTION INPUT SURFACE, AND EVERY KNOB ON IT MUST BE INERT.
   *
   * `handleScheduled` is not the only thing that writes a payload: the runbook teaches
   * `wrangler workflows trigger '<json>'`, and whatever is in that JSON reaches `params`. 3E-a
   * measured what the alternative costs -- one hand-written cleanup payload with
   * `staleAfterSeconds: 0` emptied two tables -- and this phase adds a second payload to the
   * same file. The same discipline, and now the same test (runCleanup.test.ts R9 is the
   * precedent).
   *
   * Every field below is a real option name, so a resolution that preferred `params` over
   * `options` would take all of them -- but only SIX of the seven are killed here, and the
   * distinction matters. `collectionSteps: []` is inert BY COINCIDENCE OF VALUE: it equals the
   * parked default, so a payload-preferring resolution would accept it and change nothing. It
   * stays in the payload because a realistic hand-written trigger would carry it, and it is
   * named here so nobody reads this test as covering all seven. Against the live database that is
   * `{"now":...,"lockSeconds":31536000}` wedging monitoring for a year, and
   * `{"now":...,"retentionRuns":1}` pruning the telemetry table to one row.
   *
   * JSON.parse and not an object literal ON PURPOSE: with `MonitorParams = { now }` an inline
   * literal carrying the extra keys is a COMPILE error (TS2353) and `tsc -p tsconfig.worker.json`
   * runs inside `npm run check`. The parse is also the faithful simulation -- wrangler delivers
   * parsed JSON, not a typed object.
   *
   * THE PAIRED POSITIVE HALF IS R1/R8/R9/R10: they prove every one of these knobs DOES work
   * when it arrives through `options`, so this test cannot pass because the options are broken.
   */
  it("R19: every tuning knob on a hand-written payload is inert", async () => {
    await maximumPriceSettings();

    // Three earlier runs, so `retentionRuns: 1` has something to destroy.
    for (const runId of ["run-older-1", "run-older-2", "run-older-3"]) {
      await runMonitor(db, recording().stepper, { now: T }, runId);
    }
    for (const source of [
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
      "golf",
      "hotel",
    ]) {
      await seed(source, 3);
    }

    const handWrittenPayload = JSON.parse(
      `{"now":${T},"lockSeconds":31536000,"drainSteps":1,"batchesPerDrainStep":1,` +
        `"batchSize":1,"maxSources":1,"retentionRuns":1,"collectionSteps":[]}`,
    ) as MonitorParams;

    // The lease is only observable WHILE the run holds it -- finalize releases it in the same
    // batch that records the run.
    let leaseWhileHeld: number | null = null;
    const recorder = recording({
      before: async (name) => {
        if (name !== "discover-sources") return;
        leaseWhileHeld = (await lockRow()).expires_at;
      },
    });

    const run = await runMonitor(db, recorder.stepper, handWrittenPayload, "run-payload");

    // lockSeconds: the module constant won, not the payload's year.
    expect(leaseWhileHeld).toBe(T + MONITOR_LOCK_SECONDS);
    // drainSteps and batchesPerDrainStep: the shipped budget ran, not one batch in one step.
    expect(run.batches).toBe(DRAIN_STEPS * BATCHES_PER_DRAIN_STEP);
    expect(run.stepsUsed).toBe(4 + DRAIN_STEPS);
    // batchSize: each batch took its source's three tasks, not one.
    expect(run.claimedCount).toBe(run.batches * 3);
    // maxSources: discovery was not capped at one source.
    expect(run.sources.length).toBeGreaterThan(1);
    // retentionRuns: the three earlier runs survived alongside this one.
    expect((await runRows()).map((row) => row.run_id)).toEqual([
      "run-older-1",
      "run-older-2",
      "run-older-3",
      "run-payload",
    ]);
  });

  /**
   * R20. `MAX_DRAIN_SOURCES` IS DERIVED SO THAT IT CANNOT EXCEED THE BATCH BUDGET, and until now
   * nothing held that. Decoupling it is silent in production: discovery orders ascending and
   * `position % active.length` walks only as far as the budget, so the SAME tail sources get
   * zero batches on every run forever -- the tier-3 fixed point the constant's own comment
   * names. Neither fallback fires: `undrained_sources` is not a monitor_runs column, and the
   * console.warn is gated on a status this path never sets and on a truncation that does not
   * happen once the cap is big enough to swallow every source.
   *
   * THE FIXTURE IS THE SHIPPED DEFAULTS, because the shipped defaults ARE the subject -- the
   * same exemption monitorLock.test.ts L7 and L9 take. The ORACLE IS BEHAVIOURAL and not a
   * mirror: it is the budget this run actually executed, so raising both constants together
   * still passes and raising only the cap does not.
   */
  it("R20: every discovered source gets a batch under the shipped defaults", async () => {
    await maximumPriceSettings();
    for (const source of [
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
      "golf",
      "hotel",
      "india",
    ]) {
      await seed(source, 3);
    }

    const run = await runMonitor(db, recording().stepper, { now: T }, "run-invariant");

    // Non-vacuous: there is something to starve, and batches were actually spent.
    expect(run.sources.length).toBeGreaterThan(0);
    expect(run.batches).toBeGreaterThan(0);
    // The invariant, against measured values rather than against the constants themselves.
    expect(run.sources.length).toBeLessThanOrEqual(run.batches);
    expect(run.undrainedSources).toEqual([]);
    // The independent second kill: every discovered source really did give up its three tasks.
    // A starved tail leaves claimedCount short of sources x 3 even if `undrainedSources` were
    // computed wrongly.
    expect(run.claimedCount).toBe(run.sources.length * 3);
  });
});
