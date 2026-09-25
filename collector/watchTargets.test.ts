// @vitest-environment node

import { readFileSync } from "node:fs";
import { REQUEST_TIMEOUT_MS } from "./types.ts";
import {
  fetchWatchTargets,
  parseMarket,
  parseTarget,
  type FetchWatchTargetsResult,
} from "./watchTargets.ts";

const apiBase = "https://api.example.workers.dev";
const token = "watch-suite-collector-token-90f3ab21c7d4";

const body = {
  market: { location: "toronto", latitude: 43.6532, longitude: -79.3832, radiusKm: 25 },
  targets: [
    { targetId: "cpu-toronto", componentType: "cpu", query: "cpu" },
    { targetId: "gpu-toronto", componentType: "gpu", query: "graphics card" },
  ],
};

const market = (overrides: Record<string, unknown> = {}) => ({ ...body.market, ...overrides });

const jsonResponse = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  // NO TEST IN THIS FILE MAY DIAL OUT, and that is enforced rather than promised.
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("a test reached the network");
  });
});

describe("reading the watch list from the Worker", () => {
  it("C-1: the exact request -- custom header, NO Origin, the watch-targets path", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse(200, body);
    }) as unknown as typeof fetch;

    await expect(fetchWatchTargets({ apiBase, token }, fake)).resolves.toEqual({
      ok: true,
      market: body.market,
      targets: body.targets,
    });

    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe(`${apiBase}/api/watch-targets`);
    // `Authorization` is a 401 on this path -- the Worker's Firebase bearer path would read it --
    // and ANY `Origin` at all is a 403.
    expect(init.headers).toEqual({ "X-Collector-Token": token });
    expect(init.method ?? "GET").toBe("GET");
  });

  /**
   * C-2: THE RADIUS, and `Number.isInteger` is what every row here turns on. `r >= 1` alone
   * admits 26 and 25.5; `r > 0` alone admits everything but 0. The string "25" matters because
   * SQLite would coerce it -- migration 0005's `typeof(radius_km) = 'integer'` term is the
   * server-side half of the same refusal.
   */
  it.each<[string, unknown]>([
    ["0", 0],
    ["26", 26],
    ["25.5", 25.5],
    ['the string "25"', "25"],
    ["NaN", Number.NaN],
    ["missing", undefined],
    ["null", null],
  ])("C-2: parseMarket refuses radiusKm %s", (_label, radiusKm) => {
    expect(parseMarket(market({ radiusKm })).ok).toBe(false);
  });

  it.each<[string, number]>([
    ["1", 1],
    ["25", 25],
  ])("C-2: parseMarket accepts radiusKm %s", (_label, radiusKm) => {
    expect(parseMarket(market({ radiusKm }))).toEqual({
      ok: true,
      value: { ...body.market, radiusKm },
    });
  });

  /**
   * C-3: THE LOCATION SHAPE GUARD.
   *
   * THE THREE HYPHEN ROWS ARE THE ONLY INPUTS THAT CAN DISTINGUISH `parseMarket` FROM THE
   * SCHEMA'S OWN CHECK. Measured against SQLite: `NOT GLOB '*[^a-z0-9-]*'` ACCEPTS '-toronto',
   * 'toronto-' and 'a--b'; `LOCATION_PATTERN` refuses all three. Delete the pattern check here
   * and only those three rows can notice.
   *
   * AND THE ASSERTION THAT MATTERS IS ON THE OUTCOME, NEVER ON "IT THROWS". `run()` swallows
   * `buildSearchUrl`'s TypeError into exit 5 -- measured -- so a throw-assertion would be green
   * while a permanent config error was laundered into "the next run is the retry", forever.
   * These functions return a result and cannot throw; runTargets.test.ts L-6b pins the exit
   * code (2, not 5) that a bad location actually produces.
   */
  it.each<[string, unknown]>([
    ["a path separator", "toronto/search"],
    ["a parent segment", ".."],
    ["a traversal", "../../etc"],
    ["upper case", "TORONTO"],
    ["a space", "to ronto"],
    ["a leading hyphen", "-toronto"],
    ["a trailing hyphen", "toronto-"],
    ["a doubled hyphen", "a--b"],
    ["empty", ""],
    ["a number", 25],
  ])("C-3: parseMarket refuses the location %s", (_label, location) => {
    expect(parseMarket(market({ location })).ok).toBe(false);
  });

  it.each<[string, string]>([
    ["toronto", "toronto"],
    ["new-york", "new-york"],
    ["123", "123"],
  ])("C-3: parseMarket accepts the location %s", (_label, location) => {
    expect(parseMarket(market({ location })).ok).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a latitude past the pole", { latitude: 91 }],
    ["a non-finite latitude", { latitude: Number.POSITIVE_INFINITY }],
    ["a longitude past the meridian", { longitude: -181 }],
    ["a stringified latitude", { latitude: "43.6532" }],
  ])("C-2b: parseMarket refuses %s", (_label, overrides) => {
    expect(parseMarket(market(overrides)).ok).toBe(false);
  });

  it("C-2b: an absent market is refused rather than defaulted", () => {
    expect(parseMarket(null).ok).toBe(false);
    expect(parseMarket(undefined).ok).toBe(false);
    expect(parseMarket([]).ok).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ["an empty targetId", { targetId: "" }],
    ["a whitespace targetId", { targetId: "   " }],
    ["a numeric targetId", { targetId: 3 }],
    ["an empty componentType", { componentType: "" }],
    ["a missing componentType", { componentType: undefined }],
    ["an empty query", { query: "" }],
    ["a missing query", { query: undefined }],
  ])("C-2c: parseTarget refuses %s", (_label, overrides) => {
    expect(parseTarget({ ...body.targets[0], ...overrides }).ok).toBe(false);
  });

  it("C-2c: parseTarget accepts a whole row and keeps every field", () => {
    expect(parseTarget(body.targets[1])).toEqual({ ok: true, value: body.targets[1] });
  });

  /**
   * C-4: RETRYABILITY IS ABOUT WHO MUST ACT. The 4xx/5xx split is the one `postListings` already
   * draws; the bad-shape row is the addition, and it is a CONTRACT error because retrying a
   * route that changed underneath the collector forever is the failure it exists to avoid.
   */
  it.each<[number, boolean, string]>([
    [400, false, "http-client-error"],
    [401, false, "http-client-error"],
    [403, false, "http-client-error"],
    [404, false, "http-client-error"],
    [500, true, "http-server-error"],
    [503, true, "http-server-error"],
  ])("C-4: a %i is retryable=%s", async (status, retryable, reason) => {
    const fake = (async () =>
      jsonResponse(status, { error: { code: "SOME_CODE" } })) as unknown as typeof fetch;

    await expect(fetchWatchTargets({ apiBase, token }, fake)).resolves.toEqual({
      ok: false,
      status,
      code: "SOME_CODE",
      reason,
      retryable,
    });
  });

  it("C-4: a transport failure is retryable and carries no status", async () => {
    const fake = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(fetchWatchTargets({ apiBase, token }, fake)).resolves.toEqual({
      ok: false,
      status: null,
      code: null,
      reason: "transport",
      retryable: true,
    });
  });

  it.each<[string, unknown]>([
    ["no market key at all", { targets: [] }],
    ["no targets key at all", { market: body.market }],
    ["targets that are not an array", { market: body.market, targets: {} }],
    ["an array at the top level", [body.market]],
    ["a bare string", "ok"],
  ])("C-4: a 200 whose body has %s is a contract error", async (_label, payload) => {
    const fake = (async () => jsonResponse(200, payload)) as unknown as typeof fetch;

    await expect(fetchWatchTargets({ apiBase, token }, fake)).resolves.toEqual({
      ok: false,
      status: 200,
      code: null,
      reason: "bad-shape",
      retryable: false,
    });
  });

  it("C-4: a 200 whose body is not JSON at all is a contract error", async () => {
    const fake = (async () =>
      new Response("<html>a login wall</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })) as unknown as typeof fetch;

    await expect(fetchWatchTargets({ apiBase, token }, fake)).resolves.toEqual({
      ok: false,
      status: 200,
      code: null,
      reason: "bad-shape",
      retryable: false,
    });
  });

  it("C-4: a non-200 whose body is not JSON still carries the status, with a null code", async () => {
    const fake = (async () =>
      new Response("gateway timeout", { status: 502 })) as unknown as typeof fetch;

    await expect(fetchWatchTargets({ apiBase, token }, fake)).resolves.toEqual({
      ok: false,
      status: 502,
      code: null,
      reason: "http-server-error",
      retryable: true,
    });
  });

  it("C-4: a 200 carrying market:null and an empty list is NOT a shape error", async () => {
    const fake = (async () =>
      jsonResponse(200, { market: null, targets: [] })) as unknown as typeof fetch;

    await expect(fetchWatchTargets({ apiBase, token }, fake)).resolves.toEqual({
      ok: true,
      market: null,
      targets: [],
    });
  });

  /**
   * C-5: THE TIMEOUT, MEASURED MISSING BEFORE IT EXISTED. A GET to a TCP server that accepts the
   * connection and never responds did not settle for 12,005 ms; only the harness's cap ended it.
   * With N targets in one process a hung GET strands ALL N before one starts.
   *
   * TWO ASSERTIONS AND BOTH ARE NEEDED: the `signal` is what would actually be dropped, and the
   * abort mapping is what makes the drop matter. `retryable: true` -> exit 5 is "the next run is
   * the retry", which is what the docs already promise.
   */
  it("C-5: the request carries an abort signal", async () => {
    const calls: RequestInit[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return jsonResponse(200, body);
    }) as unknown as typeof fetch;

    await fetchWatchTargets({ apiBase, token }, fake);

    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("C-5: the default bound is the shipped 10 s, not merely 'some' timeout", async () => {
    // WITHOUT THIS THE DEFAULT IS NEVER EXERCISED: the rows around it inject `timeoutMs: 5`, so
    // raising REQUEST_TIMEOUT_MS to 10_000_000 would leave them all green while the guard that
    // stops a hung GET stranding all N targets was gone.
    expect(REQUEST_TIMEOUT_MS).toBe(10_000);

    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fake = (async () => jsonResponse(200, body)) as unknown as typeof fetch;

    await fetchWatchTargets({ apiBase, token }, fake);

    expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
  });

  it("C-5: an abort is retryable", async () => {
    const fake = (async () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;

    const result: FetchWatchTargetsResult = await fetchWatchTargets({ apiBase, token }, fake);
    expect(result).toEqual({
      ok: false,
      status: null,
      code: null,
      reason: "timeout",
      retryable: true,
    });
  });

  it("C-5: a real timeout aborts rather than hanging", async () => {
    const fake = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("timed out");
          error.name = "TimeoutError";
          reject(error);
        });
      })) as unknown as typeof fetch;

    await expect(
      fetchWatchTargets({ apiBase, token, timeoutMs: 5 }, fake),
    ).resolves.toMatchObject({ ok: false, reason: "timeout", retryable: true });
  });
});

/**
 * C-6: THE SHIPPED SEED, RUN THROUGH THE REAL PARSERS.
 *
 * THE COLLECTOR-SIDE HALF OF schema.test.ts S7c, and it is a separate file because it must be:
 * `tsconfig.worker.json` cannot compile this module's `.ts`-extension imports, so `parseMarket`
 * and `parseTarget` are not reachable from the worker suite; and this project cannot import a
 * `.sql?raw` module, so the file is read from disk instead.
 *
 * VALIDATED, NEVER PINNED. `scripts/e2e-local.sh` overwrites the market row and deletes both
 * targets before it collects, so THE GATE NEVER EXECUTES AGAINST THE SHIPPED SEED AT ALL --
 * literal pins would stay green while the shipped rows were unusable by the very functions that
 * have to consume them. Seed `location: 'Toronto'`, `'toronto/search'` or radius 30 and this
 * goes red; nothing else in the suite would notice.
 */
describe("the seed migration 0005 ships", () => {
  const sql = readFileSync(
    new URL("../migrations/0005_watch_targets.sql", import.meta.url),
    "utf8",
  )
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

  /** `'a', 1, -2` -> `["a", "1", "-2"]`, quotes stripped. The file's own format, pinned by S7d. */
  const values = (statement: string): string[] =>
    statement
      .split(",")
      .map((value) => value.trim().replace(/^'(.*)'$/, "$1"));

  it("C-6: the seeded market survives parseMarket", () => {
    const match = /INSERT INTO watch_market[^;]*VALUES\s*\(([^)]*)\)/.exec(sql);
    expect(match).not.toBeNull();

    const [id, location, latitude, longitude, radiusKm] = values(match![1]);
    expect(id).toBe("1");

    expect(
      parseMarket({
        location,
        latitude: Number(latitude),
        longitude: Number(longitude),
        radiusKm: Number(radiusKm),
      }),
    ).toEqual({
      ok: true,
      value: {
        location,
        latitude: Number(latitude),
        longitude: Number(longitude),
        radiusKm: Number(radiusKm),
      },
    });
  });

  it("C-6: every seeded target survives parseTarget", () => {
    const matches = [...sql.matchAll(/INSERT INTO watch_targets[^;]*VALUES\s*\(([^)]*)\)/g)];
    expect(matches).toHaveLength(2);

    const seen = new Set<string>();
    for (const match of matches) {
      const [targetId, componentType, query] = values(match[1]);
      expect(parseTarget({ targetId, componentType, query })).toEqual({
        ok: true,
        value: { targetId, componentType, query },
      });
      // A duplicated target_id is a migration that cannot apply at all.
      expect(seen.has(targetId)).toBe(false);
      seen.add(targetId);
    }
  });
});
