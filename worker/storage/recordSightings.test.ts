// @vitest-environment node

import { cleanupStaleObservations } from "./cleanupStaleObservations";
import { recordSightings } from "./recordSightings";
import { STALE_AFTER_SECONDS, type Listing, type Sighting } from "./types";
import type { Market } from "./marketKey";
import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";

const SOURCE = "test-provider";
const T0 = 1_760_000_000;
const DAY = 24 * 60 * 60;

const MARKET_A: Market = { latitude: 43.4643, longitude: -80.5204, radiusKm: 25 };
const MARKET_B: Market = { latitude: 43.4643, longitude: -80.5204, radiusKm: 50 };
const MARKET_C: Market = { latitude: 43.4643, longitude: -80.5204, radiusKm: 75 };

let database!: TestDatabase;
let db!: D1Database;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
});

afterAll(async () => {
  await database.dispose();
});

beforeEach(async () => {
  await truncateAll(db);
});

const listing = (overrides: Partial<Listing> & { listingId: string }): Listing => ({
  componentType: "gpu",
  modelKey: "RTX_4070_SUPER",
  variantKey: null,
  title: "RTX 4070 Super, barely used",
  priceCents: 50_000,
  locationText: "Waterloo, ON",
  // DELIBERATELY NOT DERIVED FROM listingId. `url` and `listingId` are independent fields --
  // one listing id can arrive under several urls (a tracking parameter, a canonicalisation
  // change between two pages of one scrape, a mobile form) -- and `url` is also part of the
  // content hash. A fixture that keeps them 1:1 makes the two indistinguishable, so no test
  // can tell which one the code actually keys on. Tests that need distinct urls override it.
  url: "https://example.test/listing",
  observedAt: "2026-09-20T00:00:00Z",
  ...overrides,
});

const valid = (overrides: Partial<Listing> & { listingId: string }): Sighting => ({
  listing: listing(overrides),
  validity: "VALID",
});

const sight = (sightings: Sighting[], now: number, market: Market = MARKET_A) =>
  recordSightings(db, { source: SOURCE, market, sightings, now });

/**
 * The same listing, seen again on a later scan: identical content, a NEW provider
 * observation timestamp. That is what "an identical re-sighting" actually looks like on the
 * wire, and it is why `observedAt` must not enter contentHash -- if it did, every sighting
 * of every listing would classify CHANGED and the write budget would collapse.
 */
const seenAgain = (sighting: Sighting, observedAt: string): Sighting => ({
  ...sighting,
  listing: { ...sighting.listing, observedAt },
});

interface StatsRow {
  market_key: string;
  model_key: string;
  variant_key: string;
  count: number;
  total_price_cents: number;
}

const allStats = async (): Promise<StatsRow[]> =>
  (
    await db
      .prepare(
        "SELECT market_key, model_key, variant_key, count, total_price_cents FROM model_stats" +
          " ORDER BY market_key, model_key, variant_key",
      )
      .all<StatsRow>()
  ).results;

const allObservations = async () =>
  (
    await db
      .prepare(
        "SELECT source, listing_id, market_key, model_key, variant_key, price_cents, last_seen_at" +
          " FROM price_observations ORDER BY listing_id",
      )
      .all<{
        source: string;
        listing_id: string;
        market_key: string;
        model_key: string;
        variant_key: string;
        price_cents: number;
        last_seen_at: number;
      }>()
  ).results;

const allListings = async () =>
  (
    await db
      .prepare(
        "SELECT source, listing_id, market_key, component_type, model_key, variant_key, title," +
          " price_cents, location_text, url, validity, content_hash, first_seen_at, last_seen_at" +
          " FROM listings ORDER BY listing_id",
      )
      .all<Record<string, string | number | null>>()
  ).results;

const allTasks = async () =>
  (
    await db
      .prepare("SELECT source, listing_id, status, created_at FROM evaluation_tasks ORDER BY listing_id")
      .all<{ source: string; listing_id: string; status: string; created_at: number }>()
  ).results;

/**
 * P1 -- agreement. For every group, model_stats.count and total_price_cents equal COUNT(*)
 * and SUM(price_cents) over price_observations, TREATING A MISSING ROW ON EITHER SIDE AS
 * (0, 0). Written this way the property is true at all times, including between a write-path
 * removal and the next sweep, when model_stats holds (0,0) and the GROUP BY holds nothing.
 * A naive equality form goes red on a correct implementation at exactly that moment -- and
 * the temptation would be to weaken the assertion.
 */
const p1Violations = async (): Promise<string[]> => {
  const stats = await allStats();
  const { results: actual } = await db
    .prepare(
      "SELECT market_key, model_key, variant_key, COUNT(*) AS c, SUM(price_cents) AS s" +
        " FROM price_observations GROUP BY market_key, model_key, variant_key",
    )
    .all<{ market_key: string; model_key: string; variant_key: string; c: number; s: number }>();

  const key = (row: { market_key: string; model_key: string; variant_key: string }) =>
    JSON.stringify([row.market_key, row.model_key, row.variant_key]);

  const expected = new Map<string, [number, number]>();
  for (const row of actual) expected.set(key(row), [row.c, row.s]);
  const held = new Map<string, [number, number]>();
  for (const row of stats) held.set(key(row), [row.count, row.total_price_cents]);

  const violations: string[] = [];
  for (const groupKey of new Set([...expected.keys(), ...held.keys()])) {
    const [expectedCount, expectedTotal] = expected.get(groupKey) ?? [0, 0];
    const [heldCount, heldTotal] = held.get(groupKey) ?? [0, 0];
    if (expectedCount !== heldCount || expectedTotal !== heldTotal) {
      violations.push(
        `${groupKey}: stats(${heldCount},${heldTotal}) != observations(${expectedCount},${expectedTotal})`,
      );
    }
  }
  return violations;
};

/**
 * P2 -- anchored outside the pair. Every listings row that contributes AND whose last_seen_at
 * is within the stale window must have a price_observations row.
 *
 * The CAST clause is required or P2 goes red on correct code: `contributes` demands
 * Number.isSafeInteger, so a listing with priceCents 50000.5 is correctly stored with no
 * observation, and SQLite keeps that value as `real`.
 *
 * Must be asserted with THAT STEP'S `now`: the window widens backwards as `now` shrinks, so a
 * listing whose observation cleanup legitimately deleted re-enters it.
 */
const p2Violations = async (now: number, staleAfterSeconds = STALE_AFTER_SECONDS) =>
  (
    await db
      .prepare(
        `SELECT l.listing_id FROM listings l
 WHERE l.validity = 'VALID'
   AND l.model_key IS NOT NULL
   AND l.price_cents IS NOT NULL
   AND l.price_cents > 0
   AND l.price_cents = CAST(l.price_cents AS INTEGER)
   AND l.last_seen_at >= ?1 - ?2
   AND NOT EXISTS (SELECT 1 FROM price_observations p
                    WHERE p.source = l.source AND p.listing_id = l.listing_id)`,
      )
      .bind(now, staleAfterSeconds)
      .all<{ listing_id: string }>()
  ).results.map((row) => row.listing_id);

// ---------------------------------------------------------------------------
// Test 1 -- first sighting.
// ---------------------------------------------------------------------------
describe("first sighting", () => {
  it("writes the listing, the observation, the aggregate and a PENDING task atomically", async () => {
    const report = await sight([valid({ listingId: "l1", priceCents: 50_000 })], T0);

    expect(report.results).toEqual([
      { listingId: "l1", outcome: "NEW", contribution: "recorded" },
    ]);

    const listings = await allListings();
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      source: SOURCE,
      listing_id: "l1",
      market_key: "43.4643,-80.5204|25km",
      component_type: "gpu",
      model_key: "RTX_4070_SUPER",
      variant_key: "", // the '' sentinel, never NULL
      price_cents: 50_000,
      validity: "VALID",
      first_seen_at: T0,
      last_seen_at: T0,
    });

    expect(await allObservations()).toEqual([
      {
        source: SOURCE,
        listing_id: "l1",
        market_key: "43.4643,-80.5204|25km",
        model_key: "RTX_4070_SUPER",
        variant_key: "",
        price_cents: 50_000,
        last_seen_at: T0,
      },
    ]);

    expect(await allStats()).toEqual([
      {
        market_key: "43.4643,-80.5204|25km",
        model_key: "RTX_4070_SUPER",
        variant_key: "",
        count: 1,
        total_price_cents: 50_000,
      },
    ]);

    expect(await allTasks()).toEqual([
      { source: SOURCE, listing_id: "l1", status: "PENDING", created_at: T0 },
    ]);

    expect(report.usage.rowsWritten).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2 -- unchanged duplicate sighting. THE REPRODUCTION-EQUIVALENT TEST.
// ---------------------------------------------------------------------------
describe("unchanged duplicate sighting", () => {
  it("never inflates count, and an identical re-sighting writes zero rows", async () => {
    const original = valid({ listingId: "l1", priceCents: 50_000 });
    const first = await sight([original], T0);
    expect(first.results[0].outcome).toBe("NEW");
    expect((await allStats())[0]).toMatchObject({ count: 1, total_price_cents: 50_000 });

    // Identical re-sighting, inside the heartbeat window, with a fresh provider timestamp.
    const second = await sight([seenAgain(original, "2026-09-20T00:30:00Z")], T0 + 60);
    expect(second.results).toEqual([
      { listingId: "l1", outcome: "UNCHANGED", contribution: "none" },
    ]);
    // The whole write-budget argument in one assertion: the heartbeat suppression lives in
    // the WHERE clause, so D1's own accounting shows zero rows written.
    expect(second.usage.rowsWritten).toBe(0);
    expect((await allStats())[0]).toMatchObject({ count: 1, total_price_cents: 50_000 });

    // A price change: count still 1, total replaced -- not added to.
    const third = await sight([valid({ listingId: "l1", priceCents: 45_000 })], T0 + 120);
    expect(third.results).toEqual([
      { listingId: "l1", outcome: "CHANGED", contribution: "recorded" },
    ]);
    expect((await allStats())[0]).toMatchObject({ count: 1, total_price_cents: 45_000 });

    expect(await p1Violations()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A listing id repeated inside ONE page. The classification read runs once, before the
// loop, so a second entry would otherwise be classified against pre-page state.
// ---------------------------------------------------------------------------
describe("a listing id repeated inside one page", () => {
  it("keeps the LAST entry and lets a non-contributing one remove the contribution", async () => {
    const report = await sight(
      [
        valid({ listingId: "l1", priceCents: 50_000 }),
        {
          listing: listing({ listingId: "l1", priceCents: 50_000 }),
          validity: "INVALID_REFERENCE",
        },
      ],
      T0,
    );

    // One result per distinct listing id, not per input entry.
    expect(report.results).toEqual([
      { listingId: "l1", outcome: "NEW", contribution: "skipped-invalid" },
    ]);

    // Without the de-duplication the removal path is gated on a stale read, so both of these
    // survive: the arithmetic statements are absent for the wrong reason.
    expect(await allObservations()).toEqual([]);
    expect(await allStats()).toEqual([]);

    // And the stored listings row must reflect the LAST entry, not the first.
    const listings = await allListings();
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({ listing_id: "l1", validity: "INVALID_REFERENCE" });
  });

  it("does the same when the later entry has a null price", async () => {
    await sight(
      [
        valid({ listingId: "l1", priceCents: 50_000 }),
        valid({ listingId: "l1", priceCents: null }),
      ],
      T0,
    );

    expect(await allObservations()).toEqual([]);
    expect(await allStats()).toEqual([]);
    expect((await allListings())[0]).toMatchObject({ listing_id: "l1", price_cents: null });
    expect(await p1Violations()).toEqual([]);
  });

  it("de-duplicates on the listing id even when the urls differ", async () => {
    // The identity is the listing id, NOT the url. One id legitimately arrives under several
    // urls -- a tracking parameter on the feed page, the canonical form on the detail page --
    // and keying the de-duplication on the url would let both entries through, putting the
    // first one's contribution into the aggregate while storing the second one's listing row.
    const report = await sight(
      [
        valid({
          listingId: "x1",
          priceCents: 50_000,
          url: "https://example.test/l/x1?ref=feed",
        }),
        {
          listing: listing({
            listingId: "x1",
            priceCents: 50_000,
            url: "https://example.test/l/x1",
          }),
          validity: "INVALID_REFERENCE",
        },
      ],
      T0,
    );

    expect(report.results).toEqual([
      { listingId: "x1", outcome: "NEW", contribution: "skipped-invalid" },
    ]);
    expect(await allObservations()).toEqual([]);
    expect(await allStats()).toEqual([]);
    // Last wins, so the stored row carries the canonical url, not the feed one.
    expect((await allListings())[0]).toMatchObject({
      listing_id: "x1",
      url: "https://example.test/l/x1",
      validity: "INVALID_REFERENCE",
    });
  });

  it("does not oscillate when the same page is replayed scan after scan", async () => {
    const page: Sighting[] = [
      valid({ listingId: "l1", priceCents: 50_000 }),
      {
        listing: listing({ listingId: "l1", priceCents: 50_000 }),
        validity: "INVALID_REFERENCE",
      },
    ];

    // Undeduplicated, this settles into a stable 2-cycle: validity, the observation and the
    // aggregate all flip every scan and never heal.
    for (let scan = 0; scan < 4; scan += 1) {
      await sight(page, T0 + scan * 60);
      expect(await allObservations(), `observations after scan ${scan}`).toEqual([]);
      expect(await allStats(), `stats after scan ${scan}`).toEqual([]);
      expect((await allListings())[0], `listing after scan ${scan}`).toMatchObject({
        validity: "INVALID_REFERENCE",
      });
      expect(await p1Violations()).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests 3 and 4 -- price increase and price decrease.
// Both use TWO listings in the group: with one, the named mutation trips
// CHECK (count >= 0) and rolls back, so the CHECK kills the mutant rather than the
// arithmetic -- and test 7's mutation removes that CHECK.
// ---------------------------------------------------------------------------
describe("price change with two listings in the group", () => {
  const seed = () =>
    sight(
      [
        valid({ listingId: "l1", priceCents: 100 }),
        valid({ listingId: "l2", priceCents: 200 }),
      ],
      T0,
    );

  it("price increase: count unchanged, total moves by the delta only", async () => {
    await seed();
    expect((await allStats())[0]).toMatchObject({ count: 2, total_price_cents: 300 });

    await sight([valid({ listingId: "l1", priceCents: 120 })], T0 + 60);

    expect((await allStats())[0]).toMatchObject({ count: 2, total_price_cents: 320 });
    expect(await p1Violations()).toEqual([]);
  });

  it("price decrease: count unchanged, total moves down and is never clamped", async () => {
    await seed();
    expect((await allStats())[0]).toMatchObject({ count: 2, total_price_cents: 300 });

    await sight([valid({ listingId: "l1", priceCents: 80 })], T0 + 60);

    expect((await allStats())[0]).toMatchObject({ count: 2, total_price_cents: 280 });
    expect(await p1Violations()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 7 -- transaction failure.
// ---------------------------------------------------------------------------
describe("transaction failure", () => {
  it("rolls the whole batch back, reports FAILED, and lets other listings succeed", async () => {
    await sight(
      [
        valid({ listingId: "l1", modelKey: "MODEL_ONE", priceCents: 100 }),
        valid({ listingId: "l2", modelKey: "MODEL_TWO", priceCents: 200 }),
      ],
      T0,
    );
    const hashBefore = (await allListings()).find((row) => row.listing_id === "l1")!.content_hash;

    // Corrupt MODEL_ONE's aggregate so the next SUBTRACT_OLD drives count below zero.
    // BOTH columns must be set: `SET count = 0` alone trips CHECK (count > 0 OR total = 0)
    // in the setup itself.
    await db
      .prepare("UPDATE model_stats SET count = 0, total_price_cents = 0 WHERE model_key = ?1")
      .bind("MODEL_ONE")
      .run();

    const report = await sight(
      [
        valid({ listingId: "l1", modelKey: "MODEL_ONE", priceCents: 140 }),
        valid({ listingId: "l2", modelKey: "MODEL_TWO", priceCents: 240 }),
      ],
      T0 + 60,
    );

    const failed = report.results.find((result) => result.listingId === "l1")!;
    expect(failed.outcome).toBe("FAILED");
    // The rollback comes from a model_stats CHECK: the three of them are what turn a broken
    // subtract/add pairing into a thrown, rolled-back batch rather than silent drift. They are
    // mutually reinforcing -- removing any ONE still leaves another to catch this corruption.
    expect(failed.error).toMatch(/CHECK constraint failed/);

    // The observation still holds the OLD price and the listing still holds the OLD hash:
    // nothing from the rolled-back batch landed, across tables.
    const observations = await allObservations();
    expect(observations.find((row) => row.listing_id === "l1")!.price_cents).toBe(100);
    const listings = await allListings();
    expect(listings.find((row) => row.listing_id === "l1")!.content_hash).toBe(hashBefore);
    expect(listings.find((row) => row.listing_id === "l1")!.price_cents).toBe(100);

    // One poisoned listing must never abort the scan.
    expect(report.results.find((result) => result.listingId === "l2")).toEqual({
      listingId: "l2",
      outcome: "CHANGED",
      contribution: "recorded",
    });
    expect(observations.find((row) => row.listing_id === "l2")!.price_cents).toBe(240);
  });
});

// ---------------------------------------------------------------------------
// The count CHECK. Kept here rather than in cleanupStaleObservations.test.ts because the
// seeding, p1Violations, allObservations and allStats all live in this file and that one has
// neither p1Violations nor allObservations -- the pin would cost more machinery than it is
// worth to move. The CHECK it defends guards the aggregate arithmetic BOTH writers share.
// ---------------------------------------------------------------------------
describe("the count CHECK", () => {
  it("CHECK (count >= 0) alone catches a corrupt aggregate when a whole group expires", async () => {
    // WHEN IS THIS CHECK THE ONLY ONE THAT FIRES? Any decrement leaves (c - d, T - S), where d
    // is the number of contributions removed and S is their total. For `count >= 0` to be the
    // one violated you need c - d < 0, T - S >= 0, and -- since c - d is not > 0 --
    // `count > 0 OR total = 0` forces T - S = 0. So the condition is exactly S = T and d > c:
    // the subtraction takes the whole stored total while removing more contributions than the
    // stored count admits.
    //
    // TWO statements decrement. SUBTRACT_OLD has d = 1, which forces c = 0, hence T = 0, hence
    // a single stored price of 0 -- a row no live path can write any more now that only
    // positive prices contribute. CLEAN_A has d = N over a whole expired group, and S = T holds
    // for free whenever that group expires entirely WITH ITS STORED TOTAL INTACT -- which is why
    // only the count is corrupted below, and why the closing assertion pins the total at 51,000.
    // So ANY understated count isolates the CHECK with no zero anywhere. This test uses that
    // family: it needs one corrupt column and no planted price, and it survives a future
    // `CHECK (price_cents > 0)` on price_observations that the SUBTRACT_OLD route would not.
    //
    // "WITH ITS STORED TOTAL INTACT" is load-bearing, and the `rejects.toThrow` below cannot
    // see it: corrupt the total as well -- say (1, 40_000) against observations summing 51,000
    // -- and CLEAN_A leaves (-1, -11_000), which violates `total_price_cents >= 0` TOO and
    // isolates nothing, yet SQLite reports the byte-identical message because it names the
    // FIRST-DECLARED CHECK. The word "alone" in this test's name is therefore carried by the
    // mutation that deletes `CHECK (count >= 0)` from 0001, and the total is held honest by the
    // closing assertion, not by the error string.
    //
    // Unreachable either way, and by the same fence: d > c means the aggregate's count
    // understates the observations in its own group, which is precisely what p1Violations
    // reports. The corruption below is asserted to be a P1 violation so that stays visible.
    await sight(
      [
        valid({ listingId: "c1", modelKey: "RTX_5080", priceCents: 31_000 }),
        valid({ listingId: "c2", modelKey: "RTX_5080", priceCents: 20_000 }),
      ],
      T0,
    );
    // ONE column, and the corrupt row is still legal on its own: (1, 51_000) satisfies all
    // three CHECKs, so nothing rejects the setup and the failure below is the arithmetic's.
    await db.prepare("UPDATE model_stats SET count = 1").run();
    expect(await p1Violations()).not.toEqual([]);

    // CLEAN_A: count = 1 - 2 = -1, total = 51_000 - 51_000 = 0. (-1, 0) passes
    // `total_price_cents >= 0` and passes `count > 0 OR total_price_cents = 0`.
    await expect(cleanupStaleObservations(db, { now: T0 + 8 * DAY })).rejects.toThrow(
      /CHECK constraint failed: count >= 0/,
    );

    // CLEAN_A and CLEAN_B are one batch, so the rollback keeps BOTH observations -- and the
    // unconditional CLEAN_SWEEP after the loop never runs, so the corrupt row is untouched too.
    expect((await allObservations()).map((row) => row.listing_id)).toEqual(["c1", "c2"]);
    expect(await allStats()).toEqual([
      {
        market_key: "43.4643,-80.5204|25km",
        model_key: "RTX_5080",
        variant_key: "",
        count: 1,
        total_price_cents: 51_000,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// An explicitly free listing. PLAN.md:52 prices it at 0; PLAN.md:59 admits only POSITIVE
// reference prices to the average. Stored and evaluated, but never in the benchmark.
// ---------------------------------------------------------------------------
describe("an explicitly free listing", () => {
  it("is stored and queued for evaluation but never enters the benchmark", async () => {
    // BOTH listings sit in the SAME group on purpose. An assertion that the aggregate agrees
    // with the observations is satisfied by BOTH SIDES BEING EMPTY, so the priced listing is
    // the named survivor: the aggregate has to be exactly its row, at exactly its price.
    const report = await sight(
      [
        valid({
          listingId: "paid",
          modelKey: "RX_7900_XTX",
          priceCents: 30_000,
          title: "rx 7900 xtx, boxed",
        }),
        valid({
          listingId: "free",
          modelKey: "RX_7900_XTX",
          priceCents: 0,
          title: "rx 7900 xtx, dead fan, free to a good home",
        }),
      ],
      T0,
    );

    // THE AGGREGATE IS ASSERTED BEFORE THE REPORT LABELS, and that order is deliberate:
    // assertions are sequential, so whichever comes first is the one a mutation actually dies
    // on. Reverting the gate to `>= 0` must be caught by the ARITHMETIC, not by a string.
    //
    // (1, 30_000), not (2, 30_000). The average the benchmark derives is 30_000, not 15_000 --
    // a 50% drop manufactured out of a listing that was never a price reference.
    expect(await allStats()).toEqual([
      {
        market_key: "43.4643,-80.5204|25km",
        model_key: "RX_7900_XTX",
        variant_key: "",
        count: 1,
        total_price_cents: 30_000,
      },
    ]);
    expect((await allObservations()).map((row) => row.listing_id)).toEqual(["paid"]);

    expect(report.results).toEqual([
      { listingId: "paid", outcome: "NEW", contribution: "recorded" },
      { listingId: "free", outcome: "NEW", contribution: "skipped-no-price" },
    ]);

    // STORED and EVALUATED. Only the contribution changes -- a free listing stays visible.
    expect((await allListings()).map((row) => row.listing_id)).toEqual(["free", "paid"]);
    expect((await allListings())[0]).toMatchObject({
      listing_id: "free",
      price_cents: 0,
      validity: "VALID",
      model_key: "RX_7900_XTX",
    });
    expect((await allTasks()).map((row) => row.listing_id)).toEqual(["free", "paid"]);

    expect(await p1Violations()).toEqual([]);
    expect(await p2Violations(T0)).toEqual([]);
  });

  it("removes the contribution when a price drops to free, settles, and restores above zero", async () => {
    // The zero boundary is exactly the shape of the oscillation the de-duplication comment
    // describes, so each state is replayed rather than merely reached.
    await sight(
      [
        valid({ listingId: "drops", modelKey: "RX_7900_XTX", priceCents: 31_000 }),
        valid({ listingId: "anchor", modelKey: "RX_7900_XTX", priceCents: 20_000 }),
      ],
      T0,
    );
    expect((await allStats())[0]).toMatchObject({ count: 2, total_price_cents: 51_000 });

    const dropped = await sight(
      [valid({ listingId: "drops", modelKey: "RX_7900_XTX", priceCents: 0 })],
      T0 + 60,
    );
    expect(dropped.results).toEqual([
      { listingId: "drops", outcome: "CHANGED", contribution: "removed" },
    ]);
    // The anchor survives at its own price: this is not "the group emptied".
    expect((await allStats())[0]).toMatchObject({ count: 1, total_price_cents: 20_000 });
    expect((await allObservations()).map((row) => row.listing_id)).toEqual(["anchor"]);

    // Free is a FIXED POINT, not a flip-flop: replaying it is UNCHANGED and writes zero rows.
    for (let scan = 0; scan < 3; scan += 1) {
      const replay = await sight(
        [
          seenAgain(
            valid({ listingId: "drops", modelKey: "RX_7900_XTX", priceCents: 0 }),
            `2026-09-2${scan + 1}T00:00:00Z`,
          ),
        ],
        T0 + 120 + scan * 60,
      );
      expect(replay.results, `replay ${scan}`).toEqual([
        { listingId: "drops", outcome: "UNCHANGED", contribution: "none" },
      ]);
      expect(replay.usage.rowsWritten, `replay ${scan}`).toBe(0);
      expect((await allStats())[0], `replay ${scan}`).toMatchObject({
        count: 1,
        total_price_cents: 20_000,
      });
    }

    // And back across the boundary: the contribution returns at the new price.
    const repriced = await sight(
      [valid({ listingId: "drops", modelKey: "RX_7900_XTX", priceCents: 25_000 })],
      T0 + 400,
    );
    expect(repriced.results).toEqual([
      { listingId: "drops", outcome: "CHANGED", contribution: "restored" },
    ]);
    expect((await allStats())[0]).toMatchObject({ count: 2, total_price_cents: 45_000 });
    expect(await p1Violations()).toEqual([]);
    expect(await p2Violations(T0 + 400)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 8 -- unknown model.
// ---------------------------------------------------------------------------
describe("unknown model", () => {
  it("stores the listing and queues a task, but contributes nothing", async () => {
    const report = await sight(
      [valid({ listingId: "l1", modelKey: null, priceCents: 50_000 })],
      T0,
    );

    expect(report.results).toEqual([
      { listingId: "l1", outcome: "NEW", contribution: "skipped-no-model" },
    ]);
    expect(await allListings()).toHaveLength(1);
    expect(await allObservations()).toEqual([]);
    expect(await allStats()).toEqual([]);
    expect(await allTasks()).toHaveLength(1);
  });

  it("stores the listing but contributes nothing when the price is missing", async () => {
    const report = await sight([valid({ listingId: "l2", priceCents: null })], T0);

    expect(report.results).toEqual([
      { listingId: "l2", outcome: "NEW", contribution: "skipped-no-price" },
    ]);
    expect(await allObservations()).toEqual([]);
    expect(await allStats()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 9 -- invalid reference.
// ---------------------------------------------------------------------------
describe("invalid reference", () => {
  it("stores a perfectly-priced INVALID_REFERENCE listing without contributing", async () => {
    const report = await recordSightings(db, {
      source: SOURCE,
      market: MARKET_A,
      now: T0,
      sightings: [
        { listing: listing({ listingId: "l1", priceCents: 50_000 }), validity: "INVALID_REFERENCE" },
      ],
    });

    expect(report.results).toEqual([
      { listingId: "l1", outcome: "NEW", contribution: "skipped-invalid" },
    ]);
    expect(await allListings()).toHaveLength(1);
    expect(await allObservations()).toEqual([]);
    expect(await allStats()).toEqual([]);
  });

  it("subtracts the contribution AND deletes the observation when 3B reclassifies it", async () => {
    await sight(
      [
        valid({ listingId: "l1", priceCents: 50_000 }),
        valid({ listingId: "l2", priceCents: 40_000 }),
      ],
      T0,
    );
    expect((await allStats())[0]).toMatchObject({ count: 2, total_price_cents: 90_000 });

    const report = await recordSightings(db, {
      source: SOURCE,
      market: MARKET_A,
      now: T0 + 60,
      sightings: [
        { listing: listing({ listingId: "l1", priceCents: 50_000 }), validity: "INVALID_REFERENCE" },
      ],
    });

    expect(report.results).toEqual([
      { listingId: "l1", outcome: "CHANGED", contribution: "removed" },
    ]);
    expect((await allStats())[0]).toMatchObject({ count: 1, total_price_cents: 40_000 });
    // The observation row must be gone, not merely uncounted: an orphan here makes the next
    // sighting fail and P1 red.
    expect((await allObservations()).map((row) => row.listing_id)).toEqual(["l2"]);
    expect(await p1Violations()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// When an evaluation task is queued: on NEW, and on any change where the CONTRIBUTION
// changed. PHASE_3's PRICE CHANGED block does not mention queuing; ARCHITECTURE.md section 8
// says "each new or RELEVANTLY changed listing" gets one, and a contribution change is
// unambiguously relevant to a deal verdict while a title typo is not.
// ---------------------------------------------------------------------------
describe("evaluation task queuing", () => {
  const taskFor = async (listingId: string) =>
    (await allTasks()).find((row) => row.listing_id === listingId)!;

  it("queues on NEW, skips a cosmetic change, and re-queues on a contribution change", async () => {
    await sight([valid({ listingId: "l1", priceCents: 50_000, title: "rtx 4070 super" })], T0);
    expect(await taskFor("l1")).toMatchObject({ status: "PENDING", created_at: T0 });

    // Stand in for 3D having consumed the task, so a re-queue is visible.
    await db.prepare("UPDATE evaluation_tasks SET status = 'DONE'").run();

    // A cosmetic change: the listing row is rewritten, the contribution is untouched, and
    // 3D is NOT asked to re-evaluate. Re-queuing here would burn 3D's budget on a title edit.
    const cosmetic = await sight(
      [valid({ listingId: "l1", priceCents: 50_000, title: "rtx 4070 super - price firm" })],
      T0 + 60,
    );
    expect(cosmetic.results[0].outcome).toBe("CHANGED");
    expect((await allListings())[0]).toMatchObject({ title: "rtx 4070 super - price firm" });
    expect(await taskFor("l1")).toMatchObject({ status: "DONE", created_at: T0 });

    // A price change moves the contribution, so 3D must look again -- never re-queuing here
    // would leave every deal verdict permanently stale.
    const priced = await sight(
      [valid({ listingId: "l1", priceCents: 45_000, title: "rtx 4070 super - price firm" })],
      T0 + 120,
    );
    expect(priced.results[0].contribution).toBe("recorded");
    expect(await taskFor("l1")).toMatchObject({ status: "PENDING", created_at: T0 + 120 });
  });
});

// ---------------------------------------------------------------------------
// Test 10 -- the same model in two different market_key values.
// ---------------------------------------------------------------------------
describe("same model in two markets", () => {
  it("keeps two separate aggregates that never mix", async () => {
    // TWO DISTINCT LISTINGS. Sighting the same listing under both markets would MOVE its one
    // observation, giving [{25km, 0}, {50km, 1}] rather than two rows of 1.
    await sight([valid({ listingId: "l1", priceCents: 50_000 })], T0, MARKET_A);
    await sight([valid({ listingId: "l2", priceCents: 60_000 })], T0, MARKET_B);

    expect(await allStats()).toEqual([
      {
        market_key: "43.4643,-80.5204|25km",
        model_key: "RTX_4070_SUPER",
        variant_key: "",
        count: 1,
        total_price_cents: 50_000,
      },
      {
        market_key: "43.4643,-80.5204|50km",
        model_key: "RTX_4070_SUPER",
        variant_key: "",
        count: 1,
        total_price_cents: 60_000,
      },
    ]);

    await sight([valid({ listingId: "l1", priceCents: 45_000 })], T0 + 60, MARKET_A);

    expect(await allStats()).toEqual([
      {
        market_key: "43.4643,-80.5204|25km",
        model_key: "RTX_4070_SUPER",
        variant_key: "",
        count: 1,
        total_price_cents: 45_000,
      },
      {
        market_key: "43.4643,-80.5204|50km",
        model_key: "RTX_4070_SUPER",
        variant_key: "",
        count: 1,
        total_price_cents: 60_000,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Test 11 -- cleaned, then re-sighted identically, restores the contribution.
// The permanent, unrecoverable failure mode this design exists to prevent.
// ---------------------------------------------------------------------------
describe("re-sighting after cleanup", () => {
  it("recreates the observation the hash alone would have skipped forever", async () => {
    const sighting = valid({ listingId: "l1", priceCents: 50_000 });

    await sight([sighting], T0);
    expect((await allStats())[0]).toMatchObject({ count: 1, total_price_cents: 50_000 });

    // A >7-day gap: a paused seller, a scroll out of the newest-15 window, or a monitor outage.
    const afterGap = T0 + 8 * DAY;
    await cleanupStaleObservations(db, { now: afterGap });
    expect(await allObservations()).toEqual([]);
    expect(await allStats()).toEqual([]);

    // The listing reappears with IDENTICAL content. The hash matches -- so a hash-only
    // UNCHANGED rule would take the heartbeat branch, whose UPDATE matches zero rows, and the
    // observation would never come back.
    const restored = await sight([seenAgain(sighting, "2026-09-28T00:00:00Z")], afterGap + 60);
    expect(restored.results).toEqual([
      { listingId: "l1", outcome: "CHANGED", contribution: "restored" },
    ]);
    expect(await allObservations()).toHaveLength(1);
    expect((await allStats())[0]).toMatchObject({ count: 1, total_price_cents: 50_000 });

    // And a third, immediate sighting is genuinely UNCHANGED again: the repair does not
    // become a permanent per-scan write.
    const steady = await sight([seenAgain(sighting, "2026-09-28T00:30:00Z")], afterGap + 120);
    expect(steady.results).toEqual([
      { listingId: "l1", outcome: "UNCHANGED", contribution: "none" },
    ]);
    expect(steady.usage.rowsWritten).toBe(0);
    expect(await p2Violations(afterGap + 120)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 13 -- consistency properties over a scripted sequence.
// ---------------------------------------------------------------------------
describe("consistency properties over a scripted sequence", () => {
  it("holds P1 and P2 after every step", async () => {
    const assertBoth = async (label: string, now: number) => {
      expect(await p1Violations(), `P1 after ${label}`).toEqual([]);
      expect(await p2Violations(now), `P2 after ${label}`).toEqual([]);
    };

    // 1 -- five NEW listings, all contributing, same model, same market.
    let now = T0;
    const prices = [10_000, 20_000, 30_000, 40_000, 50_000];
    const five = prices.map((priceCents, index) =>
      valid({ listingId: `p${index + 1}`, priceCents }),
    );
    await sight(five, now);
    expect((await allStats())[0]).toMatchObject({ count: 5, total_price_cents: 150_000 });
    await assertBoth("step 1 (five NEW)", now);

    // 2 -- sight all five again identically.
    now = T0 + 60;
    const duplicates = await sight(
      five.map((sighting) => seenAgain(sighting, "2026-09-20T00:30:00Z")),
      now,
    );
    expect(duplicates.results.every((result) => result.outcome === "UNCHANGED")).toBe(true);
    expect(duplicates.usage.rowsWritten).toBe(0);
    expect((await allStats())[0]).toMatchObject({ count: 5, total_price_cents: 150_000 });
    await assertBoth("step 2 (duplicates)", now);

    // 3 -- two price changes.
    now = T0 + 120;
    await sight(
      [valid({ listingId: "p1", priceCents: 11_000 }), valid({ listingId: "p2", priceCents: 19_000 })],
      now,
    );
    expect((await allStats())[0]).toMatchObject({ count: 5, total_price_cents: 150_000 });
    await assertBoth("step 3 (two price changes)", now);

    // 4a -- move p5 into market B, where it becomes the ONLY listing in its group.
    now = T0 + 180;
    await sight([valid({ listingId: "p5", priceCents: 50_000 })], now, MARKET_B);
    await assertBoth("step 4a (market move into B)", now);

    // 4b -- a market move OF THE ONLY LISTING IN ITS GROUP. This leaves market B's aggregate
    // row at (0,0): a write-path orphan the GROUPS query can never see, because GROUPS selects
    // FROM price_observations and that group no longer has any.
    now = T0 + 240;
    await sight([valid({ listingId: "p5", priceCents: 50_000 })], now, MARKET_C);
    const orphaned = (await allStats()).find(
      (row) => row.market_key === "43.4643,-80.5204|50km",
    );
    expect(orphaned).toMatchObject({ count: 0, total_price_cents: 0 });
    await assertBoth("step 4b (market move of the only listing in its group)", now);

    // 5 -- a validity flip to INVALID_REFERENCE.
    now = T0 + 300;
    await recordSightings(db, {
      source: SOURCE,
      market: MARKET_A,
      now,
      sightings: [
        { listing: listing({ listingId: "p4", priceCents: 40_000 }), validity: "INVALID_REFERENCE" },
      ],
    });
    expect((await allObservations()).map((row) => row.listing_id)).toEqual([
      "p1",
      "p2",
      "p3",
      "p5",
    ]);
    await assertBoth("step 5 (validity flip)", now);

    // 6 -- advance past the stale window and run cleanup.
    now = T0 + STALE_AFTER_SECONDS + DAY;
    const firstCleanup = await cleanupStaleObservations(db, { now });
    expect(firstCleanup.observationsDeleted).toBe(4);
    expect(await allObservations()).toEqual([]);
    // The sweep is the ONLY thing that removes a fully-expired group's aggregate row.
    const zeroRows = await db
      .prepare("SELECT COUNT(*) AS c FROM model_stats WHERE count = 0")
      .first<{ c: number }>();
    expect(zeroRows!.c).toBe(0);
    expect(await allStats()).toEqual([]);
    await assertBoth("step 6 (cleanup)", now);

    // 7 -- replayed cleanup. Must neither throw nor change anything.
    const replay = await cleanupStaleObservations(db, { now });
    expect(replay.groups).toBe(0);
    expect(replay.observationsDeleted).toBe(0);
    expect(await allStats()).toEqual([]);
    await assertBoth("step 7 (replayed cleanup)", now);

    // 8 -- SIGHT ALL FIVE AGAIN, IDENTICALLY. Required: without a sighting AFTER the cleanup,
    // no listing is ever inside the stale window with a missing observation, so P2's
    // precondition is never met and the assertion cannot fail on any input.
    now = T0 + STALE_AFTER_SECONDS + DAY + 60;
    await sight(
      [
        valid({ listingId: "p1", priceCents: 11_000 }),
        valid({ listingId: "p2", priceCents: 19_000 }),
        valid({ listingId: "p3", priceCents: 30_000 }),
      ],
      now,
    );
    await recordSightings(db, {
      source: SOURCE,
      market: MARKET_A,
      now,
      sightings: [
        { listing: listing({ listingId: "p4", priceCents: 40_000 }), validity: "INVALID_REFERENCE" },
      ],
    });
    await sight([valid({ listingId: "p5", priceCents: 50_000 })], now, MARKET_C);

    expect((await allObservations()).map((row) => row.listing_id)).toEqual([
      "p1",
      "p2",
      "p3",
      "p5",
    ]);
    await assertBoth("step 8 (re-sighted after cleanup)", now);
  });
});
