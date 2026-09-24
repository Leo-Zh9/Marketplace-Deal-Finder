// @vitest-environment node

/**
 * POST /api/listings driven through the REAL handleRequest against a REAL local D1 with the
 * real migrations 0001-0004 and the REAL merged `recordSightings`. Nothing on the write path is
 * stubbed: the only fakes here are deliberately-failing D1 wrappers, and each one exists to
 * produce a failure SHAPE that a real database will not produce on demand.
 */

import type { AuthDependencies } from "../auth/verifyFirebaseToken";
import { handleRequest, type Environment } from "../index";
import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";
import type { SightingReport } from "../storage/types";
import {
  MAX_INGEST_BODY_BYTES,
  MAX_LISTINGS_PER_BATCH,
  readBoundedBody,
  summarizeReport,
} from "./listings";

/** 37 characters, comfortably over the 32 minimum and distinct from every other suite's token. */
const token = "listings-suite-token-6f2a91c4e8db0357";
const appOrigin = "https://deals.pages.dev";
const workerOrigin = "https://api.example.workers.dev";
const REQUEST_CLOCK = 1_800_000_000;

/** Distinct from every other suite's: source, componentType, market and ids all differ. */
const SOURCE = "test-marketplace";
const COMPONENT_TYPE = "psu";
const MARKET = { latitude: 45.4215, longitude: -75.6972, radiusKm: 31 };
const MARKET_KEY = "45.4215,-75.6972|31km";

let database!: TestDatabase;

/**
 * The ingest branch runs BEFORE `authenticateRequest` and reads only `now`. No test in this
 * file reaches the Firebase path, and the throwing key source is how that is enforced rather
 * than assumed.
 */
const dependencies: AuthDependencies = {
  keys: {
    getKey: () => {
      throw new Error("the Firebase key source must not be reached by the ingest route");
    },
  },
  now: () => REQUEST_CLOCK,
};

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database.dispose();
});

beforeEach(async () => {
  await truncateAll(database.db);
});

const environment = (overrides: Partial<Environment> = {}): Environment => ({
  APP_ENV: "production",
  FIREBASE_PROJECT_ID: "listings-api-test",
  ALLOWED_ORIGINS: JSON.stringify([appOrigin]),
  APPROVED_EMAILS: JSON.stringify(["operator@example.com"]),
  COLLECTOR_TOKEN: token,
  DB: database.db,
  ...overrides,
});

/** NO Origin header, ever: the route refuses any request that carries one. */
const post = (
  body: BodyInit | null,
  {
    headers = {},
    env = environment(),
    path = "/api/listings",
  }: { headers?: Record<string, string>; env?: Environment; path?: string } = {},
) =>
  handleRequest(
    new Request(`${workerOrigin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Collector-Token": token, ...headers },
      body,
    }),
    env,
    dependencies,
  );

const listing = (id: string, overrides: Record<string, unknown> = {}) => ({
  listingId: id,
  title: `title for ${id}`,
  priceText: "CA$3,000",
  locationText: "Ottawa, Ontario",
  url: `https://www.facebook.com/marketplace/item/${id}`,
  ...overrides,
});

const envelope = (listings: unknown[], overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    source: SOURCE,
    componentType: COMPONENT_TYPE,
    market: MARKET,
    listings,
    ...overrides,
  });

const THREE = [listing("L-901"), listing("L-902"), listing("L-903")];

const rows = async <T>(sql: string): Promise<T[]> =>
  (await database.db.prepare(sql).all<T>()).results;

const count = async (table: string): Promise<number> => {
  const row = await database.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? -1;
};

/** Wraps a REAL D1 so chosen `batch` calls reject. Index 0 is the classification read. */
const withFailingBatches = (db: D1Database, fails: (index: number) => boolean): D1Database => {
  let index = 0;
  return {
    prepare: (sql: string) => db.prepare(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      const current = index;
      index += 1;
      if (fails(current)) throw new Error("D1_ERROR: disk I/O error");
      return db.batch(statements);
    },
  } as unknown as D1Database;
};

const EMPTY_CONTRIBUTIONS = {
  recorded: 0,
  restored: 0,
  removed: 0,
  none: 0,
  "skipped-no-price": 0,
  "skipped-no-model": 0,
  "skipped-invalid": 0,
};

describe("POST /api/listings", () => {
  it("L1: a batch lands in D1 with every authoritative column set by the server", async () => {
    const response = await post(envelope(THREE));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      received: 3,
      stored: 3,
      outcomes: { NEW: 3, CHANGED: 0, UNCHANGED: 0, FAILED: 0 },
      contributions: { ...EMPTY_CONTRIBUTIONS, "skipped-no-model": 3 },
      pricesUnparsed: 0,
    });
    // `usage` is D1's own accounting, so its exact numbers are the database's to state; what
    // this suite asserts is that a write really happened.
    const usage = body.usage as { rowsRead: number; rowsWritten: number };
    expect(typeof usage.rowsRead).toBe("number");
    expect(usage.rowsWritten).toBeGreaterThan(0);

    const stored = await rows<Record<string, unknown>>(
      "SELECT * FROM listings ORDER BY listing_id",
    );
    expect(stored).toHaveLength(3);
    expect(stored[0]).toMatchObject({
      source: SOURCE,
      listing_id: "L-901",
      market_key: MARKET_KEY,
      component_type: "psu",
      model_key: null,
      // The '' sentinel, applied by recordSightings. A NULL here would break ON CONFLICT and
      // every `WHERE variant_key = ?`.
      variant_key: "",
      title: "title for L-901",
      price_cents: 300000,
      location_text: "Ottawa, Ontario",
      url: "https://www.facebook.com/marketplace/item/L-901",
      validity: "VALID",
      first_seen_at: REQUEST_CLOCK,
      last_seen_at: REQUEST_CLOCK,
    });
  });

  /**
   * L2 asserts THE WHOLE seven-key contributions map, not one key. MEASURED: `skipped-no-price`
   * is structurally UNREACHABLE while `modelKey` is always null, because `skipReason` tests the
   * model key first -- so a test asserting `skipped-no-price: 1` for the unparseable price would
   * be asserting a number that is always 0. `pricesUnparsed` is the only signal for it, and a
   * non-zero `skipped-invalid` would mean `validity` stopped being VALID.
   */
  it("L2: CA$0 is zero, an unparseable price is null, and neither reaches the benchmark", async () => {
    const response = await post(
      envelope([
        listing("L-901", { priceText: "CA$3,000" }),
        listing("L-902", { priceText: "CA$0" }),
        listing("L-903", { priceText: "Free" }),
      ]),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.pricesUnparsed).toBe(1);
    expect(body.contributions).toEqual({ ...EMPTY_CONTRIBUTIONS, "skipped-no-model": 3 });

    const prices = await rows<{ listing_id: string; price_cents: number | null }>(
      "SELECT listing_id, price_cents FROM listings ORDER BY listing_id",
    );
    expect(prices).toEqual([
      { listing_id: "L-901", price_cents: 300000 },
      // ZERO, not null. `cents || null` would store NULL here and this row is PR #6's case.
      { listing_id: "L-902", price_cents: 0 },
      { listing_id: "L-903", price_cents: null },
    ]);
    expect(await count("price_observations")).toBe(0);
    expect(await count("model_stats")).toBe(0);
  });

  /**
   * L3 IS THE MOST IMPORTANT TEST IN THIS FILE. The wire format has no field for anything that
   * can move money, and a client that sends one is REFUSED, not silently corrected: a
   * `{...raw, modelKey: null}` implementation answers 200 AND stores a poisoned row, so this
   * test goes red twice for that mutation.
   */
  it.each([
    ["priceCents", { priceCents: 999999 }],
    ["modelKey", { modelKey: "rtx-4090" }],
    ["variantKey", { variantKey: "16gb" }],
    ["validity", { validity: "VALID" }],
    ["observedAt", { observedAt: "2026-01-01T00:00:00.000Z" }],
    ["__proto__", JSON.parse('{"__proto__":{"modelKey":"rtx-4090"}}') as Record<string, unknown>],
  ])("L3: a listing carrying %s is refused and nothing is stored", async (field, extra) => {
    const response = await post(envelope([listing("L-901", extra)]));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_LISTINGS", field: `listings[0].${field}` },
    });
    expect(await count("listings")).toBe(0);
    expect(await count("evaluation_tasks")).toBe(0);
  });

  it.each([
    ["an invented envelope key", { limit: 15 }, "limit"],
    ["modelKey on the envelope", { modelKey: "rtx-4090" }, "modelKey"],
    ["__proto__ on the envelope", JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>, "__proto__"],
  ])("L4: %s is refused, not dropped", async (_label, extra, field) => {
    const response = await post(envelope(THREE, extra));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_LISTINGS", field },
    });
    expect(await count("listings")).toBe(0);
  });

  it.each([
    ["listingId missing", { listingId: undefined }, "listings[0].listingId"],
    ["listingId empty", { listingId: "" }, "listings[0].listingId"],
    ["listingId 65 characters", { listingId: "a".repeat(65) }, "listings[0].listingId"],
    ["listingId with a slash", { listingId: "a/b" }, "listings[0].listingId"],
    ["title missing", { title: undefined }, "listings[0].title"],
    ["title empty", { title: "" }, "listings[0].title"],
    ["title 301 characters", { title: "t".repeat(301) }, "listings[0].title"],
    ["an http url", { url: "http://www.facebook.com/marketplace/item/1" }, "listings[0].url"],
    ["a javascript url", { url: "javascript:alert(1)" }, "listings[0].url"],
    ["not a url at all", { url: "not a url" }, "listings[0].url"],
    ["url 513 characters", { url: `https://e.invalid/${"u".repeat(513 - 18)}` }, "listings[0].url"],
    ["a numeric locationText", { locationText: 123 }, "listings[0].locationText"],
    ["a numeric priceText", { priceText: 123 }, "listings[0].priceText"],
    ["priceText 33 characters", { priceText: "C".repeat(33) }, "listings[0].priceText"],
    // NULL and ABSENT are accepted below; "" is still a shape error, because the collector's
    // parser maps an empty value to null itself and never emits "".
    ["an empty priceText", { priceText: "" }, "listings[0].priceText"],
    ["an empty locationText", { locationText: "" }, "listings[0].locationText"],
  ])("L5: %s is a 400 naming the field, and D1 is untouched", async (_label, overrides, field) => {
    const entry = listing("L-901", overrides);
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete (entry as Record<string, unknown>)[key];
    }

    const response = await post(envelope([entry]));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_LISTINGS", field },
    });
    expect(await count("listings")).toBe(0);
  });

  it.each([
    ["a listing that is null", null],
    ["a listing that is an array", []],
    ["a listing that is a string", "x"],
  ])("L5: %s is a 400 naming its index", async (_label, entry) => {
    const response = await post(envelope([entry]));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_LISTINGS", field: "listings[0]" },
    });
    expect(await count("listings")).toBe(0);
  });

  /**
   * THE TWO FIELDS THE SOURCE ACTUALLY OMITS ARE NULLABLE, AND THIS IS A REGRESSION TEST.
   * Requiring a string here was a live total-collection-stall: the collector's parser produces
   * `null` for a price-less or location-less listing and its classifier accepts the page, so ONE
   * such listing anywhere answered 400 and stored NOTHING for the whole batch, every run, until
   * it aged off the source. `Listing.locationText` and `Listing.priceCents` are already nullable
   * in storage, and this route already stores an UNPARSEABLE price as NULL rather than refusing
   * the listing -- a MISSING one is the same situation.
   */
  it.each([
    ["priceText is null", { priceText: null }, "price_cents", 1],
    ["priceText is absent", { priceText: undefined }, "price_cents", 1],
    ["locationText is null", { locationText: null }, "location_text", 0],
    ["locationText is absent", { locationText: undefined }, "location_text", 0],
  ])("L5: %s is accepted and stored as NULL", async (_label, overrides, column, unparsed) => {
    const entry = listing("L-901", overrides) as Record<string, unknown>;
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete entry[key];
    }

    const response = await post(envelope([entry]));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcomes: { NEW: 1, FAILED: 0 },
      pricesUnparsed: unparsed,
    });
    const stored = await database.db
      .prepare(`SELECT ${column} AS value FROM listings WHERE listing_id = 'L-901'`)
      .first<{ value: unknown }>();
    expect(stored?.value).toBeNull();
  });

  it("L5: one listing with no price and no location does not block the other two", async () => {
    const response = await post(
      envelope([
        listing("L-901"),
        listing("L-902", { priceText: null, locationText: null }),
        listing("L-903"),
      ]),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      received: 3,
      stored: 3,
      outcomes: { NEW: 3, FAILED: 0 },
      pricesUnparsed: 1,
    });
    expect(await count("listings")).toBe(3);
  });

  /** The ACCEPTED side of every boundary: `<` and `<=` are one character apart. */
  it("L5: a listing at every field maximum is accepted", async () => {
    const response = await post(
      envelope([
        listing("L-901", {
          listingId: "a".repeat(64),
          title: "t".repeat(300),
          url: `https://e.invalid/${"u".repeat(512 - 18)}`,
          locationText: "l".repeat(120),
          priceText: "C".repeat(32),
        }),
      ]),
    );

    expect(response.status).toBe(200);
    expect(await count("listings")).toBe(1);
  });

  it.each([
    ["an empty source", { source: "" }],
    ["an upper-case source", { source: "Facebook" }],
    ["a 65-character source", { source: `a${"b".repeat(64)}` }],
    ["a source with a space", { source: "a b" }],
    // MEASURED: JavaScript's `$` does not match before a trailing newline. Python's does.
    ["a source with a trailing newline", { source: "facebook\n" }],
    ["an unknown componentType", { componentType: "gpu_cooler" }],
    ["an upper-case componentType", { componentType: "GPU" }],
    ["a missing componentType", { componentType: undefined }],
    // `key in SET` instead of Object.hasOwn admits every Object.prototype member.
    ["componentType 'toString'", { componentType: "toString" }],
    ["a missing market", { market: undefined }],
    ["a string latitude", { market: { latitude: "43", longitude: -79, radiusKm: 18 } }],
    ["latitude 91", { market: { latitude: 91, longitude: -79, radiusKm: 18 } }],
    ["a NaN longitude", { market: { latitude: 43, longitude: Number.NaN, radiusKm: 18 } }],
    // THE NAMED TRAP: marketKey throws below 1 km, and recordSightings computes it OUTSIDE its
    // per-listing try/catch, so an unvalidated 0.4 is a 503 or a bare 500 rather than a 400.
    ["a sub-kilometre radius", { market: { latitude: 43, longitude: -79, radiusKm: 0.4 } }],
  ])("L6: %s is a 400 and never a 500, and D1 is untouched", async (_label, overrides) => {
    const payload: Record<string, unknown> = {
      source: SOURCE,
      componentType: COMPONENT_TYPE,
      market: MARKET,
      listings: THREE,
      ...overrides,
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete payload[key];
    }

    const response = await post(JSON.stringify(payload));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_LISTINGS" },
    });
    expect(await count("listings")).toBe(0);
  });

  /**
   * `market` IS THE THIRD LEVEL, and it used to be the one with no whitelist: the handler
   * reconstructs `{latitude, longitude, radiusKm}` explicitly, so extras were silently dropped.
   * Harmless in itself; the shape it allows is a future `market.currency` that a caller believes
   * was honoured and that was thrown away.
   */
  it.each([
    ["an invented key", { latitude: 43, longitude: -79, radiusKm: 18, currency: "CAD" }, "market.currency"],
    [
      "__proto__",
      JSON.parse('{"latitude":43,"longitude":-79,"radiusKm":18,"__proto__":{"x":1}}') as Record<string, unknown>,
      "market.__proto__",
    ],
  ])("L6: %s inside market is refused, not dropped", async (_label, market, field) => {
    const response = await post(envelope(THREE, { market }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_LISTINGS", field },
    });
    expect(await count("listings")).toBe(0);
  });

  it("L6: a radius that ROUNDS to one kilometre is accepted", async () => {
    const response = await post(
      envelope(THREE, { market: { latitude: 43, longitude: -79, radiusKm: 0.5 } }),
    );

    expect(response.status).toBe(200);
    const stored = await database.db
      .prepare("SELECT market_key FROM listings LIMIT 1")
      .first<{ market_key: string }>();
    expect(stored?.market_key).toBe("43.0000,-79.0000|1km");
  });

  it("L7: the batch bounds are exact, and a refused batch writes nothing", async () => {
    const empty = await post(envelope([]));
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toMatchObject({
      error: { code: "INGEST_EMPTY_BATCH" },
    });

    const many = (n: number) =>
      Array.from({ length: n }, (_, index) => listing(`L-${String(index).padStart(4, "0")}`));

    const atLimit = await post(envelope(many(MAX_LISTINGS_PER_BATCH)));
    expect(atLimit.status).toBe(200);
    expect(await count("listings")).toBe(MAX_LISTINGS_PER_BATCH);

    await truncateAll(database.db);
    const overLimit = await post(envelope(many(MAX_LISTINGS_PER_BATCH + 1)));
    expect(overLimit.status).toBe(400);
    await expect(overLimit.json()).resolves.toMatchObject({
      error: { code: "INGEST_BATCH_TOO_LARGE" },
    });
    expect(await count("listings")).toBe(0);
  }, 60_000);

  /** A stream that hands out `count` chunks and records which ones were asked for. */
  const chunked = (count: number, size: number, pulled: number[]) =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const index = pulled.length;
        if (index >= count) {
          controller.close();
          return;
        }
        pulled.push(index);
        controller.enqueue(new Uint8Array(size).fill(97));
      },
    });

  const streamed = (body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
    handleRequest(
      new Request(`${workerOrigin}/api/listings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Collector-Token": token, ...headers },
        body,
        // @ts-expect-error undici requires `duplex` for a ReadableStream body, and
        // @cloudflare/workers-types' RequestInit has no such field.
        duplex: "half",
      }),
      environment(),
      dependencies,
    );

  it("L8a: a DECLARED size over the cap is refused without reading the body", async () => {
    const pulled: number[] = [];
    const response = await streamed(chunked(200, 1024, pulled), {
      "Content-Length": String(MAX_INGEST_BODY_BYTES + 1),
    });

    expect(response.status).toBe(413);
    // MEASURED: the stream primes ITSELF with one chunk on its own schedule, so [0] is what a
    // handler that read nothing leaves behind. Dropping the declared check makes
    // `readBoundedBody` drain 129 of these 1 KB chunks before the byte count crosses the cap.
    expect(pulled).toEqual([0]);
  });

  it("L8b: a chunked body with NO Content-Length is still bounded, and stops early", async () => {
    const pulled: number[] = [];
    // No Content-Length at all: MEASURED that a stream body carries none, so the declared check
    // above is skipped entirely and only the streaming check can refuse this.
    const response = await streamed(chunked(10, 100_000, pulled));

    expect(response.status).toBe(413);
    // Two 100 KB chunks already exceed 128 KiB, so the reader cancels and index 3 of the ten
    // available chunks is never asked for. `request.text()` buffers all ten.
    expect(pulled).toEqual([0, 1, 2]);
  });

  /** 100 listings at EVERY field maximum in ASCII -- the worst batch the cap must admit. */
  const maximalListings = (title: string) =>
    Array.from({ length: 100 }, (_, index) => ({
      listingId: `L${String(index).padStart(63, "0")}`,
      title,
      priceText: "C".repeat(32),
      locationText: "l".repeat(120),
      url: `https://e.invalid/${"u".repeat(512 - 18)}`,
    }));

  it("L8c: a 100-listing batch at every ASCII field maximum is accepted", async () => {
    const payload = envelope(maximalListings("t".repeat(300)));
    expect(new TextEncoder().encode(payload).byteLength).toBeLessThan(MAX_INGEST_BODY_BYTES);

    const response = await post(payload);
    expect(response.status).toBe(200);
    expect(await count("listings")).toBe(100);
  }, 60_000);

  /**
   * L8d HAS NO KILLING MUTATION AND IS NOT CLAIMED AS A GUARD. It documents the deliberate gap
   * in the body cap: every field limit is a `.length` limit, one UTF-16 unit can cost three
   * UTF-8 bytes, so a batch that passes every per-field bound can still exceed the byte cap and
   * be answered 413 rather than 400. Raising MAX_INGEST_BODY_BYTES is the fix if a future
   * collector needs it; discovering this in production is not.
   */
  it("L8d: the same batch with 3-byte characters is 413, not 400 -- the documented gap", async () => {
    const payload = envelope(maximalListings("あ".repeat(300)));
    expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(MAX_INGEST_BODY_BYTES);

    const response = await post(payload);
    expect(response.status).toBe(413);
    expect(await count("listings")).toBe(0);
  });

  /**
   * L8e PINS THE ONE BYTE `>` AND `>=` DISAGREE ABOUT. No other test in this file can: the
   * largest legal 100-listing ASCII batch is ~110 KB and cannot be padded to exactly 128 KiB
   * without breaking a per-field bound, so the cap itself is unreachable from a real payload.
   * `readBoundedBody` takes the cap as an argument precisely so it can be pinned directly.
   */
  it("L8e: a body of exactly the cap is accepted and one byte more is not", async () => {
    const cap = 777;
    const body = (bytes: number) =>
      new Request(`${workerOrigin}/api/listings`, { method: "POST", body: "x".repeat(bytes) });

    await expect(readBoundedBody(body(cap), cap)).resolves.toEqual({
      ok: true,
      text: "x".repeat(cap),
    });
    await expect(readBoundedBody(body(cap + 1), cap)).resolves.toEqual({ ok: false });
  });

  it.each([
    ["text/plain", 415, { "Content-Type": "text/plain" }],
    ["application/notjson", 415, { "Content-Type": "application/notjson" }],
    ["application/json; charset=utf-8", 200, { "Content-Type": "application/json; charset=utf-8" }],
  ])("L9: a %s body is answered %i", async (_label, status, headers) => {
    const response = await post(envelope(THREE), { headers });
    expect(response.status).toBe(status);
  });

  it("L9: a missing Content-Type is a 415", async () => {
    const request = new Request(`${workerOrigin}/api/listings`, {
      method: "POST",
      headers: { "X-Collector-Token": token },
      body: envelope(THREE),
    });
    // Genuinely absent, not "text/plain": undici gives a string body a default Content-Type,
    // so the header is removed to exercise the `?? ""` branch a header-less caller reaches.
    request.headers.delete("Content-Type");
    expect(request.headers.get("Content-Type")).toBeNull();

    const response = await handleRequest(request, environment(), dependencies);
    expect(response.status).toBe(415);
  });

  it.each([
    ["a truncated object", "{"],
    ["an array", "[]"],
    ["a bare string", '"x"'],
    ["the literal null", "null"],
  ])("L10: %s is 400 INVALID_JSON", async (_label, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_JSON" } });
  });

  /** The shape a broken collector actually sends. `request.body` is null, the text is "". */
  it("L10: a POST with no body at all is 400 INVALID_JSON", async () => {
    const response = await post(null);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_JSON" } });
  });

  /**
   * L11 pins invariant 2: `recordSightings` is CALLED, not reimplemented. A direct INSERT would
   * raise a primary-key conflict on the second post; an upsert that ignored the content hash
   * would report NEW twice. The two DIFFERENT contribution maps are measured behaviour.
   */
  it("L11: posting the same batch twice is idempotent and reports it", async () => {
    const first = (await (await post(envelope(THREE))).json()) as Record<string, unknown>;
    expect(first.outcomes).toMatchObject({ NEW: 3, CHANGED: 0, UNCHANGED: 0, FAILED: 0 });
    expect(first.contributions).toEqual({ ...EMPTY_CONTRIBUTIONS, "skipped-no-model": 3 });
    expect(await count("listings")).toBe(3);
    expect(await count("evaluation_tasks")).toBe(3);

    const second = (await (await post(envelope(THREE))).json()) as Record<string, unknown>;
    expect(second.outcomes).toMatchObject({ NEW: 0, CHANGED: 0, UNCHANGED: 3, FAILED: 0 });
    expect(second.contributions).toEqual({ ...EMPTY_CONTRIBUTIONS, none: 3 });
    expect(await count("listings")).toBe(3);
    expect(await count("evaluation_tasks")).toBe(3);
  });

  /**
   * L12: the handler does NOT de-duplicate. `recordSightings` already keeps the LAST entry per
   * id, and `received` vs `stored` makes that observable without reimplementing it.
   */
  it("L12: a repeated listing id is last-wins, and the counts say so", async () => {
    const response = await post(
      envelope([
        listing("L-901", { title: "the first title" }),
        listing("L-902"),
        listing("L-903"),
        listing("L-901", { title: "the last title" }),
      ]),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ received: 4, stored: 3 });
    const stored = await database.db
      .prepare("SELECT title FROM listings WHERE listing_id = 'L-901'")
      .first<{ title: string }>();
    expect(stored?.title).toBe("the last title");
  });

  it("L13: a missing binding is a 503 -- but only AFTER the credential is checked", async () => {
    const withToken = await post(envelope(THREE), { env: environment({ DB: undefined }) });
    expect(withToken.status).toBe(503);
    await expect(withToken.json()).resolves.toMatchObject({
      error: { code: "DATABASE_UNAVAILABLE" },
    });

    const withoutToken = await handleRequest(
      new Request(`${workerOrigin}/api/listings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: envelope(THREE),
      }),
      environment({ DB: undefined }),
      dependencies,
    );
    expect(withoutToken.status).toBe(401);
    await expect(withoutToken.json()).resolves.toMatchObject({
      error: { code: "AUTH_TOKEN_MISSING" },
    });
  });

  it("L14a: a D1 that fails on the classification read is a 503 with the full envelope", async () => {
    const response = await post(envelope(THREE), {
      env: environment({ DB: withFailingBatches(database.db, () => true) }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INGEST_STORAGE_FAILED" },
    });
    expect(response.headers.get("Vary")).toBe("Origin");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  /**
   * L14b IS THE TEST THIS ROUND EXISTS FOR, and L14a cannot replace it. MEASURED both ways: a
   * D1 that rejects EVERY call throws on the classification read and answers 503 WITH OR
   * WITHOUT the fix, so it cannot see the defect. The killing shape is "the first batch
   * resolves and every subsequent one rejects": without the all-FAILED check this returns
   * 200 {"stored":3,...,"FAILED":3} with zero rows written, and the collector exits 0.
   */
  it("L14b: a total write failure is a 503, not a 200 that says FAILED", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await post(envelope(THREE), {
      env: environment({ DB: withFailingBatches(database.db, (index) => index > 0) }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INGEST_STORAGE_FAILED" },
    });
    expect(await count("listings")).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  /**
   * L14c guards the OVER-BROAD version of L14b's fix. `recordSightings` deliberately never lets
   * one poisoned listing abort a scan, and refusing the whole batch would discard the rows that
   * did land. 503-on-any-FAILED makes this red.
   */
  it("L14c: a PARTIAL write failure is a truthful 200 and the good rows are stored", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await post(envelope(THREE), {
      env: environment({ DB: withFailingBatches(database.db, (index) => index === 2) }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      received: 3,
      stored: 3,
      outcomes: { NEW: 2, CHANGED: 0, UNCHANGED: 0, FAILED: 1 },
    });
    const stored = await rows<{ listing_id: string }>(
      "SELECT listing_id FROM listings ORDER BY listing_id",
    );
    expect(stored.map((row) => row.listing_id)).toEqual(["L-901", "L-903"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  /**
   * L15: `SightingResult.error` carries D1's message. A caller holding only a bearer secret
   * must not learn the schema from a failure.
   */
  it("L15: a failure's error string never reaches the response body", () => {
    const report: SightingReport = {
      results: [
        { listingId: "L-901", outcome: "NEW", contribution: "skipped-no-model" },
        {
          listingId: "L-902",
          outcome: "FAILED",
          contribution: "none",
          error: "no such table: listings",
        },
      ],
      usage: { rowsRead: 3, rowsWritten: 5 },
    };

    const body = summarizeReport(report, 2, 1);

    expect(body).toEqual({
      received: 2,
      stored: 2,
      outcomes: { NEW: 1, CHANGED: 0, UNCHANGED: 0, FAILED: 1 },
      contributions: { ...EMPTY_CONTRIBUTIONS, none: 1, "skipped-no-model": 1 },
      pricesUnparsed: 1,
      usage: { rowsRead: 3, rowsWritten: 5 },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("error");
    expect(serialized).not.toContain("no such table");
  });
});
