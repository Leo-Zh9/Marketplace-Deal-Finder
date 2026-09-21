// @vitest-environment node

/**
 * The run lock, against REAL D1 with the real migrations. Every statement under test is the
 * exported module constant or `releaseStatement`, never a hand-copied lookalike -- a copy
 * would not carry a mutation applied to the source.
 *
 * FIXTURE CORRELATION. No two parameters that reach the code under test share a value, and
 * none equals a default. The only default reachable from here is MONITOR_LOCK_SECONDS (1500),
 * so every fixture lease is 601 except the three tests whose subject IS a lease length (L9's
 * ceiling table and L7's guard), where the values are the measurement.
 *
 * THE ANCHOR THAT MATTERS HERE: "the lock was released" is satisfied by "it was never
 * acquired", and "the kill switch worked" is satisfied by "the table was empty". L6 asserts
 * `acquired_at` SURVIVES the release, and L10 asserts the NEXT RUN IS REFUSED rather than
 * merely that a statement ran.
 */

import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";
import {
  acquireMonitorLock,
  monitorLockHeld,
  releaseStatement,
  MONITOR_LOCK_SECONDS,
} from "./monitorLock";

/** Frozen and in the PAST, matching the rest of the suite. */
const T = 1_700_000_000;

/** ≠ MONITOR_LOCK_SECONDS (1500) and ≠ EVALUATION_LEASE_SECONDS (300). */
const LEASE = 601;

// The period of the monitoring cron, in seconds, as a literal. Importing MONITOR_CRON and
// parsing it would make this test agree with itself; scheduled.test.ts is what pins the cron
// string to wrangler.jsonc.
const CRON_PERIOD = 1800;

const A = "run-alpha";
const B = "run-bravo";

/**
 * The documented 3am kill switch, both forms, copied from docs/phase-3e-monitoring.md. If that
 * runbook changes, L10 is where the change has to be re-measured.
 */
const KILL_SWITCH_UPSERT = `INSERT INTO monitor_lock (id, run_id, acquired_at, expires_at)
VALUES (1, 'HOLD', unixepoch(), unixepoch() + 31536000)
ON CONFLICT(id) DO UPDATE SET run_id='HOLD', acquired_at=excluded.acquired_at,
                              expires_at=excluded.expires_at`;
const KILL_SWITCH_BARE_UPDATE = `UPDATE monitor_lock
   SET run_id='HOLD', acquired_at=unixepoch(), expires_at=unixepoch() + 31536000
 WHERE id = 1`;

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

const lockRow = async () =>
  (
    await db
      .prepare("SELECT id, run_id, acquired_at, expires_at FROM monitor_lock")
      .all<{ id: number; run_id: string; acquired_at: number; expires_at: number }>()
  ).results;

const acquire = (runId: string, now: number, lockSeconds = LEASE) =>
  acquireMonitorLock(db, { runId, now, lockSeconds });

describe("the monitoring run lock", () => {
  it("L1: the first acquire takes the lock and hands back the row it wrote", async () => {
    const result = await acquire(A, T);

    expect(result.acquired).toBe(true);
    // The HOLDER, not just a boolean: RETURNING is what makes the incumbent row available for
    // telemetry in one round trip, and dropping it makes `holder` permanently null.
    expect(result.holder).toEqual({ runId: A, acquiredAt: T, expiresAt: T + LEASE });
    // The two lease columns are bound SEPARATELY, so swapping them is a real mutation.
    expect(await lockRow()).toEqual([
      { id: 1, run_id: A, acquired_at: T, expires_at: T + LEASE },
    ]);
  });

  it("L2: a different run cannot take an unexpired lock, and changes nothing", async () => {
    await acquire(A, T);

    const contender = await acquire(B, T + 1);

    expect({ acquired: contender.acquired, holder: contender.holder }).toEqual({
      acquired: false,
      holder: null,
    });
    expect(await lockRow()).toEqual([
      { id: 1, run_id: A, acquired_at: T, expires_at: T + LEASE },
    ]);
  });

  it("L3: the SAME run re-acquires its own unexpired lock", async () => {
    await acquire(A, T);

    // A step body that threw and was retried, an instance replayed from a later step, and a
    // platform redelivery all land here. Without `OR monitor_lock.run_id = ?1` this returns
    // false and a HEALTHY RUN is permanently converted to a no-op.
    const again = await acquire(A, T + 2);

    expect(again.acquired).toBe(true);
    expect(again.holder).toEqual({ runId: A, acquiredAt: T + 2, expiresAt: T + 2 + LEASE });
  });

  it("L4: the expiry boundary is INCLUSIVE -- exactly at expires_at the lock is takeable", async () => {
    await acquire(A, T);

    // One second before: refused.
    expect((await acquire(B, T + LEASE - 1)).acquired).toBe(false);
    // Exactly at expires_at: taken. `<=` -> `<` flips this cell and nothing else.
    const atExpiry = await acquire(B, T + LEASE);
    expect(atExpiry.acquired).toBe(true);
    expect(atExpiry.holder).toEqual({
      runId: B,
      acquiredAt: T + LEASE,
      expiresAt: T + LEASE + LEASE,
    });
  });

  it("L5: a zombie's release leaves the live holder byte-intact", async () => {
    await acquire(A, T);
    await acquire(B, T + LEASE);

    // A's lease lapsed and B took the lock. A wakes up and releases: unfenced this reports
    // changes 1 and wipes B's row while B is still working.
    const zombie = await releaseStatement(db, A).run();

    expect(zombie.meta.changes).toBe(0);
    expect(await lockRow()).toEqual([
      { id: 1, run_id: B, acquired_at: T + LEASE, expires_at: T + LEASE + LEASE },
    ]);
  });

  it("L6: a real release frees the lock and LEAVES acquired_at intact", async () => {
    await acquire(A, T);

    const released = await releaseStatement(db, A).run();

    expect(released.meta.changes).toBe(1);
    // acquired_at surviving is the whole anchor: `run_id=''` alone is equally satisfied by a
    // lock that was never taken.
    expect(await lockRow()).toEqual([{ id: 1, run_id: "", acquired_at: T, expires_at: 0 }]);
    // ...and the freed lock is takeable by anyone, at the same instant.
    expect((await acquire(B, T)).acquired).toBe(true);
  });

  it("L7: lockSeconds must be a safe integer >= 1, and a rejection writes nothing", async () => {
    // 0 is the dangerous one: the lease is exactly `now`, so a second run at the SAME `now`
    // satisfies `expires_at <= ?2` and steals the lock immediately.
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(acquire(A, T, bad)).rejects.toThrow(/lockSeconds/);
    }
    // The seed row, untouched.
    expect(await lockRow()).toEqual([{ id: 1, run_id: "", acquired_at: 0, expires_at: 0 }]);

    // A boundary, not a blanket refusal: 1 is legal and so is the fixture lease.
    expect((await acquire(A, T, 1)).acquired).toBe(true);
    expect((await acquire(A, T + 1, LEASE)).holder?.expiresAt).toBe(T + 1 + LEASE);
  });

  it("L8: the fence answers for the holder and only the holder", async () => {
    await acquire(A, T);

    expect(await monitorLockHeld(db, A)).toBe(true);
    expect(await monitorLockHeld(db, B)).toBe(false);

    // Stolen after the lease lapsed: the old holder's fence must now say false, which is what
    // gives LOCK_LOST somewhere to be reported.
    await acquire(B, T + LEASE);
    expect(await monitorLockHeld(db, A)).toBe(false);
    expect(await monitorLockHeld(db, B)).toBe(true);
  });

  it("L9: the lease ceiling is the cron period, inclusive -- so 1500 costs no skipped fire", async () => {
    const displaced = async (lease: number) => {
      await truncateAll(db);
      // A run that acquired at T and then crashed: nothing releases it.
      await acquire("run-crashed", T, lease);
      return (await acquire("run-next", T + CRON_PERIOD, LEASE)).acquired;
    };

    // The whole interval (0, 1800] costs ZERO skipped fires; 1801 costs one.
    expect({
      900: await displaced(900),
      1500: await displaced(1500),
      1799: await displaced(1799),
      1800: await displaced(CRON_PERIOD),
      1801: await displaced(CRON_PERIOD + 1),
      2000: await displaced(2000),
    }).toEqual({
      900: true,
      1500: true,
      1799: true,
      1800: true,
      1801: false,
      2000: false,
    });

    // The constant itself, BEHAVIOURALLY and with an oracle rather than mirrored to itself:
    // a crashed run holding the shipped lease must not survive the next fire.
    expect(await displaced(MONITOR_LOCK_SECONDS)).toBe(true);
  });

  it("L10: the kill switch must be an UPSERT -- a bare UPDATE is a silent no-op when it matters", async () => {
    // The window finding 7 names: DEPLOYED, CRON ENABLED, FIRST RUN NOT YET FIRED. 0004 seeds
    // the row so this state does not exist in production -- schema.test.ts pins the seed -- and
    // this test is what says why the seed is there.
    const emptyLockTable = async () => {
      await truncateAll(db);
      await db.prepare("DELETE FROM monitor_lock").run();
    };

    await emptyLockTable();
    const bare = await db.prepare(KILL_SWITCH_BARE_UPDATE).run();
    expect(bare.meta.changes).toBe(0);
    expect(await lockRow()).toEqual([]);
    // `wrangler d1 execute` does not print `changes`, so the operator reads that as success --
    // and the very next fire runs anyway.
    expect((await acquire(A, T)).acquired).toBe(true);

    await emptyLockTable();
    const upsert = await db.prepare(KILL_SWITCH_UPSERT).run();
    expect(upsert.meta.changes).toBe(1);
    expect((await lockRow())[0].run_id).toBe("HOLD");
    expect((await acquire(A, T)).acquired).toBe(false);

    // And it is reversible, which is the other half of a kill switch.
    await db.prepare("UPDATE monitor_lock SET expires_at=0, run_id='' WHERE id=1").run();
    expect((await acquire(A, T)).acquired).toBe(true);
  });
});
