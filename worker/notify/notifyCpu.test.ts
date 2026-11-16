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
import type { NotifyEnvironment } from "./config";
import { runNotify } from "./runNotify";

const T = 1_700_000_000;
const SOURCE = "facebook-marketplace";
const MARKET = "43.6532,-79.3832|25km";
const ON: NotifyEnvironment = {
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123456789/tok",
  NOTIFICATIONS: "on",
  APP_ENV: "production",
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

const recordingDatabase = (real: D1Database, capture: Capture): D1Database => {
  const keep = (sql: string, result: unknown) => {
    const list = capture.get(sql) ?? [];
    list.push(result);
    capture.set(sql, list);
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
  it("N17: p95 CPU of a 5-row notify step is under 8 ms", async () => {
    await db.batch([
      db.prepare(
        `INSERT INTO search_revisions (revision, mode, minimum_discount_percent, maximum_price_cents, created_at)
         VALUES (3, 'BOTH', 20, 90000, 1)`,
      ),
      db.prepare("INSERT INTO search_settings (id, current_revision) VALUES (1, 3)"),
      db.prepare(
        `INSERT INTO watch_market (id, location, latitude, longitude, radius_km)
         VALUES (1, 'toronto', 43.6532, -79.3832, 25)`,
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
          .prepare("INSERT INTO watch_targets (target_id, component_type, query) VALUES (?1, ?2, ?3)")
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
