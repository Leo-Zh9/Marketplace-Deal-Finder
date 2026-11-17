// @vitest-environment node

/**
 * THE NOTIFY STEP'S CPU: p95 < 8 ms with 5 rows sent, under the 10 ms Workers Free step budget.
 *
 * Same method as worker/evaluation/evaluationCpu.test.ts, for the same reason: the Node test D1 is
 * a proxy whose every call is an HTTP round trip to workerd, machinery that does not exist in a
 * Worker. So the step runs ONCE against real D1 over a real fixture and the exact results D1
 * returned are captured; the timed samples replay those results through an in-process stub. What
 * is timed is everything the step does that is not waiting on D1 or Discord: the state check,
 * `invert`, SQL binding, the re-check mapping, message formatting and escaping, the payload JSON,
 * response classification.
 *
 * Measured with worker/testing/cpuClock.ts (consumed CPU, not wall time). These are Node numbers
 * on a development machine, not workerd -- the right kind of quantity on the wrong runtime.
 */

import { cpuMilliseconds } from "../testing/cpuClock";
import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";
import { TEST_ALLOWLIST } from "../testing/users";
import type { NotifyEnvironment } from "./config";
import { runNotify } from "./runNotify";

const T = 1_700_000_000;
const SOURCE = "facebook-marketplace";
const MARKET = "43.6532,-79.3832|25km";
const ON: NotifyEnvironment & { APPROVED_EMAILS: string } = {
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123456789/tok",
  NOTIFICATIONS: "on",
  APP_ENV: "production",
  APPROVED_EMAILS: TEST_ALLOWLIST,
};

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
  vi.spyOn(console, "log").mockImplementation(() => {});
});

/** Captured results, in call order, per SQL text. */
type Capture = Map<string, unknown[]>;

/** D1's own accounting, summed over every statement the real run made. */
const usage = { queries: 0, rowsRead: 0, rowsWritten: 0 };

const recordingDatabase = (real: D1Database, capture: Capture): D1Database => {
  const keep = (sql: string, result: unknown) => {
    const list = capture.get(sql) ?? [];
    list.push(result);
    capture.set(sql, list);
    const meta = (result as { meta?: { rows_read?: number; rows_written?: number } }).meta;
    usage.queries += 1;
    usage.rowsRead += meta?.rows_read ?? 0;
    usage.rowsWritten += meta?.rows_written ?? 0;
    return result;
  };
  return {
    prepare: (sql: string) => {
      const statement = real.prepare(sql);
      const wrap = (bound: D1PreparedStatement) => ({
        bind: (...args: unknown[]) => wrap(bound.bind(...args)),
        all: async () => keep(sql, await bound.all()),
        run: async () => keep(sql, await bound.run()),
      });
      return wrap(statement);
    },
  } as unknown as D1Database;
};

const replayDatabase = (capture: Capture) => {
  const cursor = new Map<string, number>();
  const db = {
    prepare: (sql: string) => {
      const statement = {
        bind: () => statement,
        all: () => next(sql),
        run: () => next(sql),
      };
      return statement;
    },
  } as unknown as D1Database;
  const next = (sql: string) => {
    const list = capture.get(sql) ?? [];
    const index = cursor.get(sql) ?? 0;
    cursor.set(sql, index + 1);
    return Promise.resolve(list[index]);
  };
  return { db, reset: () => cursor.clear() };
};

const percentile = (sorted: number[], fraction: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];

describe("notify CPU", () => {
  /**
   * THREE USERS (MAX_USERS), as the plan requires: the owner, whose step this is, and two more with
   * their own areas, rules and searches. PR2 sends for the owner only, so the others cost nothing
   * here but must not change what the owner's step does. The printed line carries D1's own
   * rows read / written for the step.
   */
  it("N17: p95 CPU of a 5-row notify step is under 8 ms, with three users", async () => {
    await db.batch([
      db.prepare(
        `INSERT INTO search_revisions (revision, mode, minimum_discount_percent, maximum_price_cents, created_at)
         VALUES (3, 'DISCOUNT', 20, NULL, 1)`,
      ),
      db.prepare("INSERT INTO search_settings (id, current_revision) VALUES (1, 3)"),
      db.prepare(
        `UPDATE users SET location = 'toronto', latitude = 43.6532, longitude = -79.3832,
                          radius_km = 25, mode = 'BOTH', minimum_discount_bp = 2000,
                          maximum_price_cents = 90000 WHERE user_id = 1`,
      ),
      db.prepare(
        `INSERT INTO users (user_id, email, location, latitude, longitude, radius_km, mode,
                            minimum_discount_bp, maximum_price_cents, monitoring_enabled,
                            monitoring_changed_at, created_at)
         VALUES (2, 'second@example.com', 'toronto', 43.6532, -79.3832, 10, 'DISCOUNT', 1500, NULL, 1, 0, 0),
                (3, 'third@example.com', 'waterloo', 43.4643, -80.5204, 25, 'MAXIMUM_PRICE', NULL, 50000, 1, 0, 0)`,
      ),
      db.prepare(
        `INSERT INTO user_watch_targets (user_id, target_id, component_type, query)
         VALUES (2, 'g', 'gpu', 'graphics card'), (3, 'c', 'cpu', 'cpu')`,
      ),
      // A full nine-target watch list, so `invert` does its real work.
      ...[
        ["cpu", "cpu"],
        ["gpu", "GeForce RTX 4070 Super"],
        ["gpu", "GeForce RTX 4070"],
        ["gpu", "GeForce RTX 5080"],
        ["ram", "ram"],
        ["storage", "ssd"],
        ["psu", "psu"],
        ["case", "pc case"],
        ["case_fan", "case fan"],
      ].map(([type, query], index) =>
        db
          .prepare(
            "INSERT INTO user_watch_targets (user_id, target_id, component_type, query) VALUES (1, ?1, ?2, ?3)",
          )
          .bind(`t${index}`, type, query),
      ),
      db
        .prepare(
          `INSERT INTO model_stats (market_key, model_key, variant_key, count, total_price_cents)
           VALUES (?1, 'GeForce RTX 4070 Super', '', 40, 2400000)`,
        )
        .bind(MARKET),
    ]);
    for (let index = 0; index < 5; index += 1) {
      const id = `90000000000000${index}`;
      await db.batch([
        db
          .prepare(
            `INSERT INTO listings (source, listing_id, market_key, component_type, model_key, variant_key,
                                   title, price_cents, location_text, url, validity, content_hash,
                                   first_seen_at, last_seen_at)
             VALUES (?1, ?2, ?3, 'gpu', 'GeForce RTX 4070 Super', '', ?4, 40000, ?5, 'u', 'VALID', 'h', ?6, ?6)`,
          )
          .bind(
            SOURCE,
            id,
            MARKET,
            // A worst-case title: full length, every escapable character, newlines.
            "[MSI](x) *RTX* 4070 Super_Ventus ~ | > ` # \\ \n".repeat(6),
            "Toronto\n> ON ".repeat(10),
            T - 7_000,
          ),
        db
          .prepare(
            `INSERT INTO evaluation_tasks (source, listing_id, status, created_at, evaluated_revision,
                                           verdict, evaluated_at, lease_expires_at, lease_token)
             VALUES (?1, ?2, 'COMPLETE', 1, 3, 'DEAL', ?3, 0, '')`,
          )
          .bind(SOURCE, id, T - index),
        db
          .prepare(
            `INSERT INTO listing_markets (market_key, source, listing_id, last_seen_at)
             VALUES (?1, ?2, ?3, 0), ('43.6532,-79.3832|10km', ?2, ?3, 0)`,
          )
          .bind(MARKET, SOURCE, id),
      ]);
    }

    const fetch = async () =>
      new Response('{"id":"1"}', { status: 200, headers: { "Content-Type": "application/json" } });

    const capture: Capture = new Map();
    const real = await runNotify(recordingDatabase(db, capture), {
      environment: ON,
      now: T,
      fetch,
      leaseTokenPrefix: "cpu",
    });
    expect(real).toMatchObject({ enqueued: 5, sent: 5, cancelled: 0 });
    console.warn(
      `notify step D1 (3 users, 5 sent): ${usage.queries} queries, ` +
        `${usage.rowsRead} rows read, ${usage.rowsWritten} rows written`,
    );
    // The plan's budget: well inside 50 subrequests.
    expect(usage.queries).toBeLessThanOrEqual(19);

    const replay = replayDatabase(capture);
    const sample = async () => {
      replay.reset();
      const start = cpuMilliseconds();
      await runNotify(replay.db, { environment: ON, now: T, fetch, leaseTokenPrefix: "cpu" });
      return cpuMilliseconds() - start;
    };

    for (let index = 0; index < 300; index += 1) await sample();
    const samples: number[] = [];
    for (let index = 0; index < 1_000; index += 1) samples.push(await sample());
    samples.sort((a, b) => a - b);

    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    const p99 = percentile(samples, 0.99);
    console.warn(
      `notify step CPU over ${samples.length} replayed samples (5 rows): ` +
        `p50 ${p50.toFixed(4)} ms, p95 ${p95.toFixed(4)} ms, p99 ${p99.toFixed(4)} ms, ` +
        `max ${samples[samples.length - 1].toFixed(4)} ms`,
    );

    expect(p95).toBeLessThan(8);
  });
});
