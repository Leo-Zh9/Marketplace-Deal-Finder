// @vitest-environment node

/**
 * Real D1, one mechanism: createTestDatabase() / truncateAll() from worker/testing/d1.ts.
 * Fixtures are built through recordSightings and cleanupStaleObservations wherever the scenario
 * is reachable that way, so the tests exercise real stored state rather than hand-written rows.
 *
 * THE ONE FIXTURE RULE THAT EARNED ITS PLACE: an ordering, priority or fencing claim is NOT
 * tested by a fixture. It is tested by a fixture that is CLAIMED, COMPLETED, AND CLAIMED AGAIN.
 * Three defects in this design passed a single call against a fresh fixture and were obvious on
 * the second. E13 drives five calls and E14 four; do not reduce them.
 */

import { cleanupStaleObservations } from "../storage/cleanupStaleObservations";
import { marketKey } from "../storage/marketKey";
import type { Market } from "../storage/marketKey";
import { recordSightings } from "../storage/recordSightings";
import type { Listing, Sighting } from "../storage/types";
import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";
import {
  claimEvaluationTasks,
  completionStatement,
  evaluateBatch,
  CLAIM_EXPIRED,
  CLAIM_NEEDS_REVIEW,
  CLAIM_PENDING,
  CLAIM_STALE_REVISION,
} from "./evaluateBatch";
import type { EvaluationOutcome, EvaluationSettings } from "./types";

/**
 * E20 needs `decide` to throw for exactly one candidate. The wrapper delegates to the real
 * implementation unless the test arms it, so every other test in this file still runs the
 * production function and still carries any mutation applied to it.
 */
const stub = vi.hoisted(() => ({ throwForPriceCents: null as number | null }));

vi.mock("./dealRules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dealRules")>();
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

const SOURCE = "test-provider";
const OTHER_SOURCE = "other-provider";
const T0 = 1_760_000_000;
const DAY = 24 * 60 * 60;

const MARKET_A: Market = { latitude: 43.4643, longitude: -80.5204, radiusKm: 25 };
const MARKET_B: Market = { latitude: 43.4643, longitude: -80.5204, radiusKm: 50 };
const MARKET_A_KEY = marketKey(MARKET_A);

const MODEL = "RTX_4070_SUPER";

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
  stub.throwForPriceCents = null;
  await truncateAll(db);
});

const listing = (overrides: Partial<Listing> & { listingId: string }): Listing => ({
  componentType: "gpu",
  modelKey: MODEL,
  variantKey: null,
  title: "RTX 4070 Super, barely used",
  priceCents: 50_000,
  locationText: "Waterloo, ON",
  // DELIBERATELY NOT DERIVED FROM listingId, for the reason 3C's fixture gives: url and
  // listingId are independent fields and url is inside the content hash.
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

const discount = (percent: number, searchRevision = 1): EvaluationSettings => ({
  mode: "DISCOUNT",
  minimumDiscountPercent: percent,
  maximumPriceCents: null,
  searchRevision,
});

const maximum = (cents: number, searchRevision = 1): EvaluationSettings => ({
  mode: "MAXIMUM_PRICE",
  minimumDiscountPercent: null,
  maximumPriceCents: cents,
  searchRevision,
});

interface TaskRow {
  source: string;
  listing_id: string;
  status: string;
  created_at: number;
  evaluated_revision: number | null;
  verdict: string | null;
  evaluated_at: number | null;
  lease_expires_at: number;
  lease_token: string;
}

const taskRow = async (listingId: string, source = SOURCE): Promise<TaskRow | null> =>
  db
    .prepare("SELECT * FROM evaluation_tasks WHERE source = ?1 AND listing_id = ?2")
    .bind(source, listingId)
    .first<TaskRow>();

const allStats = async () =>
  (
    await db
      .prepare(
        "SELECT market_key, model_key, variant_key, count, total_price_cents FROM model_stats" +
          " ORDER BY market_key, model_key, variant_key",
      )
      .all<{
        market_key: string;
        model_key: string;
        variant_key: string;
        count: number;
        total_price_cents: number;
      }>()
  ).results;

const outcomeFor = (outcomes: EvaluationOutcome[], listingId: string): EvaluationOutcome => {
  const found = outcomes.find((outcome) => outcome.listingId === listingId);
  if (found === undefined) {
    throw new Error(`no outcome for ${listingId}: ${JSON.stringify(outcomes.map((o) => o.listingId))}`);
  }
  return found;
};

const LISTING_SQL = `INSERT INTO listings
       (source, listing_id, market_key, component_type, model_key, variant_key, title,
        price_cents, location_text, url, validity, content_hash, first_seen_at, last_seen_at)
VALUES (?1,?2,?3,'gpu',?4,?5,'direct fixture',?6,'Waterloo, ON','https://example.test/x',?7,?8,?9,?9)`;

/** A listings row written directly. Used only where recordSightings cannot reach the state. */
const insertListing = (args: {
  listingId: string;
  priceCents: number | null;
  validity: string;
  modelKey?: string | null;
  variantKey?: string;
  marketKeyValue?: string;
  source?: string;
}): D1PreparedStatement =>
  db
    .prepare(LISTING_SQL)
    .bind(
      args.source ?? SOURCE,
      args.listingId,
      args.marketKeyValue ?? MARKET_A_KEY,
      args.modelKey === undefined ? MODEL : args.modelKey,
      args.variantKey ?? "",
      args.priceCents,
      args.validity,
      `hash-${args.listingId}`,
      T0,
    );

const TASK_SQL = `INSERT INTO evaluation_tasks
       (source, listing_id, status, created_at, evaluated_revision, verdict, evaluated_at,
        lease_expires_at, lease_token)
VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`;

/** An evaluation_tasks row written directly, including the 3D columns. */
const insertTask = (args: {
  listingId: string;
  status: string;
  createdAt?: number;
  evaluatedRevision?: number | null;
  verdict?: string | null;
  evaluatedAt?: number | null;
  leaseExpiresAt?: number;
  leaseToken?: string;
  source?: string;
}): D1PreparedStatement =>
  db
    .prepare(TASK_SQL)
    .bind(
      args.source ?? SOURCE,
      args.listingId,
      args.status,
      args.createdAt ?? T0,
      args.evaluatedRevision ?? null,
      args.verdict ?? null,
      args.evaluatedAt ?? null,
      args.leaseExpiresAt ?? 0,
      args.leaseToken ?? "",
    );

/**
 * THE MARKET FIXTURE. Six DISTINCT prices, because with equal prices `T - q` is identical for
 * every `q` and the exclusion is untestable.
 */
const SIX_PRICES = [20_000, 21_000, 22_000, 23_000, 24_000, 25_000];
const SIX_TOTAL = 135_000; // 6 rows
const WITHOUT_L0_TOTAL = 115_000; // 5 rows, l-0's 20000 excluded

const sixContributors = async (now = T0) =>
  sight(
    SIX_PRICES.map((priceCents, index) => valid({ listingId: `l-${index}`, priceCents })),
    now,
  );

describe("evaluateBatch -- candidate exclusion", () => {
  // E1. GATE: running averages match expected test values.
  it("E1: excludes the candidate's own contribution from its benchmark", async () => {
    await sixContributors();

    expect(await allStats()).toEqual([
      {
        market_key: MARKET_A_KEY,
        model_key: MODEL,
        variant_key: "",
        count: 6,
        total_price_cents: SIX_TOTAL,
      },
    ]);

    const report = await evaluateBatch(db, {
      source: SOURCE,
      settings: discount(20),
      now: T0,
      leaseToken: "token-e1",
    });

    // Integer literals written here, never re-derived from the row under test.
    expect(outcomeFor(report.outcomes, "l-0")).toMatchObject({
      candidatePriceCents: 20_000,
      referenceCount: 5,
      referenceTotalCents: WITHOUT_L0_TOTAL,
      referenceAverageCents: 23_000,
    });
  });

  // E2. GATE: candidate exclusion is mathematically correct.
  //
  // The two candidates share market, model and variant and differ in validity AND price, so
  // "subtracted when it shouldn't" and "subtracted the wrong amount" fail separately.
  it("E2: subtracts nothing for a candidate that never contributed", async () => {
    await sixContributors();
    await sight(
      [{ listing: listing({ listingId: "inv-0", priceCents: 99_000 }), validity: "INVALID_REFERENCE" }],
      T0,
    );

    // The INVALID_REFERENCE listing wrote no observation, so the aggregate is untouched.
    expect((await allStats())[0]).toMatchObject({ count: 6, total_price_cents: SIX_TOTAL });

    const report = await evaluateBatch(db, {
      source: SOURCE,
      settings: discount(20),
      now: T0,
      leaseToken: "token-e2",
    });

    expect(outcomeFor(report.outcomes, "inv-0")).toMatchObject({
      referenceCount: 6,
      referenceTotalCents: SIX_TOTAL,
    });
    expect(outcomeFor(report.outcomes, "l-0")).toMatchObject({
      referenceCount: 5,
      referenceTotalCents: WITHOUT_L0_TOTAL,
    });
  });

  // E3. THE TEST THAT PINS DECISION 1. cleanupStaleObservations subtracts and deletes the
  // observation but LEAVES THE listings ROW INTACT, price, model and validity and all. Any rule
  // reconstructed from the listing row would subtract a price that is no longer in the aggregate
  // and corrupt the benchmark for every other listing in the market.
  it("E3: subtracts nothing once the candidate's observation has been cleaned away", async () => {
    await sixContributors(T0);

    // Only the other five are seen again, so only l-0's observation goes stale.
    const later = T0 + 8 * DAY;
    await sight(
      SIX_PRICES.slice(1).map((priceCents, index) =>
        valid({ listingId: `l-${index + 1}`, priceCents }),
      ),
      later,
    );
    await cleanupStaleObservations(db, { now: later });

    expect((await allStats())[0]).toMatchObject({ count: 5, total_price_cents: WITHOUT_L0_TOTAL });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM price_observations WHERE listing_id = 'l-0'")
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });

    const report = await evaluateBatch(db, {
      source: SOURCE,
      settings: discount(20),
      now: later,
      leaseToken: "token-e3",
    });

    // 5 / 115000 -- the aggregate as it stands, with NOTHING subtracted.
    expect(outcomeFor(report.outcomes, "l-0")).toMatchObject({
      candidatePriceCents: 20_000,
      referenceCount: 5,
      referenceTotalCents: WITHOUT_L0_TOTAL,
    });
  });

  // E4. THIS STATE IS UNREACHABLE THROUGH recordSightings, which writes UPSERT_OBS and
  // UPSERT_LISTING in one batch from the same values. It exists because a fixture in which the
  // two prices agree CANNOT TELL WHICH COLUMN THE CODE READS: candidate_price_cents must come
  // from `listings` (the asking price being judged) and the subtraction must use
  // `price_observations` (the amount that is actually inside the aggregate).
  it("E4: judges the listing's price and subtracts the observation's price", async () => {
    await db.batch([
      insertListing({ listingId: "split", priceCents: 30_000, validity: "VALID" }),
      db
        .prepare(
          `INSERT INTO price_observations
                  (source, listing_id, market_key, model_key, variant_key, price_cents, last_seen_at)
           VALUES (?1, 'split', ?2, ?3, '', 20000, ?4)`,
        )
        .bind(SOURCE, MARKET_A_KEY, MODEL, T0),
      db
        .prepare(
          `INSERT INTO model_stats (market_key, model_key, variant_key, count, total_price_cents)
           VALUES (?1, ?2, '', 6, ?3)`,
        )
        .bind(MARKET_A_KEY, MODEL, SIX_TOTAL),
      insertTask({ listingId: "split", status: "PENDING" }),
    ]);

    const report = await evaluateBatch(db, {
      source: SOURCE,
      settings: discount(20),
      now: T0,
      leaseToken: "token-e4",
    });

    expect(outcomeFor(report.outcomes, "split")).toMatchObject({
      candidatePriceCents: 30_000, // l.price_cents, NOT p.price_cents
      referenceCount: 5,
      referenceTotalCents: WITHOUT_L0_TOTAL, // 135000 - 20000, NOT 135000 - 30000
    });
  });
});

describe("evaluateBatch -- aggregates never mix", () => {
  /**
   * BOTH candidates are asserted, on purpose. Dropping a join key makes the candidate read
   * return two rows per listing and the map keeps whichever arrives last -- so asserting only
   * one candidate would pass or fail on join order. With both asserted, one of them is wrong
   * whichever row wins.
   */
  const twoGroupFixture = async (build: (suffix: string, prices: number[]) => Promise<void>) => {
    await build("hi", [20_000, 30_000, 31_000, 32_000, 33_000, 34_000]);
    await build("lo", [20_500, 20_100, 20_200, 20_300, 20_400, 20_600]);
  };

  // E5. Two market_keys (radius 25 and 50), same model and variant, chosen so the VERDICT differs.
  it("E5: reads only its own market's aggregate", async () => {
    await twoGroupFixture(async (suffix, prices) => {
      await sight(
        prices.map((priceCents, index) => valid({ listingId: `${suffix}-${index}`, priceCents })),
        T0,
        suffix === "hi" ? MARKET_A : MARKET_B,
      );
    });

    const report = await evaluateBatch(db, {
      source: SOURCE,
      settings: discount(20),
      now: T0,
      batchSize: 15,
      leaseToken: "token-e5",
    });

    // hi-0 at 20000 against 5 / 160000 (average 32000): 20000*5*10000 <= 160000*8000 -> DEAL
    expect(outcomeFor(report.outcomes, "hi-0")).toMatchObject({
      verdict: "DEAL",
      referenceCount: 5,
      referenceTotalCents: 160_000,
      referenceAverageCents: 32_000,
    });
    // lo-0 at 20500 against 5 / 101600 (average 20320): 20500*5*10000 > 101600*8000 -> NOT_DEAL
    expect(outcomeFor(report.outcomes, "lo-0")).toMatchObject({
      verdict: "NOT_DEAL",
      referenceCount: 5,
      referenceTotalCents: 101_600,
      referenceAverageCents: 20_320,
    });
  });

  // E6. Same market and model, variants '' and '16GB'. The '' sentinel is never the only value
  // the code could be keying on.
  it("E6: reads only its own variant's aggregate", async () => {
    await twoGroupFixture(async (suffix, prices) => {
      await sight(
        prices.map((priceCents, index) =>
          valid({
            listingId: `${suffix}-${index}`,
            priceCents,
            variantKey: suffix === "hi" ? null : "16GB",
          }),
        ),
        T0,
      );
    });

    const report = await evaluateBatch(db, {
      source: SOURCE,
      settings: discount(20),
      now: T0,
      batchSize: 15,
      leaseToken: "token-e6",
    });

    expect(outcomeFor(report.outcomes, "hi-0")).toMatchObject({
      verdict: "DEAL",
      referenceCount: 5,
      referenceTotalCents: 160_000,
    });
    expect(outcomeFor(report.outcomes, "lo-0")).toMatchObject({
      verdict: "NOT_DEAL",
      referenceCount: 5,
      referenceTotalCents: 101_600,
    });
  });
});

describe("evaluateBatch -- the verdict and the stored status", () => {
  // E7. GATE: maximum-price mode works without market data.
  //
  // The state is reached with real 3C code: the only observation expires, CLEAN_A drives the
  // aggregate to 0/0 and CLEAN_SWEEP deletes it, so there is NO model_stats ROW AT ALL -- the
  // LEFT JOIN yields NULL / NULL, not zero.
  it("E7: decides in maximum-price mode with no model_stats row at all", async () => {
    await sight([valid({ listingId: "solo", priceCents: 15_000 })], T0);
    const later = T0 + 8 * DAY;
    await cleanupStaleObservations(db, { now: later });
    expect(await allStats()).toEqual([]);

    const report = await evaluateBatch(db, {
      source: SOURCE,
      settings: maximum(20_000),
      now: later,
      leaseToken: "token-e7",
    });

    expect(outcomeFor(report.outcomes, "solo")).toMatchObject({
      verdict: "DEAL",
      reason: "within-maximum",
      status: "COMPLETE",
      referenceCount: null,
      referenceTotalCents: null,
      referenceAverageCents: null,
    });
    expect(await taskRow("solo")).toMatchObject({ status: "COMPLETE", verdict: "DEAL" });
  });

  // E8. GATE: insufficient evidence stays pending. Five contributors means every candidate sees
  // a reference count of four.
  //
  // THE SECOND CALL IS THE TEST. `status='NEEDS_REVIEW'` means "3D will try again", and a fixture
  // that is claimed once cannot tell that apart from `COMPLETE`.
  it("E8: parks insufficient evidence at NEEDS_REVIEW and re-claims it next call", async () => {
    await sight(
      [20_000, 21_000, 22_000, 23_000, 24_000].map((priceCents, index) =>
        valid({ listingId: `few-${index}`, priceCents }),
      ),
      T0,
    );

    const first = await evaluateBatch(db, {
      source: SOURCE,
      settings: discount(20),
      now: T0,
      leaseToken: "token-e8a",
    });

    expect(outcomeFor(first.outcomes, "few-0")).toMatchObject({
      verdict: "NEEDS_REVIEW",
      reason: "insufficient-evidence",
      status: "NEEDS_REVIEW",
      referenceCount: 4,
    });
    expect(await taskRow("few-0")).toMatchObject({
      status: "NEEDS_REVIEW",
      verdict: "NEEDS_REVIEW",
      evaluated_revision: 1,
      evaluated_at: T0,
    });

    const second = await evaluateBatch(db, {
      source: SOURCE,
      settings: discount(20),
      now: T0 + 60,
      leaseToken: "token-e8b",
    });
    expect(second.outcomes.map((outcome) => outcome.listingId).sort()).toEqual([
      "few-0",
      "few-1",
      "few-2",
      "few-3",
      "few-4",
    ]);
  });
});

describe("evaluateBatch -- search revisions", () => {
  // E9. GATE: search revisions trigger reevaluation. The spec's own example, in cents.
  it("E9: re-opens an unchanged listing when the revision changes, and only then", async () => {
    await sight([valid({ listingId: "l-250", priceCents: 25_000 })], T0);

    const first = await evaluateBatch(db, {
      source: SOURCE,
      settings: maximum(20_000, 1),
      now: T0,
      leaseToken: "token-e9a",
    });
    expect(outcomeFor(first.outcomes, "l-250")).toMatchObject({
      verdict: "NOT_DEAL",
      reason: "above-maximum-price",
      status: "COMPLETE",
    });
    expect(await taskRow("l-250")).toMatchObject({
      status: "COMPLETE",
      verdict: "NOT_DEAL",
      evaluated_revision: 1,
    });

    // Same revision: nothing is eligible. No tier may re-open a task on its own.
    const again = await evaluateBatch(db, {
      source: SOURCE,
      settings: maximum(20_000, 1),
      now: T0 + 60,
      leaseToken: "token-e9b",
    });
    expect(again.claimed).toBe(0);
    expect(again.outcomes).toEqual([]);

    // Revision 2, maximum $300: the SAME unchanged listing must be reconsidered.
    const bumped = await evaluateBatch(db, {
      source: SOURCE,
      settings: maximum(30_000, 2),
      now: T0 + 120,
      leaseToken: "token-e9c",
    });
    expect(outcomeFor(bumped.outcomes, "l-250")).toMatchObject({
      verdict: "DEAL",
      reason: "within-maximum",
    });
    expect(await taskRow("l-250")).toMatchObject({ verdict: "DEAL", evaluated_revision: 2 });
  });

  // E10. A REVISION BUMP WRITES NOTHING. Eligibility is tier 4's read-time predicate, so the
  // previous verdict and revision are still on the row while it is being re-evaluated -- which
  // is what "previously successful notification identities remain preserved" rests on. A
  // bump-time `UPDATE ... SET status='PENDING', verdict=NULL, evaluated_revision=NULL` would be a
  // write proportional to the whole corpus that destroys exactly that state.
  it("E10: preserves the prior verdict and created_at while re-evaluating", async () => {
    await sight([valid({ listingId: "l-250", priceCents: 25_000 })], T0);
    await evaluateBatch(db, {
      source: SOURCE,
      settings: maximum(20_000, 1),
      now: T0,
      leaseToken: "token-e10a",
    });
    const before = await taskRow("l-250");

    const claim = await claimEvaluationTasks(db, {
      source: SOURCE,
      batchSize: 15,
      now: T0 + 60,
      leaseSeconds: 300,
      leaseToken: "token-e10b",
      searchRevision: 2,
    });
    expect(claim.tasks).toEqual([{ listingId: "l-250" }]);

    expect(await taskRow("l-250")).toMatchObject({
      status: "PROCESSING",
      verdict: "NOT_DEAL",
      evaluated_revision: 1,
      created_at: before!.created_at,
    });
  });

  // E11. The state ALTER TABLE leaves on every task a database that already ran 3C holds.
  it("E11: claims a NULL evaluated_revision exactly once and stamps it", async () => {
    await db.batch([
      insertListing({ listingId: "legacy", priceCents: 25_000, validity: "INVALID_REFERENCE" }),
      insertTask({ listingId: "legacy", status: "COMPLETE", evaluatedRevision: null }),
    ]);

    const first = await evaluateBatch(db, {
      source: SOURCE,
      settings: maximum(20_000, 1),
      now: T0,
      leaseToken: "token-e11a",
    });
    expect(first.claimed).toBe(1);
    expect(await taskRow("legacy")).toMatchObject({ status: "COMPLETE", evaluated_revision: 1 });

    const second = await evaluateBatch(db, {
      source: SOURCE,
      settings: maximum(20_000, 1),
      now: T0 + 60,
      leaseToken: "token-e11b",
    });
    expect(second.claimed).toBe(0);
  });

  // E12. A restore from backup lowers the current revision. `>` is what re-opens those tasks;
  // `<` alone would leave them stamped from the future and never re-examined.
  it("E12: claims a task stamped with a HIGHER revision than the current one", async () => {
    await db.batch([
      insertListing({ listingId: "rolled-back", priceCents: 25_000, validity: "INVALID_REFERENCE" }),
      insertTask({ listingId: "rolled-back", status: "COMPLETE", evaluatedRevision: 9 }),
    ]);

    const report = await evaluateBatch(db, {
      source: SOURCE,
      settings: maximum(20_000, 8),
      now: T0,
      leaseToken: "token-e12",
    });

    expect(report.claimed).toBe(1);
    expect(await taskRow("rolled-back")).toMatchObject({ evaluated_revision: 8 });
  });
});

describe("evaluateBatch -- claim tier order and rotation", () => {
  /**
   * E13's fixture. The 30 stale-revision COMPLETE rows are LOAD-BEARING: without them both the
   * right and the wrong tier order pass.
   *
   * - 2 fresh PENDING (pf-0, pf-1), terminal when evaluated
   * - 30 stale-revision COMPLETE (cm-00..cm-29), terminal when evaluated, created OLDEST
   * - 40 NEEDS_REVIEW (nr-00..nr-39), every one resolving to insufficient-evidence AGAIN
   */
  const CURRENT_REVISION = 2;

  const tierFixture = async () => {
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < 2; index += 1) {
      const id = `pf-${index}`;
      statements.push(
        insertListing({ listingId: id, priceCents: 25_000, validity: "INVALID_REFERENCE" }),
        insertTask({ listingId: id, status: "PENDING", createdAt: T0 + 100 }),
      );
    }
    for (let index = 0; index < 30; index += 1) {
      const id = `cm-${String(index).padStart(2, "0")}`;
      statements.push(
        insertListing({ listingId: id, priceCents: 25_000, validity: "INVALID_REFERENCE" }),
        insertTask({
          listingId: id,
          status: "COMPLETE",
          createdAt: T0, // older than everything else
          evaluatedRevision: 1, // stale against CURRENT_REVISION
          verdict: "NOT_DEAL",
          evaluatedAt: T0,
        }),
      );
    }
    for (let index = 0; index < 40; index += 1) {
      const id = `nr-${String(index).padStart(2, "0")}`;
      // VALID with a model but no model_stats row anywhere -> NULL / NULL -> insufficient-evidence
      statements.push(
        insertListing({ listingId: id, priceCents: 25_000, validity: "VALID" }),
        insertTask({
          listingId: id,
          status: "NEEDS_REVIEW",
          createdAt: T0 + 50,
          evaluatedRevision: CURRENT_REVISION,
          verdict: "NEEDS_REVIEW",
          evaluatedAt: T0 + 50,
        }),
      );
    }
    await db.batch(statements);
  };

  const staleRemaining = async () =>
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM evaluation_tasks WHERE status='COMPLETE' AND" +
            " (evaluated_revision IS NULL OR evaluated_revision <> ?1)",
        )
        .bind(CURRENT_REVISION)
        .first<{ n: number }>()
    )!.n;

  // E13. FIVE REAL CALLS, claim -> complete -> repeat. Tier 3 is unbounded and perpetual; tier 4
  // is finite. Running tier 3 first hands it the whole budget forever and the stale set is NEVER
  // CLAIMED AT ALL -- measured stationary over five calls -- which silently disables the only
  // recovery path this design has for a bad verdict.
  it("E13: drains finite revision work before infinite evidence work", async () => {
    await tierFixture();

    const claimedPerCall: string[][] = [];
    for (let call = 0; call < 5; call += 1) {
      const report = await evaluateBatch(db, {
        source: SOURCE,
        settings: discount(20, CURRENT_REVISION),
        now: T0 + 1000 + call * 60,
        batchSize: 15,
        leaseToken: `token-e13-${call}`,
      });
      claimedPerCall.push(report.outcomes.map((outcome) => outcome.listingId));
      if (call === 2) {
        // All 30 stale-revision tasks are claimed and stamped within the first three calls.
        expect(await staleRemaining()).toBe(0);
      }
    }

    expect(await staleRemaining()).toBe(0);

    const staleClaimedEarly = claimedPerCall
      .slice(0, 3)
      .flat()
      .filter((id) => id.startsWith("cm-"));
    expect(staleClaimedEarly.sort()).toEqual(
      Array.from({ length: 30 }, (_, index) => `cm-${String(index).padStart(2, "0")}`),
    );
  });

  // E13, single-call shape at batch 3: tier 1 first, then tier 4 -- never tier 3.
  it("E13: at batch 3 claims both PENDING and one stale-revision task", async () => {
    await tierFixture();

    const claim = await claimEvaluationTasks(db, {
      source: SOURCE,
      batchSize: 3,
      now: T0 + 1000,
      leaseSeconds: 300,
      leaseToken: "token-e13-b3",
      searchRevision: CURRENT_REVISION,
    });

    expect(claim.tasks.map((task) => task.listingId).sort()).toEqual(["cm-00", "pf-0", "pf-1"]);
  });

  // E13, single-call shape at batch 45: every PENDING, every stale task, and only then evidence.
  it("E13: at batch 45 claims 2 PENDING + 30 stale + 13 NEEDS_REVIEW", async () => {
    await tierFixture();

    const claim = await claimEvaluationTasks(db, {
      source: SOURCE,
      batchSize: 45,
      now: T0 + 1000,
      leaseSeconds: 300,
      leaseToken: "token-e13-b45",
      searchRevision: CURRENT_REVISION,
    });

    const ids = claim.tasks.map((task) => task.listingId);
    expect(ids).toHaveLength(45);
    expect(ids.filter((id) => id.startsWith("pf-"))).toHaveLength(2);
    expect(ids.filter((id) => id.startsWith("cm-"))).toHaveLength(30);
    expect(ids.filter((id) => id.startsWith("nr-"))).toHaveLength(13);
  });

  // E14. FOUR REAL CALLS. Nothing ever advances created_at for a task that stays in the
  // NEEDS_REVIEW queue, so ORDER BY created_at returns THE SAME 15 ROWS ON EVERY CALL, forever,
  // while the other 25 are never re-examined. A rare model with 1-4 comparables never resolves,
  // so those 15 are permanent occupants -- and cold start makes every listing
  // insufficient-evidence, so this is the FIRST state the system reaches.
  it("E14: rotates the NEEDS_REVIEW queue so every task is re-examined", async () => {
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < 40; index += 1) {
      const id = `nr-${String(index).padStart(2, "0")}`;
      statements.push(
        insertListing({ listingId: id, priceCents: 25_000, validity: "VALID" }),
        insertTask({
          listingId: id,
          status: "NEEDS_REVIEW",
          createdAt: T0, // IDENTICAL for all 40: created_at is a fixed point by construction
          evaluatedRevision: 1,
          verdict: "NEEDS_REVIEW",
          evaluatedAt: T0 - 1000,
        }),
      );
    }
    await db.batch(statements);

    const perCall: string[][] = [];
    for (let call = 0; call < 4; call += 1) {
      const report = await evaluateBatch(db, {
        source: SOURCE,
        settings: discount(20, 1),
        // A REAL CALLER ADVANCES THE CLOCK. At a frozen `now` a completion writes the same
        // evaluated_at it just ordered by, so a tie group can recur.
        now: T0 + call * 60,
        batchSize: 15,
        leaseToken: `token-e14-${call}`,
      });
      expect(report.outcomes).toHaveLength(15);
      expect(report.outcomes.every((outcome) => outcome.reason === "insufficient-evidence")).toBe(
        true,
      );
      perCall.push(report.outcomes.map((outcome) => outcome.listingId));
    }

    // Call 2 must not repeat call 1: the rows just examined went to the back of the queue.
    expect(perCall[1].filter((id) => perCall[0].includes(id))).toEqual([]);
    // Coverage: all 40 distinct rows re-examined within four calls.
    expect(new Set(perCall.flat()).size).toBe(40);
  });
});

describe("evaluateBatch -- retries cannot duplicate results", () => {
  // E15. THE REQUEUE RACE, at ONE `now`, exactly as measured.
  //
  // recordSightings sets a claimed task back to PENDING and never touches lease_expires_at, so a
  // second claimant legally re-claims the row and -- with the lease VALUE as the fence -- writes
  // THE SAME TOKEN. A's stale completion then applies, B's fresh one is discarded, and the row
  // ends COMPLETE at the current revision carrying a verdict computed from the OLD price:
  // ineligible under all four tiers, so the price change that triggered the requeue is never
  // evaluated. GATE: task retries do not duplicate results.
  it("E15: a stale completion loses to the claim that superseded it", async () => {
    await sight([valid({ listingId: "raced", priceCents: 25_000 })], T0);

    const claimA = await claimEvaluationTasks(db, {
      source: SOURCE,
      batchSize: 15,
      now: T0,
      leaseSeconds: 300,
      leaseToken: "token-A",
      searchRevision: 1,
    });
    expect(claimA.tasks).toEqual([{ listingId: "raced" }]);

    // The price changes under A: the contribution changed, so QUEUE_TASK resets it to PENDING.
    await sight([valid({ listingId: "raced", priceCents: 40_000 })], T0);
    // Deliberately NOT asserting the stored lease_token here: this test must reach the fence
    // assertions below under every mutation, and an assertion on the token would trip first and
    // hide WHICH completion actually applied -- the only thing E15 exists to measure.
    expect(await taskRow("raced")).toMatchObject({ status: "PENDING" });

    const claimB = await claimEvaluationTasks(db, {
      source: SOURCE,
      batchSize: 15,
      now: T0, // THE SAME `now`. The lease VALUE is therefore identical to A's.
      leaseSeconds: 300,
      leaseToken: "token-B",
      searchRevision: 1,
    });
    expect(claimB.tasks).toEqual([{ listingId: "raced" }]);

    // A's completion, computed from the OLD price, goes first -- as it did when measured.
    const appliedA = await completionStatement(db, {
      source: SOURCE,
      listingId: "raced",
      status: "COMPLETE",
      verdict: "DEAL",
      searchRevision: 1,
      now: T0,
      leaseToken: "token-A",
    }).run();
    // B's completion, computed from the NEW price.
    const appliedB = await completionStatement(db, {
      source: SOURCE,
      listingId: "raced",
      status: "COMPLETE",
      verdict: "NOT_DEAL",
      searchRevision: 1,
      now: T0,
      leaseToken: "token-B",
    }).run();

    // changes === 0 is what evaluateBatch routes to `discarded`; 1 is what it routes to `outcomes`.
    expect(appliedA.meta.changes).toBe(0);
    expect(appliedB.meta.changes).toBe(1);
    expect(await taskRow("raced")).toMatchObject({ status: "COMPLETE", verdict: "NOT_DEAL" });
  });

  // E15b. The same race with the superseding claimant being a real evaluateBatch call, so the
  // REPORT is asserted and not only the row: B's verdict is the only one in `outcomes`, and A's
  // later completion cannot overwrite it.
  it("E15b: the superseded claimant cannot overwrite a committed verdict", async () => {
    await sight([valid({ listingId: "raced", priceCents: 25_000 })], T0);

    await claimEvaluationTasks(db, {
      source: SOURCE,
      batchSize: 15,
      now: T0,
      leaseSeconds: 300,
      leaseToken: "token-A",
      searchRevision: 1,
    });
    await sight([valid({ listingId: "raced", priceCents: 40_000 })], T0);

    const reportB = await evaluateBatch(db, {
      source: SOURCE,
      settings: maximum(30_000, 1),
      now: T0,
      leaseToken: "token-B",
    });
    expect(reportB.outcomes).toHaveLength(1);
    expect(reportB.discarded).toEqual([]);
    expect(outcomeFor(reportB.outcomes, "raced")).toMatchObject({
      verdict: "NOT_DEAL",
      candidatePriceCents: 40_000,
    });

    const appliedA = await completionStatement(db, {
      source: SOURCE,
      listingId: "raced",
      status: "COMPLETE",
      verdict: "DEAL",
      searchRevision: 1,
      now: T0,
      leaseToken: "token-A",
    }).run();

    expect(appliedA.meta.changes).toBe(0);
    expect(await taskRow("raced")).toMatchObject({ verdict: "NOT_DEAL" });
  });

  // E15c. THE `discarded` PATH, DRIVEN FROM A REAL evaluateBatch CALL.
  //
  // `discarded` exists so a caller cannot act on a rejected verdict by forgetting to filter, and
  // nothing else in this file ever sees it non-empty -- which means the split could be deleted and
  // the suite would stay green while Phase 4 notified on verdicts computed from state that no
  // longer holds.
  //
  // It does not take two claimants. It takes THE ROW CHANGING UNDER ONE CALL, in the production
  // window between the candidate read and the completion batch. The database below delegates every
  // statement to the real one and interposes exactly one recordSightings requeue at that point --
  // the same stub shape evaluationCpu.test.ts uses, and the requeue is real 3C code, not a
  // hand-written UPDATE.
  it("E15c: a verdict the fence rejects lands in `discarded`, never in `outcomes`", async () => {
    await sight(
      [0, 1, 2].map((index) => valid({ listingId: `gap-${index}`, priceCents: 20_000 + index * 100 })),
      T0,
    );

    let interposed = false;
    const racing = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!interposed) {
          interposed = true;
          // gap-1's price changes after its verdict was computed: QUEUE_TASK resets the task to
          // PENDING, so the completion's `status='PROCESSING'` fence rejects it.
          await sight([valid({ listingId: "gap-1", priceCents: 90_000 })], T0);
        }
        return db.batch(statements);
      },
    } as unknown as D1Database;

    const report = await evaluateBatch(racing, {
      source: SOURCE,
      settings: maximum(30_000, 1),
      now: T0,
      leaseToken: "token-e15c",
    });

    expect(report.claimed).toBe(3);
    expect(report.outcomes.map((outcome) => outcome.listingId).sort()).toEqual(["gap-0", "gap-2"]);
    expect(report.discarded).toEqual([
      { source: SOURCE, listingId: "gap-1", verdict: "DEAL", reason: "within-maximum" },
    ]);
    // And the rejected verdict was NOT committed: the row is back at PENDING with no verdict on
    // it, waiting to be re-evaluated at its new price.
    expect(await taskRow("gap-1")).toMatchObject({ status: "PENDING", verdict: null });
  });

  // E16. Replaying a completion is a no-op. The statement is built by the PRODUCTION builder, so
  // a mutation applied to COMPLETE_TASK is carried into the test rather than hand-copied around.
  it("E16: re-issuing a completion that already applied changes nothing", async () => {
    await sight([valid({ listingId: "once", priceCents: 25_000 })], T0);
    await evaluateBatch(db, {
      source: SOURCE,
      settings: maximum(30_000, 1),
      now: T0,
      leaseToken: "token-e16",
    });
    const before = await taskRow("once");

    const replay = await completionStatement(db, {
      source: SOURCE,
      listingId: "once",
      status: "COMPLETE",
      verdict: "NOT_DEAL", // a DIFFERENT verdict, so a missing fence would be visible
      searchRevision: 1,
      now: T0 + 5,
      leaseToken: "token-e16",
    }).run();

    expect(replay.meta.changes).toBe(0);
    expect(await taskRow("once")).toEqual(before);
  });

  // E17. A crashed claimant is invisible until its lease expires, then recovered by tier 2 --
  // ahead of revision and evidence work, behind fresh PENDING. Work is deferred, never lost and
  // never double-committed.
  it("E17: a stranded PROCESSING task is invisible until the lease expires, then recovered", async () => {
    await sight([valid({ listingId: "crashed", priceCents: 25_000 })], T0);

    const abandoned = await claimEvaluationTasks(db, {
      source: SOURCE,
      batchSize: 15,
      now: T0,
      leaseSeconds: 300,
      leaseToken: "token-crashed",
      searchRevision: 1,
    });
    expect(abandoned.tasks).toEqual([{ listingId: "crashed" }]);

    const tooEarly = await evaluateBatch(db, {
      source: SOURCE,
      settings: maximum(30_000, 1),
      now: T0,
      leaseSeconds: 300,
      leaseToken: "token-e17a",
    });
    expect(tooEarly.claimed).toBe(0);

    const recovered = await evaluateBatch(db, {
      source: SOURCE,
      settings: maximum(30_000, 1),
      now: T0 + 300,
      leaseSeconds: 300,
      leaseToken: "token-e17b",
    });
    expect(recovered.claimed).toBe(1);
    expect(outcomeFor(recovered.outcomes, "crashed")).toMatchObject({ verdict: "DEAL" });
    expect(await taskRow("crashed")).toMatchObject({ status: "COMPLETE" });

    // Exactly once: the recovered task is not re-claimed a second time.
    const after = await evaluateBatch(db, {
      source: SOURCE,
      settings: maximum(30_000, 1),
      now: T0 + 600,
      leaseSeconds: 300,
      leaseToken: "token-e17c",
    });
    expect(after.claimed).toBe(0);
  });
});

describe("evaluateBatch -- no single listing can stall the queue", () => {
  const fourteenGood = () =>
    Array.from({ length: 14 }, (_, index) =>
      valid({ listingId: `ok-${String(index).padStart(2, "0")}`, priceCents: 20_000 + index * 100 }),
    );

  // E18. THE POISON PILL. price_cents is INTEGER *affinity*, not a constraint: the canonical
  // `19.99 * 100` parser yields 1998.9999999999998, UPSERT_LISTING binds it unconditionally, the
  // CHECK passes, and QUEUE_TASK fires. Without the coercion the RangeError escapes AFTER the
  // claim: all 15 stay PROCESSING, the lease expires, tier 2 re-claims them AHEAD OF EVERYTHING
  // except fresh PENDING, and they throw again -- forever.
  it("E18: a non-integer price is no-price and COMPLETE, and the other 14 are unaffected", async () => {
    await sight([...fourteenGood(), valid({ listingId: "poison", priceCents: 1998.9999999999998 })], T0);

    const report = await evaluateBatch(db, {
      source: SOURCE,
      settings: maximum(40_000, 1),
      now: T0,
      leaseToken: "token-e18a",
    });

    expect(report.outcomes).toHaveLength(15);
    expect(outcomeFor(report.outcomes, "poison")).toMatchObject({
      verdict: "NEEDS_REVIEW",
      reason: "no-price",
      status: "COMPLETE",
    });
    for (let index = 0; index < 14; index += 1) {
      expect(outcomeFor(report.outcomes, `ok-${String(index).padStart(2, "0")}`)).toMatchObject({
        verdict: "DEAL",
        reason: "within-maximum",
        status: "COMPLETE",
      });
    }

    // Terminal: the bad row is not re-claimed, so it cannot poison the next batch either.
    const second = await evaluateBatch(db, {
      source: SOURCE,
      settings: maximum(40_000, 1),
      now: T0 + 60,
      leaseToken: "token-e18b",
    });
    expect(second.claimed).toBe(0);
  });

  // E19. A claimed task whose listings row is absent produces NO READ ROW. Iterating the read set
  // would silently never complete it, leaving it PROCESSING to be re-claimed at tier 2 forever.
  it("E19: a task with no listing row is completed, not left in PROCESSING", async () => {
    await sight(fourteenGood(), T0);
    await db.batch([insertTask({ listingId: "ghost", status: "PENDING", createdAt: T0 })]);

    const report = await evaluateBatch(db, {
      source: SOURCE,
      settings: maximum(40_000, 1),
      now: T0,
      leaseToken: "token-e19",
    });

    expect(report.outcomes).toHaveLength(15);
    expect(outcomeFor(report.outcomes, "ghost")).toMatchObject({
      verdict: "NEEDS_REVIEW",
      reason: "listing-missing",
      status: "COMPLETE",
      candidatePriceCents: null,
    });
    expect(outcomeFor(report.outcomes, "ok-00")).toMatchObject({ verdict: "DEAL" });
    expect(await taskRow("ghost")).toMatchObject({ status: "COMPLETE" });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM evaluation_tasks WHERE status='PROCESSING'")
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  // E20. A bug in `decide` must not surface as fifteen priced listings claiming to have no
  // price, with the only diagnostic the report offers pointing away from the fault.
  it("E20: a throwing decide is labelled evaluation-error, not no-price", async () => {
    await sight([...fourteenGood(), valid({ listingId: "boom", priceCents: 33_333 })], T0);
    stub.throwForPriceCents = 33_333;

    const report = await evaluateBatch(db, {
      source: SOURCE,
      settings: maximum(40_000, 1),
      now: T0,
      leaseToken: "token-e20",
    });

    expect(report.outcomes).toHaveLength(15);
    expect(outcomeFor(report.outcomes, "boom")).toMatchObject({
      verdict: "NEEDS_REVIEW",
      reason: "evaluation-error",
      status: "COMPLETE",
    });
    for (let index = 0; index < 14; index += 1) {
      expect(outcomeFor(report.outcomes, `ok-${String(index).padStart(2, "0")}`)).toMatchObject({
        verdict: "DEAL",
        reason: "within-maximum",
      });
    }
  });
});

describe("evaluateBatch -- budget, isolation and guards", () => {
  // E21. ALL FOUR CLAIM STATEMENTS RUN even when the first returns nothing. In the ordinary
  // steady state nothing is PENDING, so `if (tier1.length === 0) return` would disable
  // expired-lease recovery, evidence re-checks and revision bumps ALL AT ONCE -- the most
  // expensive single line available in this design.
  it("E21: runs every tier on an empty table, and issues no read and no write batch", async () => {
    // A recorder that DELEGATES to the same real D1 -- not a second database seam: it executes
    // no SQL and owns no schema, it only writes down which statements evaluateBatch asked for.
    const prepared: string[] = [];
    let batchCalls = 0;
    const recording = {
      prepare: (sql: string) => {
        prepared.push(sql);
        return db.prepare(sql);
      },
      batch: (statements: D1PreparedStatement[]) => {
        batchCalls += 1;
        return db.batch(statements);
      },
    } as unknown as D1Database;

    const report = await evaluateBatch(recording, {
      source: SOURCE,
      settings: discount(20, 1),
      now: T0,
      leaseToken: "token-e21",
    });

    expect(report).toMatchObject({ outcomes: [], discarded: [], claimed: 0 });
    expect(report.usage.rowsWritten).toBe(0);
    expect(prepared).toEqual([
      CLAIM_PENDING,
      CLAIM_EXPIRED,
      CLAIM_STALE_REVISION,
      CLAIM_NEEDS_REVIEW,
    ]);
    expect(prepared.some((sql) => sql.includes("candidate_price_cents"))).toBe(false);
    expect(batchCalls).toBe(0);
  });

  // E22. The LIMIT is bound to the REMAINING batch budget, not to a constant.
  it("E22: drains 40 PENDING tasks 15 / 15 / 10 across three calls", async () => {
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < 40; index += 1) {
      const id = `p-${String(index).padStart(2, "0")}`;
      statements.push(
        insertListing({ listingId: id, priceCents: 25_000, validity: "INVALID_REFERENCE" }),
        insertTask({ listingId: id, status: "PENDING", createdAt: T0 + index }),
      );
    }
    await db.batch(statements);

    const claimed: number[] = [];
    for (let call = 0; call < 4; call += 1) {
      const report = await evaluateBatch(db, {
        source: SOURCE,
        settings: maximum(30_000, 1),
        now: T0 + 1000 + call * 60,
        leaseToken: `token-e22-${call}`,
      });
      claimed.push(report.claimed);
    }

    expect(claimed).toEqual([15, 15, 10, 0]);
  });

  // E23. `source = ?1` scopes every tier -- including each OR term of the revision tier, where it
  // is repeated. The other source's tasks are OLDER, so an unscoped tier would take them first.
  it("E23: claims only the requested source's tasks, in every tier", async () => {
    await db.batch([
      // The other source, older, and one row for each of the three eligible statuses.
      insertListing({ listingId: "b-pending", priceCents: 25_000, validity: "INVALID_REFERENCE", source: OTHER_SOURCE }),
      insertTask({ listingId: "b-pending", status: "PENDING", createdAt: T0 - 500, source: OTHER_SOURCE }),
      insertListing({ listingId: "b-stale", priceCents: 25_000, validity: "INVALID_REFERENCE", source: OTHER_SOURCE }),
      insertTask({
        listingId: "b-stale",
        status: "COMPLETE",
        createdAt: T0 - 500,
        evaluatedRevision: 1,
        source: OTHER_SOURCE,
      }),
      insertListing({ listingId: "b-review", priceCents: 25_000, validity: "VALID", source: OTHER_SOURCE }),
      insertTask({
        listingId: "b-review",
        status: "NEEDS_REVIEW",
        createdAt: T0 - 500,
        evaluatedAt: T0 - 500,
        evaluatedRevision: 2,
        source: OTHER_SOURCE,
      }),
      // The requested source, newer.
      insertListing({ listingId: "a-pending", priceCents: 25_000, validity: "INVALID_REFERENCE" }),
      insertTask({ listingId: "a-pending", status: "PENDING", createdAt: T0 }),
    ]);

    const report = await evaluateBatch(db, {
      source: SOURCE,
      settings: maximum(30_000, 2),
      now: T0,
      leaseToken: "token-e23",
    });

    expect(report.outcomes.map((outcome) => outcome.listingId)).toEqual(["a-pending"]);
    for (const id of ["b-pending", "b-stale", "b-review"]) {
      const row = await taskRow(id, OTHER_SOURCE);
      expect(row!.status).not.toBe("PROCESSING");
      expect(row!.lease_token).toBe("");
    }
  });

  // E24. EVERY GUARD RUNS BEFORE THE CLAIM, so a bad input throws without stranding anything in
  // PROCESSING. Two of these are not hygiene:
  //   leaseSeconds 0 -- the lease is `now`, so tier 2 re-claims the rows tier 1 just claimed
  //     INSIDE THE SAME CALL: measured 3 PENDING tasks -> 6 claim entries with 3 duplicate ids.
  //   leaseToken '' -- '' is the column's DEFAULT, and a completion carrying '' against a
  //     PROCESSING row whose token is still '' measures changes = 1: the fence silently off.
  it("E24: rejects every bad call parameter and strands nothing", async () => {
    await sight(
      [20_000, 21_000, 22_000].map((priceCents, index) => valid({ listingId: `g-${index}`, priceCents })),
      T0,
    );

    const bad: Array<[string, Parameters<typeof evaluateBatch>[1]]> = [
      [
        "searchRevision null",
        {
          source: SOURCE,
          settings: { ...discount(20), searchRevision: null as unknown as number },
          now: T0,
        },
      ],
      ["batchSize 0", { source: SOURCE, settings: discount(20), now: T0, batchSize: 0 }],
      ["batchSize 99", { source: SOURCE, settings: discount(20), now: T0, batchSize: 99 }],
      ["leaseSeconds 0", { source: SOURCE, settings: discount(20), now: T0, leaseSeconds: 0 }],
      ["leaseSeconds -1", { source: SOURCE, settings: discount(20), now: T0, leaseSeconds: -1 }],
      ["leaseSeconds 1.5", { source: SOURCE, settings: discount(20), now: T0, leaseSeconds: 1.5 }],
      ["leaseToken ''", { source: SOURCE, settings: discount(20), now: T0, leaseToken: "" }],
    ];

    for (const [label, input] of bad) {
      await expect(evaluateBatch(db, input), label).rejects.toThrow();
      expect(
        await db
          .prepare("SELECT COUNT(*) AS n FROM evaluation_tasks WHERE status <> 'PENDING'")
          .first<{ n: number }>(),
        label,
      ).toEqual({ n: 0 });
    }
  });
});
