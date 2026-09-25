// @vitest-environment node

import { claimEvaluationTasks } from "../evaluation/evaluateBatch";
import { loadCurrentSettings, updateSearchSettings } from "../search/settings";
import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";
import { handleGetWatchTargets } from "./watchTargets";

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

const seedMarket = (
  overrides: Partial<{
    location: string;
    latitude: number;
    longitude: number;
    radiusKm: number;
  }> = {},
) =>
  database.db
    .prepare(
      "INSERT INTO watch_market (id, location, latitude, longitude, radius_km) VALUES (1, ?1, ?2, ?3, ?4)",
    )
    .bind(
      overrides.location ?? "toronto",
      overrides.latitude ?? 43.6532,
      overrides.longitude ?? -79.3832,
      overrides.radiusKm ?? 25,
    )
    .run();

const seedTarget = (targetId: string, componentType: string, query: string) =>
  database.db
    .prepare("INSERT INTO watch_targets (target_id, component_type, query) VALUES (?1, ?2, ?3)")
    .bind(targetId, componentType, query)
    .run();

/**
 * THE CLAIM IS PRECISE, AND IT IS NOT "the files diff clean": the `results`-only fingerprint of
 * search_revisions, search_settings and evaluation_tasks. A `wrangler --json` envelope carries a
 * `meta.duration` that differs between runs and says nothing.
 *
 * It is the WIDE fingerprint: `SELECT *` pins `created_at`, `lease_token` and `lease_expires_at`
 * as well as the verdict columns, so a write that touched only the lease would still show.
 */
const fingerprint = async () => {
  const revisions = await database.db
    .prepare("SELECT * FROM search_revisions ORDER BY revision")
    .all();
  const settings = await database.db.prepare("SELECT * FROM search_settings ORDER BY id").all();
  const tasks = await database.db
    .prepare("SELECT * FROM evaluation_tasks ORDER BY source, listing_id")
    .all();
  return {
    revisions: revisions.results,
    settings: settings.results,
    tasks: tasks.results,
  };
};

const seedEvaluationCorpus = async () => {
  await database.db.batch([
    database.db.prepare(
      "INSERT INTO search_revisions (revision, mode, minimum_discount_percent, maximum_price_cents, created_at) VALUES (0, 'MAXIMUM_PRICE', NULL, 80000, 1700000000)",
    ),
    database.db.prepare(
      "INSERT INTO search_revisions (revision, mode, minimum_discount_percent, maximum_price_cents, created_at) VALUES (1, 'MAXIMUM_PRICE', NULL, 74900, 1700000100)",
    ),
    database.db.prepare("INSERT INTO search_settings (id, current_revision) VALUES (1, 1)"),
  ]);

  const verdicts = ["DEAL", "NEEDS_REVIEW", "NOT_DEAL"];
  await database.db.batch(
    verdicts.map((verdict, index) =>
      database.db
        .prepare(
          `INSERT INTO evaluation_tasks
             (source, listing_id, status, created_at, evaluated_revision, verdict, evaluated_at,
              lease_expires_at, lease_token)
           VALUES ('facebook-marketplace', ?1, 'COMPLETE', 1700000200, 1, ?2, 1700000300, 0, '')`,
        )
        .bind(`listing-${index}`, verdict),
    ),
  );
};

const claim = async () => {
  const current = await loadCurrentSettings(database.db);
  const claimed = await claimEvaluationTasks(database.db, {
    source: "facebook-marketplace",
    batchSize: 15,
    now: 1700001000,
    leaseSeconds: 300,
    leaseToken: "watch-suite-lease",
    searchRevision: current.settings?.searchRevision ?? 0,
  });
  return claimed.tasks.length;
};

describe("GET /api/watch-targets", () => {
  /**
   * W-1: THE WHOLE POINT OF THE SEPARATE TABLES. `search_revisions` is an append-only revision
   * log and `evaluateBatch` uses `searchRevision` to decide which verdicts are stale -- bumping
   * it re-opens EVERY evaluation task in the corpus. Adding "also watch RAM" says nothing about
   * whether an already-judged GPU was a deal, so changing what you hunt must cost ZERO verdicts.
   *
   * The two mutations this kills are the two failure modes the slice exists to avoid: making the
   * watch-list path bump the revision (tier 4 then re-opens all three), and having it
   * `UPDATE evaluation_tasks SET status='PENDING'` (tier 1 then claims three).
   */
  it("W-1: reading and writing the watch list invalidates no verdict", async () => {
    await seedEvaluationCorpus();
    await seedMarket();
    await seedTarget("cpu-toronto", "cpu", "cpu");
    await seedTarget("gpu-toronto", "gpu", "graphics card");

    expect(await claim()).toBe(0);

    const before = await fingerprint();

    const read = await handleGetWatchTargets(database.db);
    expect(read.ok).toBe(true);

    // ...and a WRITE to each table, of every kind, not merely a read.
    await seedTarget("ram-toronto", "ram", "ddr5 ram");
    await database.db
      .prepare("UPDATE watch_targets SET query = 'gpu' WHERE target_id = 'gpu-toronto'")
      .run();
    await database.db.prepare("DELETE FROM watch_targets WHERE target_id = 'cpu-toronto'").run();
    await database.db.prepare("UPDATE watch_market SET radius_km = 12 WHERE id = 1").run();
    await database.db.prepare("DELETE FROM watch_market WHERE id = 1").run();
    await seedMarket({ radiusKm: 18 });

    expect(await claim()).toBe(0);
    expect(await fingerprint()).toEqual(before);
  });

  /**
   * W-1c: THE CONTROL, AND IT IS NOT OPTIONAL. Without it W-1 passes against a wholly inert
   * claim path -- "0 claimed" is also what a broken claim returns.
   */
  it("W-1c: the control -- a real revision bump DOES re-open all three", async () => {
    await seedEvaluationCorpus();
    expect(await claim()).toBe(0);

    await updateSearchSettings(database.db, {
      mode: "MAXIMUM_PRICE",
      minimumDiscountPercent: null,
      maximumPriceCents: 61250,
      now: 1700000400,
    });

    expect(await claim()).toBe(3);
  });

  it("W-2: targets come back ordered by target_id, camelCase, with the market alongside", async () => {
    await seedMarket({ location: "new-york", latitude: 40.7128, longitude: -74.006, radiusKm: 18 });
    // Inserted in an order that is NOT the answer, so `ORDER BY target_id` is what sorts them.
    await seedTarget("gpu-toronto", "gpu", "graphics card");
    await seedTarget("cpu-toronto", "cpu", "cpu");
    await seedTarget("ram-toronto", "ram", "ddr5 ram");

    const result = await handleGetWatchTargets(database.db);

    expect(result).toEqual({
      ok: true,
      status: 200,
      body: {
        market: { location: "new-york", latitude: 40.7128, longitude: -74.006, radiusKm: 18 },
        targets: [
          { targetId: "cpu-toronto", componentType: "cpu", query: "cpu" },
          { targetId: "gpu-toronto", componentType: "gpu", query: "graphics card" },
          { targetId: "ram-toronto", componentType: "ram", query: "ddr5 ram" },
        ],
      },
    });
  });

  /**
   * W-3: A STORAGE OUTAGE IS 503, NEVER AN EMPTY WATCH LIST. Swallowing the throw and answering
   * `{market, targets: []}` would make an outage read to the collector as "there is nothing to
   * hunt" -- collection stops and every signal says it is a quiet day.
   */
  it("W-3: a D1 that rejects is 503 WATCH_TARGETS_STORAGE_FAILED", async () => {
    const throwing = {
      prepare: () => {
        throw new Error("D1_ERROR: no such table");
      },
    } as unknown as D1Database;

    await expect(handleGetWatchTargets(throwing)).resolves.toEqual({
      ok: false,
      status: 503,
      code: "WATCH_TARGETS_STORAGE_FAILED",
    });
  });

  it("W-4: an empty watch list is 200 with an empty array, not 404 and not 503", async () => {
    await seedMarket();

    await expect(handleGetWatchTargets(database.db)).resolves.toEqual({
      ok: true,
      status: 200,
      body: {
        market: { location: "toronto", latitude: 43.6532, longitude: -79.3832, radiusKm: 25 },
        targets: [],
      },
    });
  });

  /**
   * W-5: AN ABSENT MARKET IS `null`, EXPLICITLY, AND NEVER A DEFAULT. Inventing one here would
   * make the collector collect into the wrong `market_key` silently -- and `market_key` is what
   * every aggregate row is scoped by.
   */
  it("W-5: an absent watch_market row is 200 with market:null", async () => {
    await seedTarget("gpu-toronto", "gpu", "graphics card");

    await expect(handleGetWatchTargets(database.db)).resolves.toEqual({
      ok: true,
      status: 200,
      body: {
        market: null,
        targets: [{ targetId: "gpu-toronto", componentType: "gpu", query: "graphics card" }],
      },
    });
  });
});
