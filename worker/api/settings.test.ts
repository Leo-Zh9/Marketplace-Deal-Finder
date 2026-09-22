// @vitest-environment node

/**
 * GET and PUT /api/settings driven through the REAL handleRequest -- real origin check, real
 * Firebase token, real body parsing, real D1 with the real migrations. Nothing is stubbed
 * except the clock and the certificate source, both of which Phase 2 already injects.
 */

import type { AuthDependencies } from "../auth/verifyFirebaseToken";
import { handleRequest, type Environment } from "../index";
import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";
import { createTokenFactory } from "../testing/firebaseTokens";
import { MAX_SETTINGS_BODY_BYTES } from "./settings";

const projectId = "settings-api-test";
const appOrigin = "https://deals.pages.dev";
const workerOrigin = "https://api.example.workers.dev";
const owner = "operator@example.com";
const REQUEST_CLOCK = 1_800_000_000;

let database!: TestDatabase;
let factory!: Awaited<ReturnType<typeof createTokenFactory>>;
let dependencies!: AuthDependencies;
let authorization!: string;

beforeAll(async () => {
  database = await createTestDatabase();
  factory = await createTokenFactory(projectId);
  dependencies = { keys: factory.keys, now: () => REQUEST_CLOCK };
  authorization = `Bearer ${await factory.sign({ now: REQUEST_CLOCK, email: owner })}`;
}, 120_000);

afterAll(async () => {
  await database.dispose();
});

beforeEach(async () => {
  await truncateAll(database.db);
});

const environment = (overrides: Partial<Environment> = {}): Environment => ({
  APP_ENV: "production",
  FIREBASE_PROJECT_ID: projectId,
  ALLOWED_ORIGINS: JSON.stringify([appOrigin]),
  APPROVED_EMAILS: JSON.stringify([owner]),
  DB: database.db,
  ...overrides,
});

const get = () =>
  handleRequest(
    new Request(`${workerOrigin}/api/settings`, {
      headers: { Authorization: authorization, Origin: appOrigin },
    }),
    environment(),
    dependencies,
  );

const put = (body: string, headers: Record<string, string> = {}) =>
  handleRequest(
    new Request(`${workerOrigin}/api/settings`, {
      method: "PUT",
      body,
      headers: {
        Authorization: authorization,
        Origin: appOrigin,
        "Content-Type": "application/json",
        ...headers,
      },
    }),
    environment(),
    dependencies,
  );

const putJson = (payload: unknown, headers: Record<string, string> = {}) =>
  put(JSON.stringify(payload), headers);

const revisionRows = async () =>
  (
    await database.db
      .prepare(
        "SELECT revision, mode, minimum_discount_percent, maximum_price_cents, created_at FROM search_revisions ORDER BY revision",
      )
      .all()
  ).results;

/**
 * Deliberately unlike anything else in the suite: BOTH mode, a fractional percent that is not
 * 20, and a price that is not 50000 or 60000. No two of these three values coincide, and none
 * is a column default.
 */
const FIRST = { mode: "BOTH", minimumDiscountPercent: 23.5, maximumPriceCents: 74_900 };

describe("the settings API", () => {
  it("A1: GET reports no settings as an empty value, not as an error", async () => {
    const response = await get();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ settings: null });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(appOrigin);
  });

  it("A2: PUT creates revision 0, stamps the request clock, and GET reads it back", async () => {
    const written = await putJson(FIRST);

    expect(written.status).toBe(200);
    await expect(written.json()).resolves.toEqual({
      settings: {
        mode: "BOTH",
        minimumDiscountPercent: 23.5,
        maximumPriceCents: 74_900,
        searchRevision: 0,
      },
      changed: true,
    });
    expect(await revisionRows()).toEqual([
      {
        revision: 0,
        mode: "BOTH",
        minimum_discount_percent: 23.5,
        maximum_price_cents: 74_900,
        created_at: REQUEST_CLOCK,
      },
    ]);

    const read = await get();
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual({
      settings: {
        mode: "BOTH",
        minimumDiscountPercent: 23.5,
        maximumPriceCents: 74_900,
        searchRevision: 0,
      },
    });
  });

  it("A3: an identical PUT reports changed:false and writes no revision; a different one bumps", async () => {
    await putJson(FIRST);

    const again = await putJson(FIRST);
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toMatchObject({ changed: false });
    expect(await revisionRows()).toHaveLength(1);

    const moved = await putJson({ ...FIRST, maximumPriceCents: 61_250 });
    expect(moved.status).toBe(200);
    await expect(moved.json()).resolves.toEqual({
      settings: {
        mode: "BOTH",
        minimumDiscountPercent: 23.5,
        maximumPriceCents: 61_250,
        searchRevision: 1,
      },
      changed: true,
    });
    expect(await revisionRows()).toHaveLength(2);
  });

  it("A4: the response reports the stored value, so a field the mode made inert comes back null", async () => {
    const response = await putJson({
      mode: "DISCOUNT",
      minimumDiscountPercent: 41.25,
      maximumPriceCents: 88_800,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      settings: {
        mode: "DISCOUNT",
        minimumDiscountPercent: 41.25,
        maximumPriceCents: null,
        searchRevision: 0,
      },
      changed: true,
    });
    expect(await revisionRows()).toEqual([
      {
        revision: 0,
        mode: "DISCOUNT",
        minimum_discount_percent: 41.25,
        maximum_price_cents: null,
        created_at: REQUEST_CLOCK,
      },
    ]);
  });

  it("A5: a field this API cannot store is refused by name, and nothing is written", async () => {
    const response = await putJson({
      ...FIRST,
      radiusKm: 25,
      location: { label: "Waterloo, ON" },
      components: ["gpu"],
      models: { gpu: ["RTX_4070_SUPER"] },
      dealRule: { type: "discount", minimumDiscountPercent: 25 },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "SETTINGS_FIELD_UNSUPPORTED",
        message: "The request contains fields this API cannot store.",
        fields: ["components", "dealRule", "location", "models", "radiusKm"],
      },
    });
    expect(await revisionRows()).toEqual([]);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(appOrigin);
  });

  it("A6: a typo is refused the same way, not silently dropped", async () => {
    const response = await putJson({ ...FIRST, maximumPriceCent: 74_900 });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "SETTINGS_FIELD_UNSUPPORTED", fields: ["maximumPriceCent"] },
    });
    expect(await revisionRows()).toEqual([]);
  });

  it.each([
    ["absent", undefined],
    ["text/plain", "text/plain"],
    ["a near miss", "application/jsonx"],
    ["a JSON dialect", "application/json-patch+json"],
    ["form encoded", "application/x-www-form-urlencoded"],
  ])("A7: refuses a %s content type with 415 and writes nothing", async (_label, contentType) => {
    const response = await handleRequest(
      new Request(`${workerOrigin}/api/settings`, {
        method: "PUT",
        body: JSON.stringify(FIRST),
        headers:
          contentType === undefined
            ? { Authorization: authorization, Origin: appOrigin }
            : { Authorization: authorization, Origin: appOrigin, "Content-Type": contentType },
      }),
      environment(),
      dependencies,
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNSUPPORTED_MEDIA_TYPE" },
    });
    expect(await revisionRows()).toEqual([]);
  });

  it.each([
    ["application/json", 200],
    ["application/json; charset=utf-8", 200],
    ["APPLICATION/JSON", 200],
    ["application/json ; charset=utf-8", 200],
  ])("A8: accepts the %s spelling", async (contentType, status) => {
    const response = await putJson(FIRST, { "Content-Type": contentType });
    expect(response.status).toBe(status);
  });

  it("A9: a body over the cap is refused, at the boundary and by both measures", async () => {
    // A well-formed object padded to EXACTLY the cap, and the same object one byte longer.
    const pad = (bytes: number) => {
      const skeleton = JSON.stringify({ ...FIRST, mode: "" });
      return JSON.stringify({ ...FIRST, mode: "B".repeat(bytes - skeleton.length) });
    };
    // PINNED TO A LITERAL. Everything below is written in terms of the constant, so without
    // this line the whole test re-derives itself from whatever the cap happens to be and a
    // change to it proves nothing. The cap is a security parameter: it bounds what an
    // approved caller can push into the isolate and what the error body can echo back.
    expect(MAX_SETTINGS_BODY_BYTES).toBe(4096);
    const atCap = pad(MAX_SETTINGS_BODY_BYTES);
    const overCap = pad(MAX_SETTINGS_BODY_BYTES + 1);
    expect(new TextEncoder().encode(atCap).byteLength).toBe(MAX_SETTINGS_BODY_BYTES);
    expect(new TextEncoder().encode(overCap).byteLength).toBe(MAX_SETTINGS_BODY_BYTES + 1);

    // At the cap the size gate passes and the request dies on its CONTENT, not its size.
    const boundary = await put(atCap);
    expect(boundary.status).toBe(400);
    await expect(boundary.json()).resolves.toMatchObject({
      error: { code: "INVALID_SETTINGS" },
    });

    const measured = await put(overCap);
    expect(measured.status).toBe(413);
    await expect(measured.json()).resolves.toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });

    // ...and a body AT the cap that declares the cap exactly is NOT refused: the declared
    // check has its own boundary and `>=` here would 413 a legal request.
    expect(await put(atCap, { "Content-Length": String(MAX_SETTINGS_BODY_BYTES) })).toHaveProperty(
      "status",
      400,
    );

    // A tiny body that DECLARES an oversized length is refused before it is read.
    const declared = await put(JSON.stringify(FIRST), {
      "Content-Length": String(MAX_SETTINGS_BODY_BYTES + 1),
    });
    expect(declared.status).toBe(413);

    // A multi-byte character counts as its bytes, not its characters.
    const wide = "é".repeat(MAX_SETTINGS_BODY_BYTES / 2);
    expect(wide.length).toBeLessThan(MAX_SETTINGS_BODY_BYTES);
    expect(await put(JSON.stringify({ mode: wide }))).toHaveProperty("status", 413);

    expect(await revisionRows()).toEqual([]);
  });

  it.each([
    ["truncated", "{"],
    ["empty", ""],
    ["an array", "[]"],
    ["the literal null", "null"],
    ["a bare string", '"BOTH"'],
    ["a number", "7"],
    ["trailing junk", '{"mode":"BOTH"} trailing'],
  ])("A10: refuses %s with 400 INVALID_JSON and writes nothing", async (_label, body) => {
    const response = await put(body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_JSON" } });
    expect(await revisionRows()).toEqual([]);
  });

  it.each([
    ["no mode", { minimumDiscountPercent: 23.5 }],
    ["a lowercase mode", { mode: "discount", minimumDiscountPercent: 23.5 }],
    ["an invented mode", { mode: "WISHFUL", minimumDiscountPercent: 23.5 }],
    ["a non-string mode", { mode: 3, minimumDiscountPercent: 23.5 }],
    ["DISCOUNT with no percent", { mode: "DISCOUNT" }],
    ["DISCOUNT with a null percent", { mode: "DISCOUNT", minimumDiscountPercent: null }],
    ["BOTH with no price", { mode: "BOTH", minimumDiscountPercent: 23.5 }],
    ["MAXIMUM_PRICE with no price", { mode: "MAXIMUM_PRICE" }],
    ["a percent above 100", { mode: "DISCOUNT", minimumDiscountPercent: 100.01 }],
    ["a negative percent", { mode: "DISCOUNT", minimumDiscountPercent: -0.01 }],
    ["a stringly percent", { mode: "DISCOUNT", minimumDiscountPercent: "23.5" }],
    ["a negative price", { mode: "MAXIMUM_PRICE", maximumPriceCents: -1 }],
    ["a fractional price", { mode: "MAXIMUM_PRICE", maximumPriceCents: 1.5 }],
    ["a stringly price", { mode: "MAXIMUM_PRICE", maximumPriceCents: "74900" }],
    // SHAPE is checked for every field, MEANING only for the fields the mode uses. A field
    // the mode makes inert is still not allowed to be a string.
    [
      "a stringly price the mode ignores",
      { mode: "DISCOUNT", minimumDiscountPercent: 41.25, maximumPriceCents: "74900" },
    ],
    [
      "a stringly percent the mode ignores",
      { mode: "MAXIMUM_PRICE", maximumPriceCents: 74_900, minimumDiscountPercent: "23.5" },
    ],
    ["a boolean price", { mode: "MAXIMUM_PRICE", maximumPriceCents: true }],
    // THE ONLY ROWS WHERE THE MODE ENUM IS THE SOLE POSSIBLE REJECTOR: both numbers are
    // present and legal, so validateSettings has nothing of its own to complain about.
    [
      "a prefix of a real mode",
      { mode: "BOT", minimumDiscountPercent: 23.5, maximumPriceCents: 74_900 },
    ],
    [
      "an invented mode carrying both numbers",
      { mode: "WISHFUL", minimumDiscountPercent: 23.5, maximumPriceCents: 74_900 },
    ],
  ])("A11: refuses %s with 400 INVALID_SETTINGS and writes nothing", async (_label, payload) => {
    const response = await putJson(payload);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_SETTINGS" } });
    expect(await revisionRows()).toEqual([]);
  });

  it.each([
    // Raw text, because JSON.stringify(Infinity) is "null" -- only the wire form carries it.
    ["an overflowing percent", '{"mode":"DISCOUNT","minimumDiscountPercent":1e999}'],
    ["an overflowing price", '{"mode":"MAXIMUM_PRICE","maximumPriceCents":1e999}'],
  ])("A11b: refuses %s with 400 INVALID_SETTINGS and writes nothing", async (_label, body) => {
    const response = await put(body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_SETTINGS" } });
    expect(await revisionRows()).toEqual([]);
  });

  it.each([
    ["a zero percent", { mode: "DISCOUNT", minimumDiscountPercent: 0 }, 0, null],
    ["a full percent", { mode: "DISCOUNT", minimumDiscountPercent: 100 }, 100, null],
    ["a zero price", { mode: "MAXIMUM_PRICE", maximumPriceCents: 0 }, null, 0],
    // Absent and explicit null are the same thing for a field the mode does not use.
    [
      "an explicitly null inert price",
      { mode: "DISCOUNT", minimumDiscountPercent: 41.25, maximumPriceCents: null },
      41.25,
      null,
    ],
    [
      "an explicitly null inert percent",
      { mode: "MAXIMUM_PRICE", maximumPriceCents: 74_900, minimumDiscountPercent: null },
      null,
      74_900,
    ],
  ])(
    "A12: accepts %s -- the legal side of each boundary",
    async (_label, payload, percent, cents) => {
      const response = await putJson(payload);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        settings: { minimumDiscountPercent: percent, maximumPriceCents: cents },
        changed: true,
      });
    },
  );

  it("A14: with no injected dependencies the request uses the real clock", async () => {
    // THE PRODUCTION PATH. Every other test in this file injects `dependencies`, so nothing
    // else here executes the branch `worker.fetch` actually takes. APP_ENV=local on a
    // loopback URL is Phase 2's guarded identity, which is what lets this run with no token
    // and no certificate fetch.
    const before = Math.floor(Date.now() / 1000);
    const response = await handleRequest(
      new Request("http://localhost:8787/api/settings", {
        method: "PUT",
        body: JSON.stringify(FIRST),
        headers: { "Content-Type": "application/json" },
      }),
      {
        APP_ENV: "local",
        ALLOWED_ORIGINS: JSON.stringify(["http://localhost:5173"]),
        DB: database.db,
      },
    );
    const after = Math.floor(Date.now() / 1000);

    expect(response.status).toBe(200);
    const [row] = (await revisionRows()) as Array<{ created_at: number }>;
    expect(row.created_at).toBeGreaterThanOrEqual(before);
    expect(row.created_at).toBeLessThanOrEqual(after);
    // ...and that is a different clock from the one every other test injects.
    expect(row.created_at).not.toBe(REQUEST_CLOCK);
  });

  it("A13: a storage failure is a 503, not a 400 and not an unhandled throw", async () => {
    const broken = {
      prepare: () => {
        throw new Error("D1_ERROR: database is unavailable");
      },
      batch: () => {
        throw new Error("D1_ERROR: database is unavailable");
      },
    } as unknown as D1Database;

    const write = await handleRequest(
      new Request(`${workerOrigin}/api/settings`, {
        method: "PUT",
        body: JSON.stringify(FIRST),
        headers: {
          Authorization: authorization,
          Origin: appOrigin,
          "Content-Type": "application/json",
        },
      }),
      environment({ DB: broken }),
      dependencies,
    );
    const read = await handleRequest(
      new Request(`${workerOrigin}/api/settings`, {
        headers: { Authorization: authorization, Origin: appOrigin },
      }),
      environment({ DB: broken }),
      dependencies,
    );

    for (const response of [write, read]) {
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "SETTINGS_STORAGE_FAILED" },
      });
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(appOrigin);
    }
  });
});
