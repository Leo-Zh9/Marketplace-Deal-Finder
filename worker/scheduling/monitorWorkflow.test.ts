// @vitest-environment node

/**
 * The whole monitoring chain, for real and end to end: the deployed cron string -> the bundled
 * `worker/index.ts` running inside workerd -> `scheduled()` -> `MONITOR_WORKFLOW.create()` ->
 * the real `WorkflowEntrypoint` -> the real `step.do` -> the real `loadCurrentSettings` and the
 * real `evaluateBatch` -> the real D1 with the real migrations.
 *
 * This is the only test that exercises `monitorWorkflow.ts`, and it is why that file is allowed
 * to contain no logic: everything else is proven against runMonitor.ts directly.
 *
 * It is also the only place `event.instanceId` is real. Everywhere else `runId` is a string a
 * test chose; here it is the platform's, which is what the lock actually fences on.
 *
 * The Workflow runs ASYNCHRONOUSLY once `create()` returns, so `settle` polls for the COMPLETE
 * expected state rather than for one symptom.
 */

import { truncateAll } from "../testing/d1";
import { acquireMonitorLock, releaseStatement } from "./monitorLock";
import { createScheduledTestWorker, type ScheduledTestWorker } from "../testing/workerBundle";

/**
 * The DEPLOYED cron strings, written as LITERALS rather than imported from `scheduled.ts`.
 * Importing the constants would make this test agree with itself: the handler would match
 * whatever the constant became and a changed cron would sail through. `scheduled.test.ts` S3
 * pins these literals to wrangler.jsonc.
 */
const MONITOR_CRON_LITERAL = "*/30 * * * *";
const CLEANUP_CRON_LITERAL = "0 17 * * *";
/** Neither trigger. Also the value scheduled.test.ts S2 was retargeted to. */
const UNRELATED_CRON = "13 4 * * *";

/**
 * Frozen, and in the PAST: both Workflows refuse a `now` more than a day ahead of the real
 * clock, and this instant reaches them through the real `scheduled()` handler with no seam in
 * between -- so a future fixture would be refused exactly as a mistyped operator payload is.
 */
const T = 1_700_000_000;
const DAY = 86_400;

const REVISION = 11;
const MAX_PRICE_CENTS = 43_700;
const PRICE_CENTS = 12_900;
const TASKS = 7;

let worker!: ScheduledTestWorker;

beforeAll(async () => {
  worker = await createScheduledTestWorker();
}, 60_000);

afterAll(async () => {
  await worker.dispose();
});

beforeEach(async () => {
  await truncateAll(worker.db);
});

/** Bootstrap + seed, exactly as docs/phase-3e-monitoring.md's runbook step 3 does by hand. */
const bootstrap = async () => {
  await worker.db.batch([
    worker.db
      .prepare(
        `INSERT INTO search_revisions
           (revision, mode, minimum_discount_percent, maximum_price_cents, created_at)
         VALUES (?1, 'MAXIMUM_PRICE', NULL, ?2, ?3)`,
      )
      .bind(REVISION, MAX_PRICE_CENTS, T),
    worker.db.prepare("INSERT INTO search_settings (id, current_revision) VALUES (1, ?1)").bind(REVISION),
    worker.db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO listings
         SELECT 'fx', 'L' || i, 'M', 'gpu', 'MODEL', '', 'title', ?2, NULL,
                'https://example.test/l', 'VALID', 'hash', ?3, ?3 FROM n`,
      )
      .bind(TASKS, PRICE_CENTS, T),
    worker.db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO evaluation_tasks (source, listing_id, status, created_at)
         SELECT 'fx', 'L' || i, 'PENDING', ?2 FROM n`,
      )
      .bind(TASKS, T),
  ]);
};

const taskStatuses = async () =>
  (
    await worker.db
      .prepare("SELECT status, COUNT(*) AS n FROM evaluation_tasks GROUP BY status ORDER BY status")
      .all<{ status: string; n: number }>()
  ).results;

const runStatuses = async () =>
  (
    await worker.db
      .prepare("SELECT status FROM monitor_runs ORDER BY status")
      .all<{ status: string }>()
  ).results.map((row) => row.status);

const lockRow = async () =>
  (
    await worker.db
      .prepare("SELECT run_id, acquired_at, expires_at FROM monitor_lock")
      .all<{ run_id: string; acquired_at: number; expires_at: number }>()
  ).results[0];

const observations = async () =>
  (
    await worker.db
      .prepare("SELECT listing_id FROM price_observations ORDER BY listing_id")
      .all<{ listing_id: string }>()
  ).results.map((row) => row.listing_id);

/**
 * Poll until the expected state is reached, then stop. The bound is ~10s and the test's own
 * timeout is 30s, deliberately: when the Workflow never gets there the failure must be the
 * assertion's diff -- which says WHAT is wrong -- and not a test timeout, which says only that
 * something is.
 */
const settle = async (ready: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (await ready()) return;
  }
};

describe("MonitorWorkflow, driven by a real Cron trigger", () => {
  it("W1: the monitoring cron drains; the cleanup cron and an unrelated cron do not", async () => {
    await bootstrap();
    // A stale observation only the CLEANUP cron can remove, so its arm proves cleanup ran
    // rather than merely that nothing happened.
    await worker.db.batch([
      worker.db.prepare("INSERT INTO price_observations VALUES ('fx','stale','M','S','',100,?1)").bind(T - 9 * DAY),
      worker.db.prepare("INSERT INTO model_stats VALUES ('M','S','',1,100)"),
    ]);

    // 1. Neither trigger: nothing runs at all.
    await worker.fire(UNRELATED_CRON, T);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await taskStatuses()).toEqual([{ status: "PENDING", n: TASKS }]);
    expect(await runStatuses()).toEqual([]);
    expect(await observations()).toEqual(["stale"]);

    // 2. The cleanup cron: it sweeps price_observations and LEAVES evaluation_tasks alone.
    //    Without the explicit match, this is where monitoring would silently run once a day.
    await worker.fire(CLEANUP_CRON_LITERAL, T);
    await settle(async () => (await observations()).length === 0);
    expect(await observations()).toEqual([]);
    expect(await taskStatuses()).toEqual([{ status: "PENDING", n: TASKS }]);
    expect(await runStatuses()).toEqual([]);

    // 3. The monitoring cron: the tasks drain, and the run records itself.
    await worker.fire(MONITOR_CRON_LITERAL, T);
    await settle(async () => (await runStatuses()).length === 1);
    expect(await runStatuses()).toEqual(["OK"]);
    expect(await taskStatuses()).toEqual([{ status: "COMPLETE", n: TASKS }]);
    expect(
      (
        await worker.db
          .prepare("SELECT DISTINCT verdict FROM evaluation_tasks")
          .all<{ verdict: string }>()
      ).results,
    ).toEqual([{ verdict: "DEAL" }]);
  }, 30_000);

  it("W2: the run took the lock and gave it back, and acquired_at proves it was taken", async () => {
    await bootstrap();

    await worker.fire(MONITOR_CRON_LITERAL, T);
    await settle(async () => (await runStatuses()).length === 1);

    // `run_id: ''` and `expires_at: 0` alone are equally satisfied by a lock that was NEVER
    // ACQUIRED -- which is exactly what a crossed binding or a missing entry re-export would
    // produce. `acquired_at` surviving the release, and equalling the run's own `now`, is what
    // separates the two.
    expect(await lockRow()).toEqual({ run_id: "", acquired_at: T, expires_at: 0 });
  }, 30_000);

  /**
   * W3. A run that meets a lock somebody else holds, through the real chain.
   *
   * MEASURED DIVERGENCE FROM THE PLAN, and it is why this is not two concurrent `create()`s:
   * miniflare runs Workflow instances SERIALLY. Two fires at the same instant produced two
   * distinct instance ids whose runs did not overlap at all -- the first drained six batches,
   * finished and RELEASED, and only then did the second start and legitimately take the free
   * lock. Both reported OK, which is correct behaviour and proves nothing about contention.
   *
   * So the contended state is constructed rather than raced: a run is in flight and holding the
   * lock when the cron fires. That is the state a second instance actually sees, it is
   * deterministic, and it asserts the half a race cannot -- that the loser's FENCED release
   * leaves the holder's row byte-intact. runMonitor.test.ts R4 drives the genuine two-run
   * interleaving, single-threaded and deterministic, against real D1.
   */
  it("W3: a run that meets a held lock skips, records itself, and leaves the holder intact", async () => {
    await bootstrap();

    const inFlight = await acquireMonitorLock(worker.db, {
      runId: "run-in-flight",
      now: T,
      lockSeconds: 601,
    });
    expect(inFlight.acquired).toBe(true);

    await worker.fire(MONITOR_CRON_LITERAL, T);
    await settle(async () => (await runStatuses()).length === 1);

    expect(await runStatuses()).toEqual(["SKIPPED_LOCKED"]);
    // It mutated NOTHING but its own telemetry row.
    expect(await taskStatuses()).toEqual([{ status: "PENDING", n: TASKS }]);
    // Byte-intact. Unfenced, the loser's release wipes the live holder's row here.
    expect(await lockRow()).toEqual({
      run_id: "run-in-flight",
      acquired_at: T,
      expires_at: T + 601,
    });

    // The in-flight run finishes and releases; the next fire is an ordinary successful run.
    await releaseStatement(worker.db, "run-in-flight").run();
    await worker.fire(MONITOR_CRON_LITERAL, T);
    await settle(async () => (await runStatuses()).length === 2);

    expect(await runStatuses()).toEqual(["OK", "SKIPPED_LOCKED"]);
    expect(await taskStatuses()).toEqual([{ status: "COMPLETE", n: TASKS }]);
    expect(await lockRow()).toEqual({ run_id: "", acquired_at: T, expires_at: 0 });
    // Two DIFFERENT instance ids, so this is two runs and not one row written twice -- and the
    // ids are the platform's, which is what the lock fences on.
    const ids = (
      await worker.db.prepare("SELECT run_id FROM monitor_runs").all<{ run_id: string }>()
    ).results.map((row) => row.run_id);
    expect(new Set(ids).size).toBe(2);
  }, 30_000);
});
