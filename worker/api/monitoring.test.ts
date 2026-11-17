// @vitest-environment node

import { updateSearchSettings } from "../search/settings";
import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";
import type { CollectorStatusBody } from "./collectorHealth";
import {
  applyMonitoring,
  handleStartMonitoring,
  handleStopMonitoring,
  loadMonitoringState,
  readMonitoring,
} from "./monitoring";

/**
 * The Start/Stop row, against real D1 with the real migrations. Three instants, none equal to the
 * seed's 0 and none equal to each other, so a handler that wrote the wrong one fails by value.
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

const row = async () =>
  (
    await db
      .prepare("SELECT id, enabled, changed_at FROM monitoring_state")
      .all<{ id: number; enabled: number; changed_at: number }>()
  ).results;

const saveRule = () =>
  updateSearchSettings(db, {
    mode: "DISCOUNT",
    minimumDiscountPercent: 21.5,
    maximumPriceCents: null,
    now: T1,
  });

/** Any touch throws, as a D1 outage does. */
const throwing = {
  prepare: () => {
    throw new Error("D1_ERROR: storage unavailable");
  },
} as unknown as D1Database;

describe("the monitoring state row", () => {
  /**
   * M-1. Stop writes 0 at `now`; a second Stop KEEPS the first instant; Start flips it back with a
   * new one. Kills: the CASE in the UPSERT (a second Stop would move "Stopped at" to T2), and
   * swapping the two handlers' `enabled` literals.
   */
  it("M-1: stop then start round-trips, and a repeated stop keeps its first instant", async () => {
    await saveRule();

    await expect(handleStopMonitoring(db, T1)).resolves.toEqual({
      ok: true,
      status: 200,
      body: { monitoring: { state: "stopped", changedAt: T1 } },
    });
    await expect(handleStopMonitoring(db, T2)).resolves.toEqual({
      ok: true,
      status: 200,
      body: { monitoring: { state: "stopped", changedAt: T1 } },
    });
    expect(await row()).toEqual([{ id: 1, enabled: 0, changed_at: T1 }]);

    await expect(handleStartMonitoring(db, T3)).resolves.toEqual({
      ok: true,
      status: 200,
      body: { monitoring: { state: "running", changedAt: T3 } },
    });
    expect(await row()).toEqual([{ id: 1, enabled: 1, changed_at: T3 }]);
  });

  /**
   * M-2. A Start on an already-running install is a no-op that keeps the seed's 0. The positive
   * half of M-1's idempotence on the other value.
   */
  it("M-2: start while running changes nothing, not even changed_at", async () => {
    await saveRule();

    await expect(handleStartMonitoring(db, T2)).resolves.toEqual({
      ok: true,
      status: 200,
      body: { monitoring: { state: "running", changedAt: 0 } },
    });
    expect(await row()).toEqual([{ id: 1, enabled: 1, changed_at: 0 }]);
  });

  /**
   * M-3. NO DEAL RULE, NO START, AND THE ROW IS UNTOUCHED. Paired on one fixture: the same Start
   * succeeds once a rule exists, so a handler that always refused fails the second half. Kills:
   * dropping the settings check (the first half answers 200 running).
   */
  it("M-3: start with no saved rule is 409 MONITORING_NOT_READY and leaves the row stopped", async () => {
    await handleStopMonitoring(db, T1);

    await expect(handleStartMonitoring(db, T2)).resolves.toEqual({
      ok: false,
      status: 409,
      code: "MONITORING_NOT_READY",
    });
    expect(await row()).toEqual([{ id: 1, enabled: 0, changed_at: T1 }]);

    await saveRule();
    await expect(handleStartMonitoring(db, T3)).resolves.toMatchObject({
      ok: true,
      body: { monitoring: { state: "running", changedAt: T3 } },
    });
  });

  /** M-4. A failed read or write is 503 with its own code, on both routes. */
  it("M-4: a D1 that throws is 503 MONITORING_STORAGE_FAILED on start and on stop", async () => {
    for (const handler of [handleStartMonitoring, handleStopMonitoring]) {
      await expect(handler(throwing, T1)).resolves.toEqual({
        ok: false,
        status: 503,
        code: "MONITORING_STORAGE_FAILED",
      });
    }
  });

  /**
   * M-5. AN ABSENT ROW IS RUNNING. A hand-deleted row must not stop collection silently, and the
   * UPSERT recreates it. Kills: reading an absent row as stopped.
   */
  it("M-5: an absent row reads as running, and stop recreates it", async () => {
    await db.prepare("DELETE FROM monitoring_state").run();

    expect((await loadMonitoringState(db)).monitoring).toEqual({ state: "running", changedAt: 0 });
    expect(await readMonitoring(db)).toEqual({ state: "running", changedAt: 0 });

    await handleStopMonitoring(db, T2);
    expect(await row()).toEqual([{ id: 1, enabled: 0, changed_at: T2 }]);
  });

  /**
   * M-6. THE TWO READS DIFFER ONLY ON FAILURE. `loadMonitoringState` throws (runMonitor and the
   * watch-targets 503 depend on it), `readMonitoring` answers null (the status route depends on
   * that), and a missing binding is null too.
   */
  it("M-6: loadMonitoringState throws on a failed read; readMonitoring answers null", async () => {
    await expect(loadMonitoringState(throwing)).rejects.toThrow(/storage unavailable/);
    await expect(readMonitoring(throwing)).resolves.toBeNull();
    await expect(readMonitoring(undefined)).resolves.toBeNull();

    await handleStopMonitoring(db, T1);
    const loaded = await loadMonitoringState(db);
    expect(loaded.monitoring).toEqual({ state: "stopped", changedAt: T1 });
    // A real read, counted: runMonitor spends this.
    expect(loaded.usage.rowsRead).toBe(1);
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
