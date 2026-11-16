// @vitest-environment node

/**
 * THE NOTIFY STEP AGAINST REAL D1. Real migrations, the real enqueue / claim / recheck / write
 * SQL, the real `evaluateBatch` where a test needs a verdict to change. Only Discord is faked: a
 * scripted `fetch` that records every request and answers from a list.
 *
 * EVERY TEST NAMES THE MUTATION IT KILLS. Each was applied to the source for real, observed red,
 * restored, and observed green; the PR body carries the table.
 */

import { evaluateBatch } from "../evaluation/evaluateBatch";
import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";
import type { NotifyEnvironment } from "./config";
import { NOTIFY_FRESH_SECONDS } from "./enqueue";
import { runNotify, WRITE_RESULT, type NotifyCounts } from "./runNotify";
import { readNotificationsStatus } from "./status";
import { NOTIFY_LEASE_SECONDS } from "./sweep";

const T = 1_700_000_000;
const SOURCE = "facebook-marketplace";
const MARKET = "43.6532,-79.3832|25km";
const REVISION = 11;
const MODEL = "GeForce RTX 4070 Super";
const WEBHOOK = "https://discord.com/api/webhooks/123456789/tok-en_X";
const ON: NotifyEnvironment = {
  DISCORD_WEBHOOK_URL: WEBHOOK,
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
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------------------------
// Fixture.

const settings = async (
  input: {
    mode?: "DISCOUNT" | "MAXIMUM_PRICE" | "BOTH";
    percent?: number | null;
    maxCents?: number | null;
    revision?: number;
  } = {},
) => {
  const revision = input.revision ?? REVISION;
  await db
    .prepare(
      `INSERT INTO search_revisions (revision, mode, minimum_discount_percent, maximum_price_cents, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(
      revision,
      input.mode ?? "DISCOUNT",
      input.percent === undefined ? 20 : input.percent,
      input.maxCents ?? null,
      T - 10_000,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO search_settings (id, current_revision) VALUES (1, ?1)
       ON CONFLICT(id) DO UPDATE SET current_revision = ?1`,
    )
    .bind(revision)
    .run();
};

/** Watch targets in STORAGE vocabulary, exactly as `PUT /api/watch` writes them. */
const watch = async (targets: Array<[componentType: string, query: string]>) => {
  await db.prepare("DELETE FROM watch_targets").run();
  for (const [index, [componentType, query]] of targets.entries()) {
    await db
      .prepare("INSERT INTO watch_targets (target_id, component_type, query) VALUES (?1, ?2, ?3)")
      .bind(`t-${index}`, componentType, query)
      .run();
  }
  await db
    .prepare(
      `INSERT INTO watch_market (id, location, latitude, longitude, radius_km)
       VALUES (1, 'toronto', 43.6532, -79.3832, 25)
       ON CONFLICT(id) DO UPDATE SET radius_km = 25`,
    )
    .run();
};

interface DealInput {
  model?: string | null;
  price?: number;
  type?: string;
  validity?: string;
  lastSeenAt?: number;
  firstSeenAt?: number;
  title?: string;
  location?: string | null;
  url?: string;
  verdict?: string;
  status?: string;
  revision?: number;
  evaluatedAt?: number;
}

/** A listing and its evaluation task. Defaults make a qualifying DEAL. */
const deal = async (id: string, input: DealInput = {}) => {
  await db
    .prepare(
      `INSERT INTO listings (source, listing_id, market_key, component_type, model_key, variant_key,
                             title, price_cents, location_text, url, validity, content_hash,
                             first_seen_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?7, ?8, ?9, ?10, 'h', ?12, ?11)`,
    )
    .bind(
      SOURCE,
      id,
      MARKET,
      input.type ?? "gpu",
      input.model === undefined ? MODEL : input.model,
      input.title ?? `title ${id}`,
      input.price ?? 45_000,
      input.location === undefined ? "Toronto, ON" : input.location,
      input.url ?? `https://www.facebook.com/marketplace/item/${id}`,
      input.validity ?? "VALID",
      input.lastSeenAt ?? T - 600,
      input.firstSeenAt ?? input.lastSeenAt ?? T - 600,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO evaluation_tasks (source, listing_id, status, created_at, evaluated_revision,
                                     verdict, evaluated_at, lease_expires_at, lease_token)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, '')`,
    )
    .bind(
      SOURCE,
      id,
      input.status ?? "COMPLETE",
      T - 5_000,
      input.revision ?? REVISION,
      input.verdict ?? "DEAL",
      input.evaluatedAt ?? T - 1_000,
    )
    .run();
};

/** The market aggregate for a model: `count` references averaging `averageCents`. */
const references = async (model: string, count: number, averageCents: number) => {
  await db
    .prepare(
      `INSERT INTO model_stats (market_key, model_key, variant_key, count, total_price_cents)
       VALUES (?1, ?2, '', ?3, ?4)`,
    )
    .bind(MARKET, model, count, count * averageCents)
    .run();
};

/** The standard world: DISCOUNT 20 %, the whole gpu type watched, a 7-reference aggregate. */
const world = async () => {
  await settings();
  await watch([["gpu", "graphics card"]]);
  await references(MODEL, 7, 60_000);
};

interface Row {
  listing_id: string;
  status: string;
  attempts: number;
  next_attempt_at: number | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  last_attempt_at: number | null;
  sent_price_cents: number | null;
  sent_at: number | null;
  last_error: string | null;
}

const rows = async (): Promise<Row[]> =>
  (
    await db
      .prepare(
        `SELECT listing_id, status, attempts, next_attempt_at, lease_token, lease_expires_at,
                last_attempt_at, sent_price_cents, sent_at, last_error
           FROM notifications ORDER BY listing_id`,
      )
      .all<Row>()
  ).results;

const statusOf = async (id: string): Promise<string | undefined> =>
  (await rows()).find((row) => row.listing_id === id)?.status;

/** Seed a notification row directly, for the states the step cannot be asked to produce cheaply. */
const notification = async (
  id: string,
  status: string,
  extra: Partial<{
    createdAt: number;
    attempts: number;
    nextAttemptAt: number | null;
    leaseExpiresAt: number | null;
    lastAttemptAt: number | null;
    lastError: string | null;
  }> = {},
) => {
  await db
    .prepare(
      `INSERT INTO notifications (source, listing_id, model_key, status, created_at, updated_at,
                                  attempts, next_attempt_at, lease_token, lease_expires_at,
                                  last_attempt_at, last_error)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      SOURCE,
      id,
      MODEL,
      status,
      extra.createdAt ?? T - 3_000,
      extra.attempts ?? 0,
      extra.nextAttemptAt ?? null,
      status === "SENDING" ? "someone-else" : null,
      extra.leaseExpiresAt ?? null,
      extra.lastAttemptAt ?? null,
      extra.lastError ?? null,
    )
    .run();
};

// ---------------------------------------------------------------------------------------------
// The fake Discord.

type Answer =
  | number
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | "timeout"
  | "network";

interface Call {
  url: string;
  redirect: RequestInit["redirect"];
  body: { content: string; allowed_mentions: { parse: string[] }; flags: number };
}

const discord = (script: Answer[] = []) => {
  const calls: Call[] = [];
  const queue = [...script];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, redirect: init.redirect, body: JSON.parse(String(init.body)) as Call["body"] });
    const answer = queue.shift() ?? 200;
    if (answer === "timeout") {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }
    if (answer === "network") throw new TypeError("fetch failed");
    const spec = typeof answer === "number" ? { status: answer } : answer;
    const body =
      spec.body === undefined
        ? spec.status === 200
          ? { id: "1", content: "x" }
          : { message: "x", code: 0 }
        : spec.body;
    return new Response(JSON.stringify(body), {
      status: spec.status,
      headers: { "Content-Type": "application/json", ...(spec.headers ?? {}) },
    });
  };
  return { calls, fetch };
};

const notify = (
  fake: ReturnType<typeof discord>,
  now: number = T,
  extra: Partial<{ environment: NotifyEnvironment; maxSends: number; database: D1Database }> = {},
): Promise<NotifyCounts> =>
  runNotify(extra.database ?? db, {
    environment: extra.environment ?? ON,
    now,
    fetch: fake.fetch,
    leaseTokenPrefix: "run-test:notify",
    maxSends: extra.maxSends,
  });

/** A D1 wrapper that throws on the n-th result write (1-based) and delegates everything else. */
const throwingOnWrite = (failOn: number): D1Database => {
  let writes = 0;
  return {
    prepare: (sql: string) => {
      const real = db.prepare(sql);
      if (sql !== WRITE_RESULT) return real;
      return {
        bind: (...args: unknown[]) => {
          const bound = real.bind(...args);
          return {
            run: async () => {
              writes += 1;
              if (writes === failOn) throw new Error("D1 write failed");
              return bound.run();
            },
          };
        },
      };
    },
    batch: (statements: D1PreparedStatement[]) => db.batch(statements),
  } as unknown as D1Database;
};

// ---------------------------------------------------------------------------------------------

describe("the response classes", () => {
  /**
   * N1. Each Discord answer lands in the right state, with the right attempt count and error.
   * Kills: 5xx -> FAILED (or PENDING) instead of DELIVERY_UNKNOWN; 404 counting an attempt;
   * 400 -> PENDING; a 2xx not setting sent_price_cents; timeout -> PENDING.
   */
  it.each<[string, Answer, Partial<Row>]>([
    ["200", 200, { status: "SENT", attempts: 1, sent_price_cents: 45_000, sent_at: T, last_error: null }],
    ["400", { status: 400, body: { code: 50035 } }, { status: "FAILED", attempts: 1, last_error: "refused:400:50035" }],
    ["401", 401, { status: "PENDING", attempts: 0, last_error: "webhook-rejected:401" }],
    ["403", 403, { status: "PENDING", attempts: 0, last_error: "webhook-rejected:403" }],
    ["404", 404, { status: "PENDING", attempts: 0, last_error: "webhook-rejected:404" }],
    ["429", { status: 429, body: { retry_after: 2.5 } }, { status: "PENDING", attempts: 1, next_attempt_at: T + 3, last_error: "rate-limited" }],
    ["500", 500, { status: "DELIVERY_UNKNOWN", attempts: 1, last_error: "server-error:500" }],
    ["503", 503, { status: "DELIVERY_UNKNOWN", attempts: 1, last_error: "server-error:503" }],
    ["a timeout", "timeout", { status: "DELIVERY_UNKNOWN", attempts: 1, last_error: "timeout" }],
    ["a network error", "network", { status: "DELIVERY_UNKNOWN", attempts: 1, last_error: "network-error" }],
  ])("N1: %s", async (_label, answer, expected) => {
    await world();
    await deal("111");
    const fake = discord([answer]);

    await notify(fake);

    expect(fake.calls).toHaveLength(1);
    const [row] = await rows();
    expect(row).toMatchObject({
      ...expected,
      last_attempt_at: T,
      lease_token: null,
      lease_expires_at: null,
    });
    if (expected.status !== "SENT") expect(row.sent_at).toBeNull();
  });

  /**
   * N1b. The request itself. Kills: dropping `?wait=true` (Discord would answer 204,
   * unacknowledged), and dropping `redirect: "manual"` (a redirect would re-POST the message to a
   * host nobody validated).
   */
  it("N1b: posts to <url>?wait=true and never follows a redirect", async () => {
    await world();
    await deal("111");
    const fake = discord();
    await notify(fake);
    expect(fake.calls.map((call) => call.url)).toEqual([`${WEBHOOK}?wait=true`]);
    expect(fake.calls.map((call) => call.redirect)).toEqual(["manual"]);
  });

  /**
   * N1c. A webhook secret with a trailing `?` or `#` still posts to exactly `<url>?wait=true`.
   * Kills: sending the raw secret (`.../x??wait=true`, which Discord answers 204 and the step would
   * record as SENT).
   */
  it.each(["?", "#"])("N1c: a secret ending in %s posts to the clean URL", async (suffix) => {
    await world();
    await deal("121");
    const fake = discord();
    await notify(fake, T, { environment: { ...ON, DISCORD_WEBHOOK_URL: `${WEBHOOK}${suffix}` } });
    expect(fake.calls.map((call) => call.url)).toEqual([`${WEBHOOK}?wait=true`]);
  });
});

describe("retry safety", () => {
  /**
   * N2. A RETRIED STEP DOES NOT RESEND. The first execution claims the row, fetches, and its
   * result write throws -- the step fails. The retry runs with the SAME `now`, the Workflow's
   * frozen params.now. Then the next run, 30 minutes later.
   *
   * Kills: (a) CLAIM_ONE selecting `status IN ('PENDING','SENDING')` -- the retry resends;
   * (b) the sweep moving expired rows to PENDING instead of DELIVERY_UNKNOWN -- the next run
   * resends; (c) the sweep dropping its `lease_expires_at < ?1` term -- the retry sweeps the
   * in-flight row (asserted SENDING after the retry).
   */
  it("N2: the step's retry and the next run never resend a row whose result write failed", async () => {
    await world();
    await deal("111");
    const fake = discord();

    await expect(notify(fake, T, { database: throwingOnWrite(1) })).rejects.toThrow("D1 write failed");
    expect(fake.calls).toHaveLength(1);
    expect(await rows()).toMatchObject([
      { status: "SENDING", lease_expires_at: T + NOTIFY_LEASE_SECONDS, last_attempt_at: null },
    ]);

    const retry = await notify(fake, T);
    expect(fake.calls).toHaveLength(1);
    expect(retry).toMatchObject({ sent: 0, swept: 0, enqueued: 0 });
    expect(await statusOf("111")).toBe("SENDING");

    const next = await notify(fake, T + 1_800);
    expect(fake.calls).toHaveLength(1);
    expect(next.swept).toBe(1);
    expect(await statusOf("111")).toBe("DELIVERY_UNKNOWN");

    await notify(fake, T + 3_600);
    expect(fake.calls).toHaveLength(1);
  });

  /**
   * N3. A RESULT-WRITE THROW ON ROW 3 LEAVES ROWS 4-5 PENDING, and the next execution sends them.
   * Kills: claiming the whole batch up front (CLAIM_ONE's `rowid = (... LIMIT 1)` widened to
   * `rowid IN (... LIMIT 5)`) -- rows 4-5 are then stranded SENDING and never sent.
   */
  it("N3: a write throw on row 3 strands only row 3; rows 4 and 5 go out on the retry", async () => {
    await world();
    for (const id of ["301", "302", "303", "304", "305"]) await deal(id);
    const fake = discord();

    await expect(notify(fake, T, { database: throwingOnWrite(3) })).rejects.toThrow();
    expect(fake.calls).toHaveLength(3);
    expect((await rows()).map((row) => `${row.listing_id}:${row.status}`)).toEqual([
      "301:SENT",
      "302:SENT",
      "303:SENDING",
      "304:PENDING",
      "305:PENDING",
    ]);

    const retry = await notify(fake, T);
    expect(retry.sent).toBe(2);
    expect(fake.calls).toHaveLength(5);
    expect((await rows()).map((row) => `${row.listing_id}:${row.status}`)).toEqual([
      "301:SENT",
      "302:SENT",
      "303:SENDING",
      "304:SENT",
      "305:SENT",
    ]);
    // Each listing was posted exactly once.
    const links = fake.calls.map((call) => call.body.content.split("\n").at(-1));
    expect(new Set(links).size).toBe(5);
  });

  /**
   * N4. THE SWEEP TOUCHES ONLY EXPIRED LEASES. Kills: dropping `lease_expires_at < ?1` (the live
   * and boundary rows would be swept), and `<` -> `<=` (the boundary row would be swept).
   */
  it("N4: an expired SENDING row is swept; a live one and the exact boundary are not", async () => {
    await world();
    await notification("401", "SENDING", { leaseExpiresAt: T - 1 });
    await notification("402", "SENDING", { leaseExpiresAt: T });
    await notification("403", "SENDING", { leaseExpiresAt: T + 300 });
    await notification("404", "PENDING", { nextAttemptAt: T + 10_000 });

    const counts = await notify(discord(), T);

    expect(counts.swept).toBe(1);
    expect((await rows()).map((row) => `${row.listing_id}:${row.status}`)).toEqual([
      "401:DELIVERY_UNKNOWN",
      "402:SENDING",
      "403:SENDING",
      "404:PENDING",
    ]);
  });
});

describe("enqueue", () => {
  /**
   * N5. STARVATION. 21 already-SENT DEALs are all newer-evaluated than one new DEAL. Kills:
   * removing the NOT EXISTS (the LIMIT 20 window then fills with SENT rows, whose conflicts the
   * re-arm guard ignores, and the new DEAL is never reached).
   */
  it("N5: 21 SENT deals do not starve one new deal out of the 20-row window", async () => {
    await world();
    for (let index = 0; index < 21; index += 1) {
      const id = `5${String(index).padStart(2, "0")}`;
      await deal(id, { evaluatedAt: T - 100 + index });
      await notification(id, "SENT");
    }
    await deal("599", { evaluatedAt: T - 4_000 });
    const fake = discord();

    const counts = await notify(fake);

    expect(counts.enqueued).toBe(1);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].body.content).toContain("/marketplace/item/599");
  });

  /**
   * N6. SELECTION, the dashboard's. The user watches only the GeForce RTX 4070 Super model. Kills:
   * binding no selection (every type and model alerts), and binding a model pair as the bare type.
   */
  it("N6: watching only the 4070 Super enqueues its DEAL and not the plain 4070's", async () => {
    await settings();
    await watch([["gpu", "GeForce RTX 4070 Super"]]);
    await references("GeForce RTX 4070", 7, 50_000);
    await references(MODEL, 7, 60_000);
    await deal("601", { model: "GeForce RTX 4070", price: 30_000 });
    await deal("602", { model: MODEL });

    await notify(discord(), T, { maxSends: 0 });

    expect((await rows()).map((row) => row.listing_id)).toEqual(["602"]);
  });

  /**
   * N6b. THE case_fans / case_fan TRAP, both ways a selection can name the type. Kills: binding
   * the catalog id `case_fans` instead of the storage id `case_fan` in either list.
   */
  it.each<[string, string]>([
    ["the whole type", "case fan"],
    ["one model", "Noctua NF-A12x25 PWM"],
  ])("N6b: a case_fan DEAL is enqueued when %s is watched", async (_label, query) => {
    await settings();
    await watch([["case_fan", query]]);
    await references("Noctua NF-A12x25 PWM", 7, 4_000);
    await deal("611", { type: "case_fan", model: "Noctua NF-A12x25 PWM", price: 2_000 });

    await notify(discord(), T, { maxSends: 0 });

    expect((await rows()).map((row) => row.listing_id)).toEqual(["611"]);
  });

  /**
   * N7. THE GATES. A null-model DEAL and the MAXIMUM_PRICE no-evidence DEAL (an un-normalized
   * CA$0 listing, no model) are never enqueued; a model-keyed DEAL in the same world is.
   * Kills: dropping `l.model_key IS NOT NULL` from CANDIDATE_PREDICATE.
   */
  it.each<[string, "DISCOUNT" | "MAXIMUM_PRICE"]>([
    ["DISCOUNT", "DISCOUNT"],
    ["MAXIMUM_PRICE", "MAXIMUM_PRICE"],
  ])("N7: under %s a null-model DEAL is never enqueued", async (_label, mode) => {
    await settings(
      mode === "DISCOUNT" ? { mode } : { mode, percent: null, maxCents: 74_900 },
    );
    await watch([["gpu", "graphics card"]]);
    await references(MODEL, 7, 60_000);
    await deal("701", { model: null, price: 0, title: "GPU" });
    await deal("702", { model: MODEL });

    await notify(discord(), T, { maxSends: 0 });

    expect((await rows()).map((row) => row.listing_id)).toEqual(["702"]);
  });

  /**
   * N7b. The rest of the predicate at enqueue time: not VALID, not COMPLETE, not DEAL, an older
   * revision, stale. Kills: dropping any one of those five terms.
   */
  it("N7b: only a VALID, COMPLETE, DEAL, current-revision, fresh listing is enqueued", async () => {
    await world();
    await deal("711", { validity: "NEEDS_REVIEW" });
    await deal("712", { status: "PENDING" });
    await deal("713", { verdict: "NOT_DEAL" });
    await deal("714", { revision: REVISION - 1 });
    await deal("715", { lastSeenAt: T - NOTIFY_FRESH_SECONDS - 1 });
    await deal("716", { lastSeenAt: T - NOTIFY_FRESH_SECONDS });

    await notify(discord(), T, { maxSends: 0 });

    expect((await rows()).map((row) => row.listing_id)).toEqual(["716"]);
  });

  /**
   * N10. ONLY CANCELLED RE-ARMS. Four qualifying DEALs whose rows are SENT, DELIVERY_UNKNOWN,
   * FAILED and CANCELLED. Kills: `n.status <> 'CANCELLED'` -> no status filter (the CANCELLED row
   * is excluded too), and the NOT EXISTS removed together with the DO UPDATE's WHERE (every
   * terminal row comes back).
   */
  it("N10: CANCELLED re-arms; SENT, DELIVERY_UNKNOWN and FAILED never do", async () => {
    await world();
    for (const [id, status] of [
      ["1001", "SENT"],
      ["1002", "DELIVERY_UNKNOWN"],
      ["1003", "FAILED"],
      ["1004", "CANCELLED"],
    ]) {
      await deal(id);
      await notification(id, status, { attempts: 3, lastAttemptAt: T - 2_000, lastError: "x" });
    }

    const counts = await notify(discord(), T, { maxSends: 0 });

    expect(counts.enqueued).toBe(1);
    expect(await rows()).toMatchObject([
      { listing_id: "1001", status: "SENT" },
      { listing_id: "1002", status: "DELIVERY_UNKNOWN" },
      { listing_id: "1003", status: "FAILED" },
      // Re-armed fresh, and KEEPING the last Discord answer for /api/status.
      { listing_id: "1004", status: "PENDING", attempts: 0, last_attempt_at: T - 2_000, last_error: "x" },
    ]);
  });
});

describe("re-check", () => {
  /**
   * N8. PRICE CHANGE -> CANCELLED -> RE-EVALUATED DEAL -> RE-ARMED -> EXACTLY ONE SEND AT THE NEW
   * PRICE. Every step goes through the real enqueue SQL on real D1 and the real evaluateBatch.
   * The cancelled row can come back ONLY through the ON CONFLICT ... DO UPDATE re-arm branch,
   * because the NOT EXISTS lets nothing else through.
   *
   * Kills: replacing the re-arm branch with `ON CONFLICT DO NOTHING` -- run 3 enqueues nothing
   * and the deal is never sent; and dropping `t.status = 'COMPLETE'` from the predicate -- run 2
   * sends at the stale price.
   */
  it("N8: a price change cancels, and the re-judged deal re-arms and sends once at the new price", async () => {
    await world();
    // First seen a MONTH ago: a price drop on an old listing must still alert (NOTIFY_RECENT_
    // EVALUATION_SECONDS gates on the judgment, not on first sight).
    await deal("801", { price: 45_000, firstSeenAt: T - 30 * 86_400 });
    const fake = discord();

    // Run 1: enqueued, not sent yet.
    expect((await notify(fake, T, { maxSends: 0 })).enqueued).toBe(1);

    // The price drops. recordSightings' QUEUE_TASK re-queues the task; the listing row moves.
    await db.prepare("UPDATE listings SET price_cents = 40000 WHERE listing_id = '801'").run();
    await db
      .prepare("UPDATE evaluation_tasks SET status = 'PENDING', created_at = ?1 WHERE listing_id = '801'")
      .bind(T + 100)
      .run();

    // Run 2: the re-check fails (task not COMPLETE) -> CANCELLED, nothing posted.
    const second = await notify(fake, T + 1_800);
    expect(second).toMatchObject({ cancelled: 1, sent: 0, enqueued: 0 });
    expect(fake.calls).toHaveLength(0);
    expect(await statusOf("801")).toBe("CANCELLED");

    // The drain judges the new price: still a DEAL (40,000 <= 80 % of 60,000).
    const judged = await evaluateBatch(db, {
      source: SOURCE,
      settings: { mode: "DISCOUNT", minimumDiscountPercent: 20, maximumPriceCents: null, searchRevision: REVISION },
      now: T + 3_000,
    });
    expect(judged.outcomes.map((outcome) => outcome.verdict)).toEqual(["DEAL"]);

    // Run 3: re-armed through the upsert, sent once, at the new price.
    const third = await notify(fake, T + 3_600);
    expect(third).toMatchObject({ enqueued: 1, sent: 1, cancelled: 0 });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].body.content).toContain("for CA$400.00");
    expect(await rows()).toMatchObject([
      { listing_id: "801", status: "SENT", sent_price_cents: 40_000, sent_at: T + 3_600 },
    ]);

    // Run 4: nothing more.
    await notify(fake, T + 5_400);
    expect(fake.calls).toHaveLength(1);
  });

  /**
   * N8b. THE OTHER CANCELS: the revision moved, the listing went stale, the user stopped watching
   * it. Kills: dropping `t.evaluated_revision = ss.current_revision`, `l.last_seen_at >= ?4`, or
   * the selection term from CANDIDATE_PREDICATE (each case then posts).
   */
  it.each<[string, () => Promise<void>, number]>([
    [
      "the revision changed",
      async () => {
        await settings({ revision: REVISION + 1 });
      },
      T,
    ],
    ["the listing went stale", async () => {}, T - 600 + NOTIFY_FRESH_SECONDS + 1],
    [
      "the user stopped watching it",
      async () => {
        await watch([["cpu", "cpu"]]);
      },
      T,
    ],
  ])("N8b: %s -> CANCELLED, no POST", async (_label, change, now) => {
    await world();
    await deal("811");
    const fake = discord();
    expect((await notify(fake, T, { maxSends: 0 })).enqueued).toBe(1);

    await change();
    const counts = await notify(fake, now);

    expect(counts).toMatchObject({ cancelled: 1, sent: 0 });
    expect(fake.calls).toHaveLength(0);
    expect(await statusOf("811")).toBe("CANCELLED");
  });

  /**
   * N9. BLOCKING. A row waiting out a 429, a row SENDING under someone else's live lease and a
   * CANCELLED row -- all created earlier -- never delay a due row. Kills: dropping the
   * `next_attempt_at` term from CLAIM_ONE (the waiting row is posted first).
   */
  it("N9: a waiting, an in-flight and a cancelled row never delay a second due row", async () => {
    await world();
    await deal("901");
    await deal("902");
    await deal("903");
    await deal("904");
    await notification("901", "PENDING", { createdAt: T - 9_000, nextAttemptAt: T + 60 });
    await notification("902", "SENDING", { createdAt: T - 8_000, leaseExpiresAt: T + 300 });
    await notification("903", "CANCELLED", { createdAt: T - 7_000 });
    await notification("904", "PENDING", { createdAt: T - 6_000 });
    // 903 qualifies, so enqueue re-arms it; make it not qualify so it stays out of the way.
    await db.prepare("UPDATE evaluation_tasks SET verdict = 'NOT_DEAL' WHERE listing_id = '903'").run();
    const fake = discord();

    const counts = await notify(fake);

    expect(counts.sent).toBe(1);
    expect(fake.calls.map((call) => call.body.content.split("\n").at(-1))).toEqual([
      "https://www.facebook.com/marketplace/item/904",
    ]);
    expect((await rows()).map((row) => `${row.listing_id}:${row.status}`)).toEqual([
      "901:PENDING",
      "902:SENDING",
      "903:CANCELLED",
      "904:SENT",
    ]);
  });

  /**
   * N9b. A cancelled claim does not end the loop. Kills: `continue` -> `break` after a cancel.
   */
  it("N9b: a row cancelled at re-check does not stop the rows behind it", async () => {
    await world();
    await deal("911");
    await deal("912", { evaluatedAt: T - 2_000 });
    await notify(discord(), T, { maxSends: 0 });
    await db.prepare("UPDATE evaluation_tasks SET verdict = 'NOT_DEAL' WHERE listing_id = '911'").run();
    const fake = discord();

    const counts = await notify(fake);

    expect(counts).toMatchObject({ cancelled: 1, sent: 1 });
    expect(fake.calls).toHaveLength(1);
  });
});

describe("rate limits and rejection", () => {
  /**
   * N11. 429 HONOURS retry_after, from the body or the header; it stops the step; the row comes
   * back once the wait is over; the sixth 429 is FAILED. Kills: ignoring retry_after (a fixed
   * delay), not stopping on 429, `>` -> `>=` in the attempts cap.
   */
  it("N11: a 429 waits retry_after, stops the step, and is retried when due", async () => {
    await world();
    await deal("1101");
    await deal("1102", { evaluatedAt: T - 2_000 });
    const fake = discord([
      { status: 429, headers: { "Retry-After": "7" }, body: { message: "slow down" } },
    ]);

    const first = await notify(fake);
    expect(first).toMatchObject({ rateLimited: 1, sent: 0 });
    expect(fake.calls).toHaveLength(1);
    expect(await rows()).toMatchObject([
      { listing_id: "1101", status: "PENDING", attempts: 1, next_attempt_at: T + 7 },
      { listing_id: "1102", status: "PENDING", attempts: 0 },
    ]);

    // Before the wait is over the waiting row is skipped and the other row goes.
    await notify(fake, T + 6);
    expect(await statusOf("1101")).toBe("PENDING");
    expect(await statusOf("1102")).toBe("SENT");

    await notify(fake, T + 7);
    expect(await statusOf("1101")).toBe("SENT");
    expect(fake.calls).toHaveLength(3);
  });

  it("N11b: the sixth 429 is FAILED; the fifth is still PENDING", async () => {
    await world();
    await deal("1111");
    await notification("1111", "PENDING", { attempts: 4 });
    const fake = discord([
      { status: 429, body: { retry_after: 1 } },
      { status: 429, body: { retry_after: 1 } },
    ]);

    await notify(fake);
    expect(await rows()).toMatchObject([{ status: "PENDING", attempts: 5 }]);
    await notify(fake, T + 1);
    expect(await rows()).toMatchObject([
      { status: "FAILED", attempts: 6, last_error: "rate-limited:attempts-exhausted" },
    ]);
  });

  /**
   * N11c. `X-RateLimit-Remaining: 0` STOPS THE STEP after recording the row. Kills: ignoring the
   * header (all three go out).
   */
  it("N11c: a 200 with X-RateLimit-Remaining: 0 is recorded SENT and stops the step", async () => {
    await world();
    for (const id of ["1121", "1122", "1123"]) await deal(id);
    const fake = discord([{ status: 200, headers: { "X-RateLimit-Remaining": "0" } }]);

    const counts = await notify(fake);

    expect(counts.sent).toBe(1);
    expect(fake.calls).toHaveLength(1);
    expect((await rows()).map((row) => row.status).sort()).toEqual(["PENDING", "PENDING", "SENT"]);
  });

  /**
   * N12. A REJECTED WEBHOOK PROBES ONCE PER RUN WITHOUT COUNTING ATTEMPTS. Three rows; each run
   * posts exactly one. Kills: counting the attempt (attempts climbs and the row would eventually
   * FAIL), and not stopping on a rejection (three POSTs a run).
   */
  it.each([401, 403, 404])("N12: a %i probes exactly once per run and never counts", async (status) => {
    await world();
    for (const id of ["1201", "1202", "1203"]) await deal(id);
    const fake = discord([status, status, status]);

    for (const now of [T, T + 1_800, T + 3_600]) await notify(fake, now);

    expect(fake.calls).toHaveLength(3);
    const all = await rows();
    expect(all.every((row) => row.status === "PENDING" && row.attempts === 0)).toBe(true);
    expect(all.filter((row) => row.last_error === `webhook-rejected:${status}`)).toHaveLength(1);
  });
});

describe("/api/status notifications", () => {
  /**
   * N13. `webhook-rejected` IS THE LATEST DISCORD ANSWER, and only that.
   * Kills: deriving it from the latest `updated_at` (case a: a re-armed row is newer); a cancel
   * clearing `last_error` (case b); "any row was ever rejected" (case c: a later 200 must clear).
   */
  it("N13a: an old rejected row plus a newer clean PENDING row still reads webhook-rejected", async () => {
    await world();
    await notification("1301", "PENDING", { lastAttemptAt: T - 100, lastError: "webhook-rejected:404" });
    await notification("1302", "PENDING", { createdAt: T });
    // A row re-armed just now: the newest `updated_at` and `created_at`, but its last Discord
    // answer (a 429) is OLDER than the rejection. It must not mask the rejection.
    await notification("1303", "PENDING", {
      createdAt: T,
      lastAttemptAt: T - 5_000,
      lastError: "rate-limited",
    });

    const status = await readNotificationsStatus(db, ON, T);

    expect(status).toEqual({
      state: "webhook-rejected",
      pending: 3,
      sent24h: 0,
      deliveryUnknown: 0,
      failed: 0,
      lastSentAt: null,
    });
  });

  it("N13b: a rejected row that is later cancelled still reads webhook-rejected", async () => {
    await world();
    await deal("1311");
    await notify(discord([404]));
    expect(await readNotificationsStatus(db, ON, T)).toMatchObject({ state: "webhook-rejected" });

    await db.prepare("UPDATE evaluation_tasks SET verdict = 'NOT_DEAL' WHERE listing_id = '1311'").run();
    await notify(discord(), T + 1_800);
    expect(await statusOf("1311")).toBe("CANCELLED");

    expect(await readNotificationsStatus(db, ON, T + 1_800)).toMatchObject({
      state: "webhook-rejected",
      pending: 0,
    });
  });

  /**
   * The rejected row is CANCELLED before the 200 arrives, so it keeps its `webhook-rejected`
   * error: the 200 clears the state by being NEWER, not by overwriting that row.
   */
  it("N13c: a later 200 on another row clears it", async () => {
    await world();
    await deal("1321");
    await deal("1322", { evaluatedAt: T - 2_000 });
    await notify(discord([404]));
    expect(await readNotificationsStatus(db, ON, T)).toMatchObject({ state: "webhook-rejected" });

    await db.prepare("UPDATE evaluation_tasks SET verdict = 'NOT_DEAL' WHERE listing_id = '1321'").run();
    const counts = await notify(discord([200]), T + 1_800);
    expect(counts).toMatchObject({ cancelled: 1, sent: 1 });
    expect(await rows()).toMatchObject([
      { listing_id: "1321", status: "CANCELLED", last_error: "webhook-rejected:404" },
      { listing_id: "1322", status: "SENT" },
    ]);

    expect(await readNotificationsStatus(db, ON, T + 1_800)).toEqual({
      state: "on",
      pending: 0,
      sent24h: 1,
      deliveryUnknown: 0,
      failed: 0,
      lastSentAt: T + 1_800,
    });
  });

  /**
   * N13d. Within one step, rows posted before a rejection share the run's `now`; the rejection
   * was the last answer, so it wins the tie. Kills: dropping the tie-break term.
   */
  it("N13d: a 200 then a 404 in the same step reads webhook-rejected", async () => {
    await world();
    await deal("1331");
    await deal("1332", { evaluatedAt: T - 2_000 });
    await notify(discord([200, 404]));
    expect(await readNotificationsStatus(db, ON, T)).toMatchObject({ state: "webhook-rejected", sent24h: 1 });
  });

  /** N13e. The counts. Kills: counting SENDING out of `pending`, or a sent24h window not bounded. */
  it("N13e: counts PENDING and SENDING as pending, and only the last day's sends", async () => {
    await world();
    await notification("1341", "PENDING");
    await notification("1342", "SENDING", { leaseExpiresAt: T + 600 });
    await notification("1343", "DELIVERY_UNKNOWN");
    await notification("1344", "FAILED");
    await db
      .prepare(
        `INSERT INTO notifications (source, listing_id, model_key, status, created_at, updated_at, sent_at)
         VALUES (?1, '1345', ?2, 'SENT', 1, 1, ?3), (?1, '1346', ?2, 'SENT', 1, 1, ?4)`,
      )
      .bind(SOURCE, MODEL, T - 86_400, T - 86_401)
      .run();

    expect(await readNotificationsStatus(db, ON, T)).toEqual({
      state: "on",
      pending: 2,
      sent24h: 1,
      deliveryUnknown: 1,
      failed: 1,
      lastSentAt: T - 86_400,
    });
  });
});

describe("the message on the wire", () => {
  /**
   * N14. INJECTION, pinned rows. The stored `url` is hostile; the link is still built from the
   * id. Every request carries `flags: 4` and `allowed_mentions: {parse: []}`.
   * Kills: building the link from `l.url`; dropping either payload guard; not collapsing
   * newlines (the `# heading` row); not escaping `[`/`(` (the masked-link row).
   */
  it("N14: hostile titles stay inert and the link comes from the id", async () => {
    await world();
    await deal("1401", {
      title: "[click](https://evil.example)",
      url: "https://evil.example/phish",
    });
    await deal("1402", { title: "@everyone free GPU", evaluatedAt: T - 2_000 });
    await deal("1403", {
      title: "RTX 4070 Super\n# heading\n> quote",
      location: "Toronto\n# also",
      evaluatedAt: T - 3_000,
    });
    const fake = discord();

    await notify(fake);

    expect(fake.calls).toHaveLength(3);
    for (const call of fake.calls) {
      expect(call.body.flags).toBe(4);
      expect(call.body.allowed_mentions).toEqual({ parse: [] });
      expect(call.body.content).not.toContain("evil.example/phish");
      expect(call.body.content.length).toBeLessThanOrEqual(2000);
    }
    const [masked, everyone, heading] = fake.calls.map((call) => call.body.content.split("\n"));
    expect(masked.at(-2)).toBe("Title: \\[click\\]\\(https:\u200B//evil.example\\)");
    expect(masked.at(-1)).toBe("https://www.facebook.com/marketplace/item/1401");
    expect(everyone.at(-2)).toBe("Title: @everyone free GPU");
    // The id-built link is the ONLY `://` in any message.
    for (const call of fake.calls) expect(call.body.content.match(/:\/\//g)).toHaveLength(1);
    expect(heading.at(-2)).toBe("Title: RTX 4070 Super \\# heading \\> quote");
    expect(heading).toHaveLength(6);
    expect(heading[3]).toContain("listed in Toronto \\# also,");
  });
});

describe("inert states", () => {
  /** A D1 that records every prepare and batch. */
  const instrumented = () => {
    const touched: string[] = [];
    const stub = {
      prepare: (sql: string) => {
        touched.push(sql);
        throw new Error("no D1 query is allowed in an inert state");
      },
      batch: () => {
        touched.push("batch");
        throw new Error("no D1 batch is allowed in an inert state");
      },
      exec: () => {
        touched.push("exec");
        throw new Error("no D1 exec is allowed in an inert state");
      },
    } as unknown as D1Database;
    return { stub, touched };
  };

  /**
   * N16. INERT MEANS ZERO D1 QUERIES, in the step and in /api/status. Kills: running the sweep
   * (or any query) before the state check; querying the table for the status in an inert state.
   */
  it.each<[string, NotifyEnvironment]>([
    ["unconfigured", { APP_ENV: "production", NOTIFICATIONS: "on" }],
    ["invalid-url", { APP_ENV: "production", NOTIFICATIONS: "on", DISCORD_WEBHOOK_URL: "http://discord.com/api/webhooks/1/x" }],
    ["off", { APP_ENV: "production", DISCORD_WEBHOOK_URL: WEBHOOK }],
    ["off", { APP_ENV: "production", DISCORD_WEBHOOK_URL: WEBHOOK, NOTIFICATIONS: "ON" }],
  ])("N16: %s makes no D1 query and no fetch", async (state, environment) => {
    const { stub, touched } = instrumented();
    const fake = discord();

    const counts = await notify(fake, T, { environment, database: stub });
    const status = await readNotificationsStatus(stub, environment, T);

    expect(counts).toEqual({
      state,
      swept: 0,
      enqueued: 0,
      sent: 0,
      rateLimited: 0,
      rejected: 0,
      failed: 0,
      unknown: 0,
      cancelled: 0,
      unrecorded: 0,
    });
    expect(status).toEqual({ state });
    expect(touched).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  /**
   * N16b. ONE COUNTS-ONLY LOG LINE PER STEP, never the URL, a title or a token. Kills: logging the
   * config or the content.
   */
  it("N16b: logs exactly one counts line, with no URL, title or token in it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await world();
    await deal("1601", { title: "secret-title-text" });

    await notify(discord());

    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line).toBe(
      "notify state=on enqueued=1 sent=1 unknown=0 cancelled=0 failed=0 rate_limited=0 rejected=0 swept=0 unrecorded=0",
    );
    expect(log.mock.calls[0]).toHaveLength(1);
  });
});

describe("round 2", () => {
  /**
   * N14b. NO BARE URL IN A TITLE OR LOCATION STAYS CLICKABLE. Discord autolinks `scheme://`
   * whatever the Markdown escaping, so every `://` is broken with a zero-width space. Kills:
   * removing the scheme break from `sanitizeText`.
   */
  it.each<[string, string, string]>([
    ["a bare http URL in the title", "GPU http://evil.example/phish cheap", "Toronto, ON"],
    ["a bare https URL in the title", "GPU https://evil.example/phish cheap", "Toronto, ON"],
    ["an uppercase scheme", "GPU HTTPS://EVIL.EXAMPLE/PHISH", "Toronto, ON"],
    ["a <...> autolink in the location", "GPU", "<https://evil.example/x>"],
    ["a scheme glued to text", "GPUhttps://evil.example", "nearhttps://evil.example"],
  ])("N14b: %s is not a link", async (_label, title, location) => {
    await world();
    await deal("1411", { title, location });
    const fake = discord();

    await notify(fake);

    const content = fake.calls[0].body.content;
    expect(content.match(/:\/\//g)).toEqual(["://"]);
    expect(content.endsWith("\nhttps://www.facebook.com/marketplace/item/1411")).toBe(true);
    expect(content.includes("evil.example") || content.includes("EVIL.EXAMPLE")).toBe(true);
  });

  /**
   * N18. AN OVERLAPPING RUN SWEEPS A ROW WHOSE FETCH IS IN FLIGHT. The fetch succeeds, the fenced
   * write matches nothing, and the step says so (`unrecorded`, one `changes=0` warning) instead of
   * passing silently. The row stays DELIVERY_UNKNOWN -- which is why the runbook checks the channel
   * before a manual resend. Kills: dropping the changes=0 count and warning.
   */
  it("N18: a result write that changes 0 rows is counted and warned, never silent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await world();
    await deal("1801");
    const overlapping = {
      prepare: (sql: string) => {
        const real = db.prepare(sql);
        if (sql !== WRITE_RESULT) return real;
        return {
          bind: (...args: unknown[]) => ({
            run: async () => {
              // Another run, far enough ahead that A's lease has expired, sweeps first.
              await db
                .prepare("UPDATE notifications SET status = 'DELIVERY_UNKNOWN', lease_token = NULL WHERE status = 'SENDING'")
                .run();
              return real.bind(...args).run();
            },
          }),
        };
      },
    } as unknown as D1Database;

    const counts = await notify(discord(), T, { database: overlapping });

    expect(counts).toMatchObject({ sent: 1, unrecorded: 1 });
    expect(warn.mock.calls.map((call) => call.join(" "))).toEqual([
      "notify result write changes=0 outcome=sent",
    ]);
    expect(await statusOf("1801")).toBe("DELIVERY_UNKNOWN");
  });

  /**
   * N7c. NEW DEALS FROM NOW ON. A DEAL judged more than a day ago is not enqueued, even though the
   * listing is still being seen; one judged exactly a day ago is. Kills: dropping
   * `t.evaluated_at >= ?6` (the backlog dump when alerts are first turned on).
   */
  it("N7c: a DEAL judged more than a day ago is not enqueued", async () => {
    await world();
    await deal("1701", { evaluatedAt: T - 86_401 });
    await deal("1702", { evaluatedAt: T - 86_400 });

    await notify(discord(), T, { maxSends: 0 });

    expect((await rows()).map((row) => row.listing_id)).toEqual(["1702"]);
  });

  /**
   * N7d. The gate is on ENQUEUE ONLY. A row enqueued in time and kept PENDING past the day (a
   * webhook rejected for two days) still goes out when the webhook recovers. Kills: moving the
   * gate into CANDIDATE_PREDICATE, which the re-check shares -- the row would be cancelled.
   */
  it("N7d: a row that waited more than a day is still sent, not cancelled", async () => {
    await world();
    await deal("1711", { evaluatedAt: T - 1_000, lastSeenAt: T + 2 * 86_400 - 600 });
    await notify(discord([404]), T);

    const counts = await notify(discord(), T + 2 * 86_400);

    expect(counts).toMatchObject({ sent: 1, cancelled: 0 });
    expect(await statusOf("1711")).toBe("SENT");
  });
});
