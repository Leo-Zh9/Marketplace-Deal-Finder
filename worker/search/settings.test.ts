// @vitest-environment node

/**
 * Search settings and the revision log, against real D1 with the real migrations.
 *
 * The anchor for INVARIANT 1 -- a bump never destroys evaluation history -- is deliberately
 * outside this module: T3 runs the MERGED `evaluateBatch` as its oracle, so "the bump made
 * the right tasks eligible" is proven by the code that will actually claim them rather than
 * by restating this file's own SQL.
 */

import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";
import { evaluateBatch } from "../evaluation/evaluateBatch";
import { loadCurrentSettings, updateSearchSettings } from "./settings";

const T = 1_800_000_000;
const SOURCE = "fx";
const MARKET = "M";

let database!: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database.dispose();
});

beforeEach(async () => {
  await truncateAll(database.db);
});

const revisions = async () =>
  (
    await database.db
      .prepare(
        "SELECT revision, mode, minimum_discount_percent, maximum_price_cents FROM search_revisions ORDER BY revision",
      )
      .all()
  ).results;

const tasks = async () =>
  (await database.db.prepare("SELECT * FROM evaluation_tasks ORDER BY listing_id").all()).results;

/**
 * Six tasks across all four statuses. Every column that could be confused with another is
 * set INDEPENDENTLY of listing_id, `created_at` and `evaluated_at` run in OPPOSITE
 * directions, and L4 carries a live lease so tier 2 must not claim it.
 */
const seedCorpus = async () => {
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < 6; index += 1) {
    statements.push(
      database.db
        .prepare(
          "INSERT INTO listings VALUES (?1,?2,?3,'gpu','MODEL','','t',?4,'here','http://x','VALID','h',?5,?5)",
        )
        .bind(SOURCE, `L${index}`, MARKET, 40_000 + index, T),
      database.db
        .prepare("INSERT INTO price_observations VALUES (?1,?2,?3,'MODEL','',?4,?5)")
        .bind(SOURCE, `L${index}`, MARKET, 40_000 + index, T),
    );
  }
  // 40,000 + ... + 40,005 = 240,015, so each candidate sees count 5 and a real total.
  statements.push(
    database.db.prepare("INSERT INTO model_stats VALUES (?1,'MODEL','',6,240015)").bind(MARKET),
  );

  const rows: Array<[string, string, number, string | null, number | null, number, number, string]> =
    [
      ["L0", "COMPLETE", 100, "DEAL", 0, T - 10, 0, ""],
      ["L1", "COMPLETE", 101, "NOT_DEAL", 0, T - 20, 0, ""],
      ["L2", "NEEDS_REVIEW", 102, "NEEDS_REVIEW", 0, T - 30, 0, ""],
      ["L3", "PENDING", 103, null, null, 0, 0, ""],
      ["L4", "PROCESSING", 104, null, 0, T - 40, T + 9_999, "tok-live"],
      ["L5", "COMPLETE", 105, "DEAL", 0, T - 50, 0, ""],
    ];
  for (const [id, status, createdAt, verdict, revision, evaluatedAt, lease, token] of rows) {
    statements.push(
      database.db
        .prepare(
          "INSERT INTO evaluation_tasks (source,listing_id,status,created_at,verdict,evaluated_revision,evaluated_at,lease_expires_at,lease_token) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        )
        .bind(SOURCE, id, status, createdAt, verdict, revision, evaluatedAt, lease, token),
    );
  }
  await database.db.batch(statements);
};

describe("search settings", () => {
  // T1. The schema's own guarantees, asserted against the applied migration rather than
  // against the file: exactly one active search, no dangling pointer, no invented mode.
  it("T1: the schema refuses a second search, a dangling pointer and an unknown mode", async () => {
    await database.db.prepare("INSERT INTO search_revisions VALUES (0,'DISCOUNT',20,NULL,1)").run();
    await database.db.prepare("INSERT INTO search_settings VALUES (1,0)").run();

    // CHECK (id = 1): a second active search is the state the multi-market flap needs.
    await expect(
      database.db.prepare("INSERT INTO search_settings VALUES (2,0)").run(),
    ).rejects.toThrow(/CHECK constraint failed/);

    // The foreign key: a pointer at a revision that does not exist.
    await expect(
      database.db.prepare("UPDATE search_settings SET current_revision = 99 WHERE id = 1").run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);

    // CHECK (mode IN ...): the column is TEXT, and `loadCurrentSettings` narrows it to
    // DealMode on the way out. This CHECK is what makes that narrowing honest.
    await expect(
      database.db.prepare("INSERT INTO search_revisions VALUES (1,'WISHFUL',20,NULL,1)").run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("T2: first configure is revision 0; an unchanged save does not bump; a change bumps by one", async () => {
    const first = await updateSearchSettings(database.db, {
      mode: "DISCOUNT",
      minimumDiscountPercent: 20,
      maximumPriceCents: null,
      now: T,
    });
    expect(first).toMatchObject({ revision: 0, changed: true });

    const unchanged = await updateSearchSettings(database.db, {
      mode: "DISCOUNT",
      minimumDiscountPercent: 20,
      maximumPriceCents: null,
      now: T + 1,
    });
    expect(unchanged).toMatchObject({ revision: 0, changed: false });
    // `changed: false` must mean ZERO WRITES, not a no-op revision row.
    expect(await revisions()).toHaveLength(1);

    const changed = await updateSearchSettings(database.db, {
      mode: "DISCOUNT",
      minimumDiscountPercent: 30,
      maximumPriceCents: null,
      now: T + 2,
    });
    expect(changed).toMatchObject({ revision: 1, changed: true });
    expect(await revisions()).toHaveLength(2);
    expect((await loadCurrentSettings(database.db)).settings).toEqual({
      mode: "DISCOUNT",
      minimumDiscountPercent: 30,
      maximumPriceCents: null,
      searchRevision: 1,
    });
  });

  /**
   * T3 -- INVARIANT 1, three anchors.
   *
   * (i) alone is satisfiable by a bump that does nothing at all, so it is paired with (ii),
   * anchored outside this module in the merged evaluateBatch, and (iii), the run-again
   * control that distinguishes "the revision made these eligible" from "COMPLETE is always
   * eligible".
   */
  it("T3: a bump writes nothing to evaluation_tasks, yet makes stamped tasks eligible exactly once", async () => {
    await updateSearchSettings(database.db, {
      mode: "DISCOUNT",
      minimumDiscountPercent: 20,
      maximumPriceCents: null,
      now: T,
    });
    await seedCorpus();
    const before = await tasks();

    const bumped = await updateSearchSettings(database.db, {
      mode: "DISCOUNT",
      minimumDiscountPercent: 35,
      maximumPriceCents: null,
      now: T + 5,
    });
    expect(bumped).toMatchObject({ revision: 1, changed: true });

    // ANCHOR (i): every column of every task, byte-identical across the bump.
    expect(await tasks()).toEqual(before);

    // ANCHOR (ii): the merged evaluator, given the loaded settings, claims exactly the five
    // tasks the revision re-opened. L4 is excluded because its lease is still live.
    const settings = (await loadCurrentSettings(database.db)).settings!;
    const reopened = await evaluateBatch(database.db, {
      source: SOURCE,
      settings,
      now: T + 6,
      leaseToken: "tok-bump",
    });
    expect(reopened.claimed).toBe(5);
    expect(reopened.outcomes.map((outcome) => outcome.listingId).sort()).toEqual([
      "L0",
      "L1",
      "L2",
      "L3",
      "L5",
    ]);

    // Post-run-1 state, asserted so ANCHOR (iii) cannot pass for the wrong reason -- a
    // second call claiming zero proves nothing if everything were left PROCESSING.
    expect(
      (
        await database.db
          .prepare(
            "SELECT listing_id, status, evaluated_revision FROM evaluation_tasks ORDER BY listing_id",
          )
          .all()
      ).results,
    ).toEqual([
      { listing_id: "L0", status: "COMPLETE", evaluated_revision: 1 },
      { listing_id: "L1", status: "COMPLETE", evaluated_revision: 1 },
      { listing_id: "L2", status: "COMPLETE", evaluated_revision: 1 },
      { listing_id: "L3", status: "COMPLETE", evaluated_revision: 1 },
      { listing_id: "L4", status: "PROCESSING", evaluated_revision: 0 },
      { listing_id: "L5", status: "COMPLETE", evaluated_revision: 1 },
    ]);

    // ANCHOR (iii): with no further bump, the same call claims NOTHING.
    const control = await evaluateBatch(database.db, {
      source: SOURCE,
      settings,
      now: T + 7,
      leaseToken: "tok-control",
    });
    expect(control.claimed).toBe(0);
    expect(control.outcomes).toEqual([]);
  });

  it("T4: an invalid setting is rejected BEFORE any write, on a fresh and on a configured database", async () => {
    const invalid = {
      mode: "DISCOUNT" as const,
      minimumDiscountPercent: null,
      maximumPriceCents: null,
      now: T,
    };

    await expect(updateSearchSettings(database.db, invalid)).rejects.toThrow(
      /requires minimumDiscountPercent/,
    );
    expect(await revisions()).toEqual([]);
    expect((await loadCurrentSettings(database.db)).settings).toBeNull();

    await updateSearchSettings(database.db, {
      mode: "DISCOUNT",
      minimumDiscountPercent: 20,
      maximumPriceCents: null,
      now: T + 1,
    });
    const configured = await revisions();

    await expect(
      updateSearchSettings(database.db, { ...invalid, now: T + 2 }),
    ).rejects.toThrow(/requires minimumDiscountPercent/);
    // Not merely "no new revision": the pointer and the log are exactly as they were.
    expect(await revisions()).toEqual(configured);
    expect((await loadCurrentSettings(database.db)).settings).toEqual({
      mode: "DISCOUNT",
      minimumDiscountPercent: 20,
      maximumPriceCents: null,
      searchRevision: 0,
    });
  });

  /**
   * T5. Three independent pins in one test, and each catches a different mutation:
   *   - comparing RAW INPUT instead of the projection fails the inert-field and the
   *     float cases;
   *   - storing RAW INPUT instead of the projection fails only the normalized-storage case;
   *   - dropping maximumPriceCents from the comparison fails only the BOTH case.
   * `4.356 -> 4.36` additionally discriminates Math.round from Math.trunc, which gives 4.35.
   */
  it("T5: what a setting MEANS decides the bump, and the stored row holds only what applies", async () => {
    // (a) maximumPriceCents is inert under DISCOUNT: changing or dropping it cannot alter
    //     one verdict, so it must not re-open the corpus.
    expect(
      await updateSearchSettings(database.db, {
        mode: "DISCOUNT",
        minimumDiscountPercent: 20,
        maximumPriceCents: 50_000,
        now: T,
      }),
    ).toMatchObject({ revision: 0, changed: true });
    expect(
      await updateSearchSettings(database.db, {
        mode: "DISCOUNT",
        minimumDiscountPercent: 20,
        maximumPriceCents: 99_999,
        now: T + 1,
      }),
    ).toMatchObject({ revision: 0, changed: false });
    expect(
      await updateSearchSettings(database.db, {
        mode: "DISCOUNT",
        minimumDiscountPercent: 20,
        maximumPriceCents: null,
        now: T + 2,
      }),
    ).toMatchObject({ revision: 0, changed: false });
    expect(await revisions()).toHaveLength(1);

    // (b) a float that maps to the same basis points is the same setting; one basis point
    //     of difference is not.
    await truncateAll(database.db);
    await updateSearchSettings(database.db, {
      mode: "DISCOUNT",
      minimumDiscountPercent: 4.35,
      maximumPriceCents: null,
      now: T,
    });
    expect(
      await updateSearchSettings(database.db, {
        mode: "DISCOUNT",
        minimumDiscountPercent: 4.350000000000001,
        maximumPriceCents: null,
        now: T + 1,
      }),
    ).toMatchObject({ revision: 0, changed: false });
    expect(
      await updateSearchSettings(database.db, {
        mode: "DISCOUNT",
        minimumDiscountPercent: 4.36,
        maximumPriceCents: null,
        now: T + 2,
      }),
    ).toMatchObject({ revision: 1, changed: true });

    // (c) the row records what was APPLIED: the rounded percent, and no inert maximum.
    await truncateAll(database.db);
    await updateSearchSettings(database.db, {
      mode: "DISCOUNT",
      minimumDiscountPercent: 4.356,
      maximumPriceCents: 50_000,
      now: T,
    });
    expect(await revisions()).toEqual([
      { revision: 0, mode: "DISCOUNT", minimum_discount_percent: 4.36, maximum_price_cents: null },
    ]);
    expect((await loadCurrentSettings(database.db)).settings).toEqual({
      mode: "DISCOUNT",
      minimumDiscountPercent: 4.36,
      maximumPriceCents: null,
      searchRevision: 0,
    });
    // Re-saving the ORIGINAL typed value round-trips to the same projection.
    expect(
      await updateSearchSettings(database.db, {
        mode: "DISCOUNT",
        minimumDiscountPercent: 4.356,
        maximumPriceCents: 50_000,
        now: T + 1,
      }),
    ).toMatchObject({ changed: false });

    // (d) under BOTH the maximum price is LIVE again, so changing it does bump. This is the
    //     only assertion in the suite that catches an over-eager normalization.
    await truncateAll(database.db);
    await updateSearchSettings(database.db, {
      mode: "DISCOUNT",
      minimumDiscountPercent: 20,
      maximumPriceCents: 50_000,
      now: T,
    });
    expect(
      await updateSearchSettings(database.db, {
        mode: "BOTH",
        minimumDiscountPercent: 20,
        maximumPriceCents: 50_000,
        now: T + 1,
      }),
    ).toMatchObject({ revision: 1, changed: true });
    expect(
      await updateSearchSettings(database.db, {
        mode: "BOTH",
        minimumDiscountPercent: 20,
        maximumPriceCents: 99_999,
        now: T + 2,
      }),
    ).toMatchObject({ revision: 2, changed: true });
  });
});
