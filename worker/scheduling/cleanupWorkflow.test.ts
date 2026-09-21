// @vitest-environment node

/**
 * The whole chain, for real and end to end: the deployed cron string -> the bundled
 * `worker/index.ts` running inside workerd -> `scheduled()` -> `CLEANUP_WORKFLOW.create()`
 * -> the real `WorkflowEntrypoint` -> the real `step.do` -> the real
 * `cleanupStaleObservations` -> the real D1 with the real migrations.
 *
 * This is the only test that exercises `cleanupWorkflow.ts`, and it is why that file is
 * allowed to contain no logic: everything else is proven against runCleanup.ts directly.
 *
 * The Workflow runs ASYNCHRONOUSLY once `create()` returns, so `settle` polls for the
 * COMPLETE expected state rather than for one symptom. CLEAN_B and CLEAN_SWEEP land in
 * separate statements a few milliseconds apart; waiting on "a1 is gone" would let the test
 * read the database between them and assert a half-finished sweep.
 */

import {
  createScheduledTestWorker,
  type ScheduledTestWorker,
} from "../testing/workerBundle";

/**
 * The DEPLOYED cron string, written as a literal rather than imported from
 * `scheduled.ts`. Importing the constant would make this test agree with itself: the
 * handler would match whatever the constant became, and a changed cron would sail
 * through. `scheduled.test.ts` S3 pins the literal to `wrangler.jsonc`.
 */
const DEPLOYED_CRON = "0 17 * * *";

const T = 1_800_000_000;
const DAY = 86_400;

let worker!: ScheduledTestWorker;

beforeAll(async () => {
  // vite.build is ~40ms warm on a developer machine; a cold CI runner is slower.
  worker = await createScheduledTestWorker();
}, 60_000);

afterAll(async () => {
  await worker.dispose();
});

const state = async () => ({
  observations: (
    await worker.db
      .prepare("SELECT listing_id FROM price_observations ORDER BY listing_id")
      .all<{ listing_id: string }>()
  ).results.map((row) => row.listing_id),
  aggregates: (
    await worker.db
      .prepare("SELECT model_key, count, total_price_cents FROM model_stats ORDER BY model_key")
      .all()
  ).results,
});

/**
 * Poll until the database reaches the COMPLETE expected state, then stop. The bound is
 * ~3s and the test's own timeout is 20s, deliberately: when the Workflow never gets
 * there, the failure must be the assertion's diff -- which says WHAT is wrong -- and not
 * a test timeout, which says only that something is.
 */
const settle = async (expected: Awaited<ReturnType<typeof state>>) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (JSON.stringify(await state()) === JSON.stringify(expected)) return;
  }
};

describe("CleanupWorkflow, driven by a real Cron trigger", () => {
  it("H1: the deployed cron runs the real Workflow; an unrelated cron does not", async () => {
    const observation = (id: string, model: string, lastSeenAt: number) =>
      worker.db
        .prepare("INSERT INTO price_observations VALUES ('fx',?1,'M',?2,'',100,?3)")
        .bind(id, model, lastSeenAt);

    await worker.db.batch([
      // Stale and fresh groups carry the SAME observation count and price: staleness is
      // the only difference between them.
      observation("a1", "A", T - 8 * DAY),
      observation("a2", "A", T - 9 * DAY),
      observation("b1", "B", T - 1 * DAY),
      observation("b2", "B", T - 2 * DAY),
      worker.db.prepare("INSERT INTO model_stats VALUES ('M','A','',2,200)"),
      worker.db.prepare("INSERT INTO model_stats VALUES ('M','B','',2,200)"),
      // A 0/0 orphan with no observations at all. Only CLEAN_SWEEP can reach it, and 3D
      // would read its average as NULL.
      worker.db.prepare("INSERT INTO model_stats VALUES ('M','Z','',0,0)"),
    ]);

    const untouched = await state();
    await worker.fire("*/30 * * * *", T);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await state()).toEqual(untouched);

    const expected = {
      observations: ["b1", "b2"],
      aggregates: [{ model_key: "B", count: 2, total_price_cents: 200 }],
    };
    await worker.fire(DEPLOYED_CRON, T);
    await settle(expected);
    expect(await state()).toEqual(expected);
  }, 20_000);
});
