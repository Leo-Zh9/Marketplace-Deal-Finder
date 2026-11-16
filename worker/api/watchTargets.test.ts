// @vitest-environment node

import { updateSearchSettings } from "../search/settings";
import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";
import {
  claim as claimTasks,
  fingerprint as fingerprintOf,
  seedEvaluationCorpus as seedCorpus,
} from "../testing/evaluationFingerprint";
import { handleStopMonitoring } from "./monitoring";
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
 * THE FINGERPRINT, THE CORPUS AND THE CLAIM COME FROM `worker/testing/evaluationFingerprint.ts`,
 * which `worker/api/watch.test.ts` also imports. There was one copy per suite and they could
 * drift until one of them stopped measuring anything; see that file for what the fingerprint
 * covers, what it deliberately does not, and why the control below must assert non-emptiness.
 */
const fingerprint = () => fingerprintOf(database.db);
const seedEvaluationCorpus = () => seedCorpus(database.db);
const claim = () => claimTasks(database.db);

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

    // THESE THREE LINES ARE NOT OPTIONAL, AND THEY ARE WHY THE CONTROL IS A CONTROL. MEASURED:
    // replacing the shared helper with one returning `{revisions:[],settings:[],tasks:[]}` left
    // BOTH W-1 and this test green -- a mutation satisfied by both sides losing, in a helper two
    // suites share. The `not.toEqual` sees a gutted fingerprint, and the non-emptiness assertions
    // see one that is merely empty for this fixture.
    const before = await fingerprint();
    expect(before.revisions.length).toBeGreaterThan(0);
    expect(before.settings.length).toBeGreaterThan(0);
    expect(before.tasks.length).toBeGreaterThan(0);

    await updateSearchSettings(database.db, {
      mode: "MAXIMUM_PRICE",
      minimumDiscountPercent: null,
      maximumPriceCents: 61250,
      now: 1700000400,
    });

    expect(await claim()).toBe(3);
    expect(await fingerprint()).not.toEqual(before);
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
        monitoring: "running",
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
        monitoring: "running",
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
        monitoring: "running",
      },
    });
  });

  /**
   * W-m1: STOPPED HANDS THE COLLECTOR AN EMPTY LIST AND THE WORD THAT EXPLAINS IT. Paired on one
   * fixture: W-2's shape (targets present, `monitoring: "running"`) is the positive half, and here
   * the same two targets are withheld. Kills: ignoring the flag (the targets come back and the
   * collector searches through a Stop), and dropping the field (the collector reads an empty list
   * and exits 2 with degraded health).
   */
  it("W-m1: a stopped install answers targets:[] with monitoring:stopped, market kept", async () => {
    await seedMarket();
    await seedTarget("cpu-toronto", "cpu", "cpu");
    await seedTarget("gpu-toronto", "gpu", "graphics card");

    await expect(handleGetWatchTargets(database.db)).resolves.toMatchObject({
      body: { targets: [{ targetId: "cpu-toronto" }, { targetId: "gpu-toronto" }], monitoring: "running" },
    });

    await handleStopMonitoring(database.db, 1_800_000_000);

    await expect(handleGetWatchTargets(database.db)).resolves.toEqual({
      ok: true,
      status: 200,
      body: {
        market: { location: "toronto", latitude: 43.6532, longitude: -79.3832, radiusKm: 25 },
        targets: [],
        monitoring: "stopped",
      },
    });
  });

  /**
   * W-m2: A FAILED FLAG READ IS THE EXISTING 503, NOT A GUESS. Only `monitoring_state` throws here;
   * the market and the targets read fine. Kills: catching the flag read and defaulting to
   * running (a broken row would then never be able to stop anything, and nobody would be told).
   */
  it("W-m2: a monitoring_state read that throws is 503 WATCH_TARGETS_STORAGE_FAILED", async () => {
    await seedMarket();
    await seedTarget("gpu-toronto", "gpu", "graphics card");
    const real = database.db;
    const flagFails = {
      prepare: (sql: string) => {
        if (sql.includes("monitoring_state")) throw new Error("D1_ERROR: no such table: monitoring_state");
        return real.prepare(sql);
      },
    } as unknown as D1Database;

    await expect(handleGetWatchTargets(flagFails)).resolves.toEqual({
      ok: false,
      status: 503,
      code: "WATCH_TARGETS_STORAGE_FAILED",
    });
  });
});
