// @vitest-environment node

import { updateSearchSettings } from "../search/settings";
import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";
import {
  claim as claimTasks,
  fingerprint as fingerprintOf,
  seedEvaluationCorpus as seedCorpus,
} from "../testing/evaluationFingerprint";
import { addTarget, addUser, setArea, setMonitoring, TEST_ALLOWLIST } from "../testing/users";
import { handleGetWatchTargets } from "./watchTargets";
import { readFileSync } from "node:fs";

/** The environment every production read sees: the owner and the two extra test users approved. */
const ENV = { APP_ENV: "production", APPROVED_EMAILS: TEST_ALLOWLIST };
const read = (db: D1Database = database.db, environment: Record<string, string | undefined> = ENV) =>
  handleGetWatchTargets(db, environment);

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

const TORONTO = { location: "toronto", latitude: 43.6532, longitude: -79.3832, radiusKm: 25 };
const WATERLOO = { location: "waterloo", latitude: 43.4643, longitude: -80.5204, radiusKm: 25 };

const seedMarket = (
  overrides: Partial<{
    location: string;
    latitude: number;
    longitude: number;
    radiusKm: number;
  }> = {},
  userId = 1,
) => setArea(database.db, { ...TORONTO, ...overrides }, userId);

const seedTarget = (targetId: string, componentType: string, query: string, userId = 1) =>
  addTarget(database.db, targetId, componentType, query, userId);

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

    const first = await read();
    expect(first.ok).toBe(true);

    // ...and a WRITE to each table, of every kind, not merely a read.
    await seedTarget("ram-toronto", "ram", "ddr5 ram");
    await database.db
      .prepare("UPDATE user_watch_targets SET query = 'gpu' WHERE target_id = 'gpu-toronto'")
      .run();
    await database.db.prepare("DELETE FROM user_watch_targets WHERE target_id = 'cpu-toronto'").run();
    await database.db.prepare("UPDATE users SET radius_km = 12 WHERE user_id = 1").run();
    await setArea(database.db, null);
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

  it("W-2: targets come back ordered by wire id, camelCase, each with its own market", async () => {
    await seedMarket({ location: "new-york", latitude: 40.7128, longitude: -74.006, radiusKm: 18 });
    // Inserted in an order that is NOT the answer, so the sort is what orders them.
    await seedTarget("gpu-toronto", "gpu", "graphics card");
    await seedTarget("cpu-toronto", "cpu", "cpu");
    await seedTarget("ram-toronto", "ram", "ddr5 ram");

    const market = { location: "new-york", latitude: 40.7128, longitude: -74.006, radiusKm: 18 };
    expect(await read()).toEqual({
      ok: true,
      status: 200,
      body: {
        market,
        targets: [
          { targetId: "cpu-cpu@new-york-18", componentType: "cpu", query: "cpu", market },
          { targetId: "gpu-graphics-card@new-york-18", componentType: "gpu", query: "graphics card", market },
          { targetId: "ram-ddr5-ram@new-york-18", componentType: "ram", query: "ddr5 ram", market },
        ],
        monitoring: "running",
      },
    });
  });

  /**
   * W-3: A STORAGE OUTAGE IS 503, NEVER AN EMPTY WATCH LIST. Swallowing the throw would make an
   * outage read to the collector as "there is nothing to hunt".
   */
  it("W-3: a D1 that rejects is 503 WATCH_TARGETS_STORAGE_FAILED", async () => {
    const throwing = {
      prepare: () => {
        throw new Error("D1_ERROR: no such table");
      },
    } as unknown as D1Database;

    await expect(read(throwing)).resolves.toEqual({
      ok: false,
      status: 503,
      code: "WATCH_TARGETS_STORAGE_FAILED",
    });
  });

  it("W-4: an active user with an empty watch list is 200 running with no targets", async () => {
    await seedMarket();
    await expect(read()).resolves.toEqual({
      ok: true,
      status: 200,
      body: { market: null, targets: [], monitoring: "running" },
    });
  });

  /**
   * W-5: A USER WITH NO AREA SENDS NOTHING, AND NO MARKET IS INVENTED for their rows. Inventing one
   * would collect into the wrong area silently.
   */
  it("W-5: a user with no area contributes no target", async () => {
    await seedTarget("gpu-toronto", "gpu", "graphics card");
    await expect(read()).resolves.toEqual({
      ok: true,
      status: 200,
      body: { market: null, targets: [], monitoring: "running" },
    });
  });

  /**
   * W-m1: "stopped" ONLY WHEN NO USER IS ACTIVE, with an empty list. Paired: running first. Kills:
   * ignoring the flag (the collector searches through a Stop), and answering "stopped" while
   * another user is still active.
   */
  it("W-m1: stopped only when no user is active", async () => {
    await seedMarket();
    await seedTarget("gpu-toronto", "gpu", "graphics card");
    await addUser(database.db, 2, "second@example.com", true);
    await seedMarket(WATERLOO, 2);
    await seedTarget("gpu-rtx", "gpu", "rtx", 2);

    await setMonitoring(database.db, false, 1);
    const one = await read();
    expect(one).toMatchObject({ body: { monitoring: "running" } });
    expect(one.ok && one.body.targets.map((target) => target.targetId)).toEqual(["gpu-rtx@waterloo-25"]);

    await setMonitoring(database.db, false, 2);
    await expect(read()).resolves.toEqual({
      ok: true,
      status: 200,
      body: { market: null, targets: [], monitoring: "stopped" },
    });
  });

  /**
   * W-allow: ACTIVE MEANS ALLOWLISTED TOO. A Started second user who was removed from
   * APPROVED_EMAILS collects nothing; with nobody else active the answer is "stopped".
   */
  it("W-allow: a Started user missing from the allowlist contributes nothing", async () => {
    await setMonitoring(database.db, false, 1);
    await addUser(database.db, 2, "removed@example.com", true);
    await seedMarket(TORONTO, 2);
    await seedTarget("gpu-toronto", "gpu", "graphics card", 2);
    await expect(read()).resolves.toEqual({
      ok: true,
      status: 200,
      body: { market: null, targets: [], monitoring: "stopped" },
    });
  });

  /**
   * W-owner: AN UNCLAIMED OR MIS-CLAIMED OWNER IS 503 OWNER_UNCLAIMED, NEVER "STOPPED". Read as
   * "nobody is active" it would make the collector exit 0 every run and collect nothing, silently --
   * an operator typo in the claim would look like a quiet week. Kills: dropping the owner check.
   */
  it("W-owner: user 1 unclaimed, absent from the allowlist, or missing is 503 OWNER_UNCLAIMED", async () => {
    await seedMarket();
    await seedTarget("gpu-toronto", "gpu", "graphics card");
    const refused = { ok: false, status: 503, code: "OWNER_UNCLAIMED" };
    const typo = { APP_ENV: "production", APPROVED_EMAILS: JSON.stringify(["0wner@example.com"]) };
    await expect(read(database.db, typo)).resolves.toEqual(refused);
    await database.db.prepare("UPDATE users SET email = NULL WHERE user_id = 1").run();
    await expect(read()).resolves.toEqual(refused);
    // A Stopped but claimed owner is fine: that is an ordinary Stop.
    await database.db.prepare("UPDATE users SET email = 'owner@example.com' WHERE user_id = 1").run();
    await setMonitoring(database.db, false, 1);
    await expect(read()).resolves.toMatchObject({ ok: true, body: { monitoring: "stopped" } });
  });

  /**
   * W-allow-throw: AN UNUSABLE ALLOWLIST IS A 503, NEVER "ZERO USERS, STOPPED" -- which would
   * silently stop everyone's collection. Under APP_ENV=local an UNSET allowlist is the documented
   * local setup and `@localhost` users are active.
   */
  it("W-allow-throw: a missing or malformed allowlist is 503; local + unset approves @localhost", async () => {
    await seedMarket();
    await seedTarget("gpu-toronto", "gpu", "graphics card");
    await expect(read(database.db, { APP_ENV: "production" })).resolves.toEqual({
      ok: false,
      status: 503,
      code: "AUTH_CONFIG_MISSING",
    });
    await expect(read(database.db, { APP_ENV: "production", APPROVED_EMAILS: "[oops" })).resolves.toEqual({
      ok: false,
      status: 503,
      code: "AUTH_CONFIG_INVALID",
    });
    await expect(read(database.db, { APP_ENV: "local", APPROVED_EMAILS: "[oops" })).resolves.toMatchObject({
      status: 503,
    });

    await database.db.prepare("UPDATE users SET email = 'local-dev@localhost' WHERE user_id = 1").run();
    await expect(read(database.db, { APP_ENV: "local" })).resolves.toMatchObject({
      body: { monitoring: "running", targets: [{ targetId: "gpu-graphics-card@toronto-25" }] },
    });
    // ...and a production Worker never treats @localhost as approved: the owner reads as unclaimed.
    await expect(
      read(database.db, { APP_ENV: "production", APPROVED_EMAILS: TEST_ALLOWLIST }),
    ).resolves.toMatchObject({ status: 503, code: "OWNER_UNCLAIMED" });
  });

  /**
   * W-union: THE DE-DUPLICATED UNION, PER-TARGET MARKETS, AND ONE ID PER FACEBOOK REQUEST.
   *
   *   - Two users in the SAME area with the same search: one target (the cap counts it once).
   *   - The same query in TWO areas: two targets with two DISTINCT ids -- the collector keys its
   *     guard state on targetId (collector/runTargets.ts), so a shared id would merge two requests.
   *   - Every row carries its own `market`; the top-level `market` is null once there are two.
   */
  it("W-union: overlap de-dupes, two areas give two distinct ids, every row has its market", async () => {
    await seedMarket();
    await seedTarget("gpu-graphics-card", "gpu", "graphics card");
    await addUser(database.db, 2, "second@example.com", true);
    await seedMarket(TORONTO, 2);
    await seedTarget("mine", "gpu", "graphics card", 2);

    const shared = await read();
    expect(shared).toEqual({
      ok: true,
      status: 200,
      body: {
        market: TORONTO,
        targets: [
          {
            targetId: "gpu-graphics-card@toronto-25",
            componentType: "gpu",
            query: "graphics card",
            market: TORONTO,
          },
        ],
        monitoring: "running",
      },
    });

    await seedMarket(WATERLOO, 2);
    const split = await read();
    expect(split).toEqual({
      ok: true,
      status: 200,
      body: {
        market: null,
        targets: [
          {
            targetId: "gpu-graphics-card@toronto-25",
            componentType: "gpu",
            query: "graphics card",
            market: TORONTO,
          },
          {
            targetId: "gpu-graphics-card@waterloo-25",
            componentType: "gpu",
            query: "graphics card",
            market: WATERLOO,
          },
        ],
        monitoring: "running",
      },
    });
    if (!split.ok) throw new Error("unreachable");
    // NEVER A MIXED WIRE: every row names its own market.
    expect(split.body.targets.every((target) => target.market !== undefined)).toBe(true);
    expect(new Set(split.body.targets.map((target) => target.targetId)).size).toBe(2);
  });

  /** W-slug: two distinct searches that slug alike still get two distinct, deterministic ids. */
  it("W-slug: a slug collision is suffixed, never merged", async () => {
    await seedMarket();
    await seedTarget("a", "gpu", "RTX");
    await seedTarget("b", "gpu", "rtx");
    const result = await read();
    expect(result.ok && result.body.targets.map((target) => [target.targetId, target.query])).toEqual([
      ["gpu-rtx@toronto-25", "RTX"],
      ["gpu-rtx@toronto-25~2", "rtx"],
    ]);
  });

  /**
   * W-contract: THE COLLECTOR'S OWN FIXTURE IS WHAT THIS WORKER SENDS. PR1 pinned the per-target
   * wire in `collector/testing/fixtures/watchTargetsPerTargetMarket.json` and runs it through the real
   * collector loop (runTargets.test.ts M-1). The same three searches seeded here -- two users,
   * Toronto 25 km and Hamilton 20 km -- must come back byte-for-byte as that fixture, so the two
   * sides cannot drift apart.
   */
  it("W-contract: two users' searches serialise to the collector's per-target fixture", async () => {
    await seedMarket();
    await seedTarget("cpu-toronto", "cpu", "cpu");
    await seedTarget("gpu-toronto", "gpu", "graphics card");
    await addUser(database.db, 2, "second@example.com", true);
    await seedMarket({ location: "hamilton", latitude: 43.2557, longitude: -79.8711, radiusKm: 20 }, 2);
    await seedTarget("mine", "gpu", "graphics card", 2);

    const fixture: unknown = JSON.parse(
      readFileSync(new URL("../../collector/testing/fixtures/watchTargetsPerTargetMarket.json", import.meta.url), "utf8"),
    );
    const result = await read();
    expect(result.ok && result.body).toEqual(fixture);
  });
});
