// @vitest-environment node

import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";
import { evaluateBatch } from "../evaluation/evaluateBatch";
import { MINIMUM_REFERENCE_COUNT } from "../evaluation/types";
import { handleGetVerdicts, VERDICT_PAGE_SIZE } from "./verdicts";

const MARKET = "43.5123,-79.8765|18km";
const SOURCE = "facebook-marketplace";

/**
 * EVERY REFERENCE FIXTURE IS DERIVED FROM `MINIMUM_REFERENCE_COUNT`, NOT FROM THE LITERAL 5.
 * The brief moves that constant to 15 in the slice that needs it, and three of these tests were
 * pinned to 5 by their arithmetic: on that day they would have gone red for a reason with
 * nothing to do with the read path, and the cheap repair -- editing the literals -- would have
 * re-pinned them to 15 and lost what they measure.
 *
 * `refs(n)` seeds an aggregate whose mean is EXACTLY `AVERAGE` for any n, so every assertion
 * below is `AVERAGE` and no assertion is a number that moves with the constant.
 */
const AVERAGE = 300_000;
const HALF_AVERAGE = AVERAGE / 2;

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

const listing = async (over: Record<string, unknown> = {}) => {
  const row = {
    source: SOURCE,
    listing_id: "L1",
    market_key: MARKET,
    component_type: "gpu",
    model_key: "GeForce RTX 5080",
    variant_key: "",
    title: "ASUS ROG Astral RTX 5080",
    price_cents: 300000,
    location_text: "Toronto, ON",
    url: "https://example.com/l",
    validity: "VALID",
    content_hash: "h",
    first_seen_at: 1_800_000_000,
    last_seen_at: 1_800_000_000,
    ...over,
  };
  await database.db
    .prepare(
      `INSERT INTO listings (source, listing_id, market_key, component_type, model_key,
         variant_key, title, price_cents, location_text, url, validity, content_hash,
         first_seen_at, last_seen_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
    )
    .bind(
      row.source, row.listing_id, row.market_key, row.component_type, row.model_key,
      row.variant_key, row.title, row.price_cents, row.location_text, row.url,
      row.validity, row.content_hash, row.first_seen_at, row.last_seen_at,
    )
    .run();
};

const task = async (listingId: string, status: string, verdict: string | null) =>
  database.db
    .prepare(
      `INSERT INTO evaluation_tasks (source, listing_id, status, created_at, verdict,
         evaluated_revision, evaluated_at, lease_expires_at, lease_token)
       VALUES (?1,?2,?3,1,?4,0,1,0,'')`,
    )
    .bind(SOURCE, listingId, status, verdict)
    .run();

const refs = async (count: number) => stats(count, AVERAGE * count);

const stats = async (count: number, total: number, modelKey = "GeForce RTX 5080") =>
  database.db
    .prepare(
      `INSERT INTO model_stats (market_key, model_key, variant_key, count, total_price_cents)
       VALUES (?1,?2,'',?3,?4)`,
    )
    .bind(MARKET, modelKey, count, total)
    .run();

const observation = async (listingId: string, price: number, modelKey = "GeForce RTX 5080") =>
  database.db
    .prepare(
      `INSERT INTO price_observations (source, listing_id, market_key, model_key, variant_key,
         price_cents, last_seen_at)
       VALUES (?1,?2,?3,?4,'',?5,1)`,
    )
    .bind(SOURCE, listingId, MARKET, modelKey, price)
    .run();

const read = async () => {
  const result = await handleGetVerdicts(database.db);
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result.body;
};

describe("GET /api/verdicts", () => {
  it("V-2: translates component_type into the catalog's spelling", async () => {
    await listing({ listing_id: "fan", component_type: "case_fan" });
    const body = await read();
    expect(body.listings[0].componentType).toBe("case_fans");
  });

  it("V-2b: drops a component_type outside the nine rather than serving it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await listing({ listing_id: "ok" });
    await listing({ listing_id: "bad", component_type: "gpuu" });
    const body = await read();
    expect(body.listings.map((row) => row.listingId)).toEqual(["ok"]);
    expect(warn).toHaveBeenCalled();
  });

  /**
   * THE PROTOTYPE KEY, AND IT IS WHY THE GUARD IS `Object.hasOwn` AND NOT `?? null`.
   * MEASURED: replacing the guard with
   * `CATALOG_COMPONENT_ID[value as keyof typeof CATALOG_COMPONENT_ID] ?? null` -- the form
   * anyone would call equivalent -- left the WHOLE suite green at 1123, because V-2b's fixture
   * is "gpuu", an unknown OWN key, which `?? null` handles identically. With
   * `component_type = 'toString'` the lookup resolves to `Object.prototype.toString`, a
   * function, so `?? null` never fires: the row is SERVED, `JSON.stringify` silently omits a
   * function-valued property so the wire object has no `componentType` key at all,
   * `truncated: false` claims the page is complete, and `ListingCard` then throws on
   * `component.label` -- the blank dashboard, from a database value.
   * DO NOT "SIMPLIFY" `Object.hasOwn` AWAY. This row is its only guard.
   */
  it("V-2c: a prototype key is dropped, exactly as an unknown own key is", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await listing({ listing_id: "ok" });
    await listing({ listing_id: "proto", component_type: "toString" });
    await listing({ listing_id: "ctor", component_type: "constructor" });
    const body = await read();
    expect(body.listings.map((row) => row.listingId)).toEqual(["ok"]);
    // The wire object must not be missing the key either -- the shape, not just the id list.
    expect(body.listings[0]).toHaveProperty("componentType", "gpu");
    expect(body.truncated).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("V-3: orders DEAL, NEEDS_REVIEW, PENDING, NOT_DEAL and newest first inside a rank", async () => {
    // EVERY ID IS CHOSEN SO THAT ALPHABETICAL ORDER CONTRADICTS RECENCY INSIDE ITS RANK.
    // MEASURED: with ids that happened to agree, dropping `last_seen_at DESC` from the
    // ORDER BY survived this test.
    await listing({ listing_id: "z-not-deal", last_seen_at: 1_900_000_000 });
    await task("z-not-deal", "COMPLETE", "NOT_DEAL");
    await listing({ listing_id: "b-deal-new", last_seen_at: 1_800_000_100 });
    await task("b-deal-new", "COMPLETE", "DEAL");
    await listing({ listing_id: "a-deal-old", last_seen_at: 1_800_000_050 });
    await task("a-deal-old", "COMPLETE", "DEAL");
    await listing({ listing_id: "a-review-old", last_seen_at: 1_800_000_200 });
    await task("a-review-old", "NEEDS_REVIEW", "NEEDS_REVIEW");
    await listing({ listing_id: "b-corrupt-new", last_seen_at: 1_800_000_300 });
    await task("b-corrupt-new", "COMPLETE", "Deal");
    await listing({ listing_id: "a-unjudged-old", last_seen_at: 1_800_000_400 });
    await task("a-unjudged-old", "PENDING", null);
    await listing({ listing_id: "b-no-task-new", last_seen_at: 1_800_000_500 });

    const body = await read();
    expect(body.listings.map((row) => row.listingId)).toEqual([
      "b-deal-new", "a-deal-old", "b-corrupt-new", "a-review-old",
      "b-no-task-new", "a-unjudged-old", "z-not-deal",
    ]);
    expect(body.listings.map((row) => row.evaluation.status)).toEqual([
      "DEAL", "DEAL", "NEEDS_REVIEW", "NEEDS_REVIEW", "PENDING", "PENDING", "NOT_DEAL",
    ]);
  });

  /**
   * STRICTLY ABOVE THE GATE, on purpose. The first draft sat exactly ON it
   * (reference_count === MINIMUM_REFERENCE_COUNT), which conflated the exclusion ARITHMETIC
   * with the presentation GATE: `referenceAverageCents` applies no gate at all
   * (dealRules.ts:124-128 gates only on `count <= 0`), so a fixture on the boundary makes the
   * two sides disagree the moment the constant moves, for a reason that is not drift.
   *
   * The aggregate holds MINIMUM_REFERENCE_COUNT + 2 contributors, one of them the candidate at
   * its own price, so after exclusion the reference is MINIMUM_REFERENCE_COUNT + 1 at a mean of
   * exactly AVERAGE.
   */
  it("V-4: reports the same reference figures as evaluateBatch, above the gate", async () => {
    const others = MINIMUM_REFERENCE_COUNT + 1;
    await listing({ listing_id: "cand", price_cents: HALF_AVERAGE });
    await task("cand", "PENDING", null);
    await observation("cand", HALF_AVERAGE);
    await stats(others + 1, AVERAGE * others + HALF_AVERAGE);

    const report = await evaluateBatch(database.db, {
      source: SOURCE,
      settings: {
        mode: "DISCOUNT",
        minimumDiscountPercent: 10,
        maximumPriceCents: null,
        searchRevision: 0,
      },
      now: 1_800_001_000,
    });
    const outcome = report.outcomes[0];
    expect(outcome.referenceCount).toBe(others);
    expect(outcome.referenceTotalCents).toBe(AVERAGE * others);
    expect(outcome.referenceAverageCents).toBe(AVERAGE);

    const body = await read();
    // THE CROSS-CHECK, both ways: the read and `evaluateBatch` derive the SAME figure from the
    // SAME aggregate, AND that figure is the one the fixture built -- so the assertion cannot
    // pass by both sides losing. WHAT IT DOES NOT CLAIM, because the read cannot: that the page
    // prints the average THIS VERDICT WAS JUDGED AGAINST. Nothing persists that -- 3D commits
    // `verdict` and not `reason` -- and `evaluateBatch.ts:98-100` records that nothing requeues
    // a task when the market moves, so the two agree here only because this fixture reads the
    // aggregate at the same instant the evaluator did. In production they drift apart, which is
    // the cost stated at the top of `verdicts.ts`.
    expect(body.listings[0].evaluation.averagePriceCents).toBe(outcome.referenceAverageCents);
    expect(body.listings[0].evaluation.averagePriceCents).toBe(AVERAGE);
  });

  it("V-4b: a non-contributor is not subtracted from its own market", async () => {
    await listing({ listing_id: "quiet", price_cents: HALF_AVERAGE });
    await task("quiet", "COMPLETE", "DEAL");
    await refs(MINIMUM_REFERENCE_COUNT + 1);
    const body = await read();
    // Subtracting unconditionally gives AVERAGE * (n + 1) / n, which is never AVERAGE.
    expect(body.listings[0].evaluation.averagePriceCents).toBe(AVERAGE);
  });

  it("V-12: withholds the average below the evidence minimum", async () => {
    await listing({ listing_id: "thin", price_cents: HALF_AVERAGE });
    await task("thin", "NEEDS_REVIEW", "NEEDS_REVIEW");
    await refs(MINIMUM_REFERENCE_COUNT - 1);
    const thin = await read();
    expect(thin.listings[0].evaluation.averagePriceCents).toBeUndefined();
    expect(thin.listings[0].evaluation.discountPercent).toBeUndefined();

    await database.db
      .prepare("UPDATE model_stats SET count = ?1, total_price_cents = ?2")
      .bind(MINIMUM_REFERENCE_COUNT, AVERAGE * MINIMUM_REFERENCE_COUNT)
      .run();
    const enough = await read();
    expect(enough.listings[0].evaluation.averagePriceCents).toBe(AVERAGE);
    // The candidate is at half the average, so the discount is exactly 50% at any constant.
    expect(enough.listings[0].evaluation.discountPercent).toBe(50);
  });

  /**
   * THE CROSS-LAYER INVARIANT THAT MAKES A UI GUARD UNREACHABLE, PINNED HERE RATHER THAN
   * ASSERTED IN A COMMENT. `ListingCard` guards its market-average line with
   * `averagePriceCents &&` and its comparison line with `discountPercent !== undefined`.
   * MEASURED: removing the AVERAGE guard alone kills nothing, and it cannot, because this
   * endpoint never serves a discount without an average -- `discountPercentFrom` returns null
   * whenever the average is null, and the average is omitted whenever it is null. That makes
   * the UI guard defence in depth of the kind worker/api/listings.ts:433-435 keeps and labels
   * ("UNREACHABLE and kept as defence in depth ... No mutation can kill it"). THIS test is what
   * entitles anyone to say so: if the endpoint ever starts serving a bare discount, it goes red
   * here, at the layer that caused it.
   */
  it.each([
    ["no price, enough references", null, MINIMUM_REFERENCE_COUNT],
    ["a price, enough references", HALF_AVERAGE, MINIMUM_REFERENCE_COUNT],
    ["no price, too few references", null, MINIMUM_REFERENCE_COUNT - 1],
    ["a price, too few references", HALF_AVERAGE, MINIMUM_REFERENCE_COUNT - 1],
  ])("V-20: never serves a discount without an average (%s)", async (_label, price, count) => {
    await listing({ listing_id: "x", price_cents: price });
    await task("x", "NEEDS_REVIEW", "NEEDS_REVIEW");
    await refs(count);
    const body = await read();
    const evaluation = body.listings[0].evaluation;
    if (evaluation.discountPercent !== undefined) {
      expect(evaluation.averagePriceCents).not.toBeUndefined();
    }
    // And the one combination the UI has a guard for IS produced: average, no discount.
    if (price === null && count >= MINIMUM_REFERENCE_COUNT) {
      expect(evaluation.averagePriceCents).toBe(AVERAGE);
      expect(evaluation.discountPercent).toBeUndefined();
    }
  });

  /**
   * THE FIVE PASSTHROUGH FIELDS, PINNED AS A CLASS. AN ORCHESTRATOR ADDITION: §8.1's table does
   * not contain this row, and the measurement that earned it is that `source`, `modelKey`,
   * `title`, `location` and `url` could EACH be replaced by a constant in `toWireListing` for
   * 1130/1130 green, with the e2e asserting none of the five either. So the endpoint could have
   * served a constant for most of the payload the user actually reads and nothing in the
   * repository would have noticed. `source` surfaced first -- it is on the wire on one stated
   * ground, that the row's identity is `(source, listing_id)` (migrations/0001) -- but it was
   * one member of a class, so this row closes the class rather than the member.
   *
   * EVERY VALUE IS DISTINCT FROM EVERY OTHER, across both rows and across fields, so this
   * catches more than a constant: a CROSSED WIRE (`title: row.url`) and a column read from the
   * WRONG ROW both go red too. Two rows rather than one for the last of those -- MEASURED: with
   * a single fixture, serving `rows[0].source` for every row survives.
   *
   * The expected values are LITERALS here. They are not re-read from the row objects and never
   * built by calling `toWireListing`: a test that constructs the value under test cannot test
   * it, and that mistake has already been made twice on this slice.
   */
  it("V-21: serves each row's OWN source, model, title, location and url", async () => {
    await listing({
      source: "source-alpha",
      listing_id: "listing-alpha",
      model_key: "model-alpha",
      title: "title-alpha",
      location_text: "location-alpha",
      url: "https://example.com/url-alpha",
    });
    await listing({
      source: "source-beta",
      listing_id: "listing-beta",
      model_key: "model-beta",
      title: "title-beta",
      location_text: "location-beta",
      url: "https://example.com/url-beta",
    });

    const body = await read();
    const byId = new Map(body.listings.map((row) => [row.listingId, row]));

    expect(byId.get("listing-alpha")).toMatchObject({
      source: "source-alpha",
      modelKey: "model-alpha",
      title: "title-alpha",
      location: "location-alpha",
      url: "https://example.com/url-alpha",
    });
    expect(byId.get("listing-beta")).toMatchObject({
      source: "source-beta",
      modelKey: "model-beta",
      title: "title-beta",
      location: "location-beta",
      url: "https://example.com/url-beta",
    });
  });

  /**
   * THE CORRUPT-AGGREGATE GATE, WHICH `decide` HAS AND THIS PATH DID NOT. Without it,
   * `reference_count: 6, reference_total_cents: -600000` served `averagePriceCents: -100000`
   * and the card rendered "Market average  -$1,000.00".
   *
   * EVERY FIXTURE HERE SATISFIES EVERY `CHECK` ON `model_stats`
   * (`count >= 0`, `total_price_cents >= 0`, `count > 0 OR total_price_cents = 0`), which is the
   * part worth knowing: two of the three corrupt states are manufactured BY THIS FILE'S OWN
   * EXCLUSION ARITHMETIC out of rows the schema accepts, not by a hand-written corrupt row.
   * `s.total_price_cents - p.price_cents` goes negative the moment the observation and the
   * aggregate drift apart -- the divergence 3C's own doc has a drift-detection section for --
   * and `s.count - 1` goes negative on a legal `(0, 0)` aggregate. The third, a non-integer
   * count, stores directly: `count` is INTEGER *affinity*, so 5.5 passes `count >= 0` and reads
   * back as 5.5, which then passes `>= MINIMUM_REFERENCE_COUNT`.
   *
   * WHICH ASSERTION IS LOAD-BEARING DIFFERS BY FIXTURE, and saying so is the point. For the
   * first two the WITHHELD AVERAGE is the killer -- both land above the gate with a usable-
   * looking number. For `a legal zero aggregate` the average is withheld either way, because
   * -1 is below the gate; there the WARNING is the only observable, and it is the one that
   * stops a corrupt aggregate being reported as thin evidence, which is exactly the miscoding
   * `decide`'s two separate reasons exist to prevent.
   */
  it.each([
    [
      "a non-integer count above the gate",
      async () => stats(MINIMUM_REFERENCE_COUNT + 0.5, AVERAGE * (MINIMUM_REFERENCE_COUNT + 1)),
    ],
    [
      "a negative total from drift between the aggregate and the observation",
      async () => {
        await stats(MINIMUM_REFERENCE_COUNT + 1, 100);
        await observation("corrupt", AVERAGE);
      },
    ],
    [
      "a negative count from a legal zero aggregate",
      async () => {
        await stats(0, 0);
        await observation("corrupt", AVERAGE);
      },
    ],
  ])("V-22: withholds and warns on %s", async (_label, seed) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await listing({ listing_id: "corrupt", price_cents: HALF_AVERAGE });
    await seed();

    const body = await read();
    expect(body.listings[0].evaluation.averagePriceCents).toBeUndefined();
    expect(body.listings[0].evaluation.discountPercent).toBeUndefined();
    // The card still renders -- a corrupt aggregate costs the comparison, never the listing.
    expect(body.listings[0].listingId).toBe("corrupt");
    expect(warn).toHaveBeenCalled();
  });

  it("V-13: serves the sentinel variant as null and a real one verbatim", async () => {
    await listing({ listing_id: "blank", variant_key: "" });
    await listing({ listing_id: "real", variant_key: "12GB" });
    const body = await read();
    const byId = new Map(body.listings.map((row) => [row.listingId, row.variantKey]));
    expect(byId.get("blank")).toBeNull();
    expect(byId.get("real")).toBe("12GB");
  });

  it("V-14: a null price is null and a zero price is zero", async () => {
    await listing({ listing_id: "unpriced", price_cents: null });
    await listing({ listing_id: "free", price_cents: 0 });
    const body = await read();
    const byId = new Map(body.listings.map((row) => [row.listingId, row.priceCents]));
    expect(byId.get("unpriced")).toBeNull();
    expect(byId.get("free")).toBe(0);
  });

  it("V-15: observedAt is last_seen_at in seconds, rendered as ISO", async () => {
    await listing({ listing_id: "seen", last_seen_at: 1_800_000_000 });
    const body = await read();
    expect(body.listings[0].observedAt).toBe("2027-01-15T08:00:00.000Z");
  });

  it("V-16: bounds the page and says so", async () => {
    for (let index = 0; index <= VERDICT_PAGE_SIZE; index += 1) {
      await listing({ listing_id: `L${String(index).padStart(3, "0")}` });
    }
    const body = await read();
    expect(body.listings).toHaveLength(VERDICT_PAGE_SIZE);
    expect(body.truncated).toBe(true);

    await database.db.prepare("DELETE FROM listings WHERE listing_id = 'L050'").run();
    const exact = await read();
    expect(exact.listings).toHaveLength(VERDICT_PAGE_SIZE);
    expect(exact.truncated).toBe(false);
  });

  it("V-16b: a dropped row makes the page partial even below the bound", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await listing({ listing_id: "good" });
    await listing({ listing_id: "bad", component_type: "gpuu" });
    const body = await read();
    expect(body.listings).toHaveLength(1);
    // 49-of-50 reporting `truncated: false` was the silent claim this flag exists to prevent.
    expect(body.truncated).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("V-18: an unusable last_seen_at costs one card, not the page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await listing({ listing_id: "good", last_seen_at: 1_800_000_000 });
    await listing({ listing_id: "nan", last_seen_at: "not-a-time" });
    await listing({ listing_id: "huge", last_seen_at: 1e18 });
    const body = await read();
    expect(body.listings.map((row) => row.listingId)).toEqual(["good"]);
    expect(body.truncated).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("V-19: a page where EVERY row is unusable is a failure, not an empty page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await listing({ listing_id: "bad-a", component_type: "gpuu" });
    await listing({ listing_id: "bad-b", last_seen_at: "not-a-time" });
    const result = await handleGetVerdicts(database.db);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(503);
    // THE DISTINCT CODE, not the storage one: the read SUCCEEDED here and the rows are the
    // fault. Asserting VERDICTS_STORAGE_FAILED would pin, as correct, the exact miscoding that
    // narrowing the handler's `try` exists to remove.
    expect(result.code).toBe("VERDICTS_ROWS_UNUSABLE");
    expect(warn).toHaveBeenCalled();
  });

  /**
   * NOT A DECORATIVE CONTROL ANY MORE. MEASURED: deleting the `rows.length > 0 &&` conjunct
   * from the all-dropped guard makes an empty database answer 503, and THIS IS THE ONLY TEST
   * THAT FAILS. An empty database is what every fresh deployment holds until the first
   * collection run lands, so this row is the whole guard on the commonest state there is.
   */
  it("V-17: an empty database is an empty page, not a failure", async () => {
    const body = await read();
    expect(body).toEqual({ listings: [], truncated: false });
  });
});
