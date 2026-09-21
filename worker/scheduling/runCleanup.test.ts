// @vitest-environment node

/**
 * The cleanup orchestration, against REAL D1 with the real migrations and the real
 * `cleanupStaleObservations`. Only the Workflow step is faked, and the fake memoizes BY
 * NAME exactly as the platform does -- so a constant step name is a test failure here, not
 * a surprise in production.
 *
 * FIXTURE CORRELATION. No two parameters THAT REACH THE CODE UNDER TEST share a value, and
 * none equals a default (25 groups/batch, 1 batch/step, 32 steps, 1,000,000 rows). R4's
 * budget is 7 and not 1 for exactly that reason: 1 is BATCHES_PER_STEP's default, so a
 * budget/batches confusion would pass. `seed`'s own arguments are fixture sizes that never
 * reach runCleanup, so they are outside the rule.
 *
 * Stale and fresh groups carry the SAME observation count and the SAME price, so staleness
 * is the only difference between them. The cutoff boundary itself is deliberately NOT
 * retested: `cleanupStaleObservations.test.ts` owns it.
 */

import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";
import { STALE_AFTER_SECONDS, type CleanupReport } from "../storage/types";
import {
  runCleanup,
  type CleanupParams,
  type CleanupStepper,
} from "./runCleanup";

const T = 1_800_000_000;
const DAY = 86_400;

let database!: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database.dispose();
});

/**
 * A stepper that memoizes by name, records what it was asked to do, and can be told to
 * throw on the n-th body execution.
 */
const recording = (failAt?: number) => {
  const memo = new Map<string, CleanupReport>();
  const names: string[] = [];
  const configs: unknown[] = [];
  const reports: CleanupReport[] = [];
  let executed = 0;

  const stepper: CleanupStepper = {
    async do(name, config, callback) {
      names.push(name);
      configs.push(config);
      const memoized = memo.get(name);
      if (memoized !== undefined) return memoized;
      if (failAt !== undefined && executed === failAt) {
        executed += 1;
        throw new Error("step exploded");
      }
      executed += 1;
      const report = await callback();
      memo.set(name, report);
      reports.push(report);
      return report;
    },
  };

  return { stepper, names, configs, reports };
};

const seed = async (staleGroups: number, perGroup: number, freshGroups: number) => {
  await truncateAll(database.db);
  const rows: D1PreparedStatement[] = [];
  const observation = (id: string, model: string, lastSeenAt: number) =>
    rows.push(
      database.db
        .prepare("INSERT INTO price_observations VALUES ('fx',?1,'M',?2,'',100,?3)")
        .bind(id, model, lastSeenAt),
    );
  const aggregate = (model: string) =>
    rows.push(
      database.db
        .prepare("INSERT INTO model_stats VALUES ('M',?1,'',?2,?3)")
        .bind(model, perGroup, perGroup * 100),
    );

  for (let group = 0; group < staleGroups; group += 1) {
    for (let index = 0; index < perGroup; index += 1) {
      observation(`s${group}-${index}`, `S${group}`, T - 10 * DAY);
    }
    aggregate(`S${group}`);
  }
  for (let group = 0; group < freshGroups; group += 1) {
    for (let index = 0; index < perGroup; index += 1) {
      observation(`f${group}-${index}`, `F${group}`, T - DAY);
    }
    aggregate(`F${group}`);
  }
  // D1 caps a batch; 200 statements at a time keeps every fixture inside it.
  for (let index = 0; index < rows.length; index += 200) {
    await database.db.batch(rows.slice(index, index + 200));
  }
};

const observations = async () =>
  (
    await database.db
      .prepare("SELECT listing_id FROM price_observations ORDER BY listing_id")
      .all<{ listing_id: string }>()
  ).results.map((row) => row.listing_id);

const aggregates = async () =>
  (
    await database.db
      .prepare("SELECT model_key, count, total_price_cents FROM model_stats ORDER BY model_key")
      .all()
  ).results;

const SURVIVORS_4 = ["f0-0", "f0-1", "f0-2", "f0-3"];

/**
 * A hand-written `wrangler workflows trigger '<json>'` payload carrying the knob that used
 * to be reachable. JSON.parse and not an object literal on purpose: with
 * `CleanupParams = { now }` an inline literal carrying the extra key is a COMPILE error
 * (TS2353), and `tsc -p tsconfig.worker.json` runs inside `npm run check`. The parse is
 * also the faithful simulation -- wrangler delivers parsed JSON, not a typed object.
 */
const handWrittenPayload = JSON.parse(
  '{"now":1800000000,"staleAfterSeconds":0}',
) as CleanupParams;

describe("runCleanup", () => {
  /**
   * F1. BOTH ASSERTIONS ARE LOAD-BEARING AND THEY CATCH DIFFERENT MUTATIONS. Do not trim
   * either:
   *   - plumbing the payload's staleAfterSeconds into the cleanupStaleObservations call but
   *     NOT into the reported cutoff leaves cutoff at 1799395200 -- the cutoff assertion
   *     passes -- while the table is emptied. Only the survivor assertion catches it.
   *   - reverting the narrowing outright is caught by the cutoff assertion
   *     (`expected 1800000000 to be 1799395200`), where the survivors alone would be
   *     ambiguous.
   */
  it("F1: an extra key on the payload is INERT -- it cannot move the cutoff", async () => {
    await seed(8, 4, 1);

    const run = await runCleanup(database.db, recording().stepper, handWrittenPayload);

    expect(run.cutoff).toBe(T - STALE_AFTER_SECONDS);
    expect(await observations()).toEqual(SURVIVORS_4);
  });

  it("R1: continues to exhaustion, with every step's granule asserted literally", async () => {
    await seed(8, 4, 1);
    const recorder = recording();

    const run = await runCleanup(
      database.db,
      recorder.stepper,
      { now: T },
      { groupsPerBatch: 2, batchesPerStep: 3 },
    );

    // Unique names, because step.do memoizes by name: a constant name would replay step 0.
    expect(new Set(recorder.names).size).toBe(recorder.names.length);
    expect(run.stoppedBecause).toBe("exhausted");
    // The literal per-step granule, not `every(x => x.batches <= 3)`: the loose form passes
    // when groupsPerBatch and maxBatches are swapped at the call site.
    expect(recorder.reports.map((report) => ({ b: report.batches, g: report.groups }))).toEqual([
      { b: 3, g: 6 },
      { b: 1, g: 2 },
    ]);
    expect((recorder.configs[0] as { retries: { limit: number } }).retries.limit).toBe(2);
    // Named survivors AND literal aggregate arithmetic: "no double subtraction" is the
    // both-losing pattern, so the count and the total are pinned, not just the row set.
    expect(await observations()).toEqual(SURVIVORS_4);
    expect(await aggregates()).toEqual([{ model_key: "F0", count: 4, total_price_cents: 400 }]);
  });

  it("R2: interrupted at the step cap, then resumed, subtracts exactly once", async () => {
    await seed(30, 5, 1);

    const first = await runCleanup(
      database.db,
      recording().stepper,
      { now: T },
      { groupsPerBatch: 2, batchesPerStep: 3, maxSteps: 4 },
    );
    expect(first).toMatchObject({
      steps: 4,
      groups: 24,
      remaining: true,
      stoppedBecause: "step-cap",
    });

    // Mid-run: work is committed, not held. 6 stale groups and the fresh one are left.
    const midObservations = await observations();
    const midAggregates = await aggregates();
    expect({ observations: midObservations.length, aggregates: midAggregates.length }).toEqual({
      observations: 35,
      aggregates: 7,
    });

    const second = await runCleanup(
      database.db,
      recording().stepper,
      { now: T },
      { groupsPerBatch: 2, batchesPerStep: 3 },
    );
    expect(second).toMatchObject({ groups: 6, remaining: false, stoppedBecause: "exhausted" });
    expect(await observations()).toEqual(["f0-0", "f0-1", "f0-2", "f0-3", "f0-4"]);
    expect(await aggregates()).toEqual([{ model_key: "F0", count: 5, total_price_cents: 500 }]);
  });

  it("R3: a throwing step propagates; committed work survives; a re-run completes", async () => {
    await seed(8, 4, 1);

    await expect(
      runCleanup(
        database.db,
        recording(1).stepper,
        { now: T },
        { groupsPerBatch: 2, batchesPerStep: 3 },
      ),
    ).rejects.toThrow("step exploded");

    // Step 0's six groups are gone and stay gone: the unit of commitment is one group's
    // CLEAN_A + CLEAN_B, so nothing half-applied.
    const afterThrow = await observations();
    expect(afterThrow).toHaveLength(12);

    await runCleanup(
      database.db,
      recording().stepper,
      { now: T },
      { groupsPerBatch: 2, batchesPerStep: 3 },
    );
    expect(await observations()).toEqual(SURVIVORS_4);
    expect(await aggregates()).toEqual([{ model_key: "F0", count: 4, total_price_cents: 400 }]);
  });

  it("R4: the rows-read budget stops the loop with remaining:true", async () => {
    await seed(8, 4, 1);

    const run = await runCleanup(
      database.db,
      recording().stepper,
      { now: T },
      { groupsPerBatch: 2, batchesPerStep: 3, rowsReadBudget: 7 },
    );

    expect(run).toMatchObject({
      steps: 1,
      groups: 6,
      remaining: true,
      stoppedBecause: "budget",
    });
  });

  it("R5: `now` must be epoch seconds, and a rejection writes nothing", async () => {
    await seed(1, 1, 1);
    const before = { observations: await observations(), aggregates: await aggregates() };

    // Milliseconds are THE catastrophic input: the cutoff would be now_ms - 604800, which
    // is in the future by every row's reckoning, so the first run empties the table.
    await expect(runCleanup(database.db, recording().stepper, { now: T * 1000 })).rejects.toThrow(
      /epoch seconds/,
    );
    expect({ observations: await observations(), aggregates: await aggregates() }).toEqual(before);

    for (const bad of [0, 1e9 - 1, 1e11 + 1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      await expect(runCleanup(database.db, recording().stepper, { now: bad })).rejects.toThrow(
        /epoch seconds/,
      );
    }

    const run = await runCleanup(database.db, recording().stepper, { now: T });
    expect(run.cutoff).toBe(T - STALE_AFTER_SECONDS);
    expect(await observations()).toEqual(["f0-0"]);
  });

  /**
   * R6 pins the DEFAULT granule behaviourally, with an oracle -- no `expect(GROUPS_PER_BATCH)
   * .toBe(25)` mirror. A constant pinned to itself proves only that the file was not edited.
   */
  it("R6: the default granule is one batch of 25 groups", async () => {
    await seed(30, 2, 1);
    const recorder = recording();

    const run = await runCleanup(database.db, recorder.stepper, { now: T });

    expect({
      batches: recorder.reports[0].batches,
      groups: recorder.reports[0].groups,
    }).toEqual({ batches: 1, groups: 25 });
    expect(run.steps).toBe(2);
  });
});
