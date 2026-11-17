// @vitest-environment node

import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";
import { addUser, owner, setRule } from "../testing/users";
import type { CollectorStatusBody } from "./collectorHealth";
import {
  applyMonitoring,
  handleStartMonitoring,
  handleStopMonitoring,
  monitoringOf,
} from "./monitoring";

/**
 * Per-user Start/Stop (migrations/0009: `users.monitoring_enabled`), against real D1 with the real
 * migrations. Three instants, none equal to the seed's 0 and none equal to each other, so a handler
 * that wrote the wrong one fails by value.
 */
const T1 = 1_800_000_101;
const T2 = 1_800_000_307;
const T3 = 1_800_000_503;

let database!: TestDatabase;
let db!: D1Database;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
}, 120_000);

afterAll(async () => {
  await database.dispose();
});

beforeEach(async () => {
  await truncateAll(db);
});

const row = async (userId = 1) =>
  (
    await db
      .prepare("SELECT user_id, monitoring_enabled, monitoring_changed_at FROM users WHERE user_id = ?1")
      .bind(userId)
      .all<{ user_id: number; monitoring_enabled: number; monitoring_changed_at: number }>()
  ).results;

const saveRule = (userId = 1) => setRule(db, { mode: "DISCOUNT", bp: 2150 }, userId);

/** Any touch throws, as a D1 outage does. */
const throwing = {
  prepare: () => {
    throw new Error("D1_ERROR: storage unavailable");
  },
} as unknown as D1Database;

describe("the per-user monitoring flag", () => {
  /**
   * M-1. Stop writes 0 at `now`; a second Stop KEEPS the first instant; Start flips it back with a
   * new one. Kills: the CASE in SET_ENABLED (a second Stop would move "Stopped at" to T2), and
   * swapping the two handlers' `enabled` literals.
   */
  it("M-1: stop then start round-trips, and a repeated stop keeps its first instant", async () => {
    await saveRule();

    await expect(handleStopMonitoring(db, await owner(db), T1)).resolves.toEqual({
      ok: true,
      status: 200,
      body: { monitoring: { state: "stopped", changedAt: T1 } },
    });
    await expect(handleStopMonitoring(db, await owner(db), T2)).resolves.toEqual({
      ok: true,
      status: 200,
      body: { monitoring: { state: "stopped", changedAt: T1 } },
    });
    expect(await row()).toEqual([{ user_id: 1, monitoring_enabled: 0, monitoring_changed_at: T1 }]);

    await expect(handleStartMonitoring(db, await owner(db), T3)).resolves.toEqual({
      ok: true,
      status: 200,
      body: { monitoring: { state: "running", changedAt: T3 } },
    });
    expect(await row()).toEqual([{ user_id: 1, monitoring_enabled: 1, monitoring_changed_at: T3 }]);
  });

  /** M-2. A Start on an already-running user is a no-op that keeps the seed's 0. */
  it("M-2: start while running changes nothing, not even changed_at", async () => {
    await saveRule();

    await expect(handleStartMonitoring(db, await owner(db), T2)).resolves.toEqual({
      ok: true,
      status: 200,
      body: { monitoring: { state: "running", changedAt: 0 } },
    });
    expect(await row()).toEqual([{ user_id: 1, monitoring_enabled: 1, monitoring_changed_at: 0 }]);
  });

  /**
   * M-3. NO DEAL RULE OF YOUR OWN, NO START, AND THE ROW IS UNTOUCHED. Paired on one fixture: the
   * same Start succeeds once the caller has a rule. Kills: dropping the rule check.
   */
  it("M-3: start with no saved rule is 409 MONITORING_NOT_READY and leaves the row stopped", async () => {
    await handleStopMonitoring(db, await owner(db), T1);

    await expect(handleStartMonitoring(db, await owner(db), T2)).resolves.toEqual({
      ok: false,
      status: 409,
      code: "MONITORING_NOT_READY",
    });
    expect(await row()).toEqual([{ user_id: 1, monitoring_enabled: 0, monitoring_changed_at: T1 }]);

    await saveRule();
    await expect(handleStartMonitoring(db, await owner(db), T3)).resolves.toMatchObject({
      ok: true,
      body: { monitoring: { state: "running", changedAt: T3 } },
    });
  });

  /** M-4. A failed write is 503 with its own code, on both routes. */
  it("M-4: a D1 that throws is 503 MONITORING_STORAGE_FAILED on start and on stop", async () => {
    await saveRule();
    const user = await owner(db);
    for (const handler of [handleStartMonitoring, handleStopMonitoring]) {
      await expect(handler(throwing, user, T1)).resolves.toEqual({
        ok: false,
        status: 503,
        code: "MONITORING_STORAGE_FAILED",
      });
    }
  });

  /**
   * M-5. SCOPED TO THE CALLER. A second user's Stop leaves user 1 running, and user 1's Start leaves
   * the second user stopped. Mutation: dropping `WHERE user_id = ?3` from SET_ENABLED.
   */
  it("M-5: one user's Stop and Start touch only their own row", async () => {
    await addUser(db, 2, "second@example.com", true);
    await saveRule(2);
    await handleStopMonitoring(db, await owner(db, 2), T1);
    expect(await row(1)).toEqual([{ user_id: 1, monitoring_enabled: 1, monitoring_changed_at: 0 }]);
    expect(await row(2)).toEqual([{ user_id: 2, monitoring_enabled: 0, monitoring_changed_at: T1 }]);

    await saveRule(1);
    await handleStopMonitoring(db, await owner(db), T2);
    await handleStartMonitoring(db, await owner(db), T3);
    expect(await row(2)).toEqual([{ user_id: 2, monitoring_enabled: 0, monitoring_changed_at: T1 }]);
  });

  /** M-6. The status read is the row provisioning already loaded: no query of its own. */
  it("M-6: monitoringOf reads the caller's loaded row", async () => {
    await handleStopMonitoring(db, await owner(db), T1);
    expect(monitoringOf(await owner(db))).toEqual({ state: "stopped", changedAt: T1 });
  });
});

describe("applyMonitoring", () => {
  const degraded: CollectorStatusBody = {
    status: "degraded",
    causes: ["exit-code:6", "fixture"],
    reportedAt: 1_799_990_000,
    ageMinutes: 167,
    collector: {
      exitCode: 6,
      complete: false,
      canary: false,
      dryRun: false,
      fixture: true,
      targets: 3,
      alarms: [],
    },
  };

  /**
   * M-7. STOPPED REPLACES THE WORD AND CLEARS THE CAUSES, AND KEEPS EVERYTHING ELSE. Kills: leaving
   * the causes (the page would list faults of a run the operator has paused), and dropping
   * `reportedAt`/`collector` (the page could no longer say when the last run was).
   */
  it("M-7: stopped overrides status and causes and keeps the timestamp and the collector", () => {
    const monitoring = { state: "stopped", changedAt: 1_799_995_000 } as const;

    expect(applyMonitoring(degraded, monitoring)).toEqual({
      status: "stopped",
      causes: [],
      reportedAt: 1_799_990_000,
      ageMinutes: 167,
      collector: degraded.collector,
      monitoring,
    });
  });

  /**
   * M-9. STOPPED KEEPS `status-unreadable`, AND ONLY THAT. Kills: clearing every cause, under which
   * a stopped collector whose health read failed reads "Stopped" beside the false "No collector
   * run has reported yet". `exit-code:1` rides along to prove the other causes still clear.
   */
  it("M-9: stopped keeps status-unreadable and clears every other cause", () => {
    const monitoring = { state: "stopped", changedAt: 1_799_995_000 } as const;
    const unreadable: CollectorStatusBody = {
      status: "unknown",
      causes: ["status-unreadable", "exit-code:1"],
      reportedAt: 0,
      ageMinutes: 0,
      collector: null,
    };

    expect(applyMonitoring(unreadable, monitoring)).toEqual({
      status: "stopped",
      causes: ["status-unreadable"],
      reportedAt: 0,
      ageMinutes: 0,
      collector: null,
      monitoring,
    });
  });

  /** M-8. Running and unknown (null) override nothing; they only add the field. */
  it("M-8: running and a failed read leave the health body as it was", () => {
    const running = { state: "running", changedAt: 0 } as const;

    expect(applyMonitoring(degraded, running)).toEqual({ ...degraded, monitoring: running });
    expect(applyMonitoring(degraded, null)).toEqual({ ...degraded, monitoring: null });
  });
});
