// @vitest-environment node

import { postListings, type IngestSummary } from "./postListings.ts";
import { REQUEST_TIMEOUT_MS, type RawListing } from "./types.ts";

const apiBase = "https://api.example.workers.dev";
const token = "post-suite-collector-token-b71e40d9c5a2";

const listings: RawListing[] = [
  {
    id: "2253354775457674",
    title: "a gaming pc",
    priceText: "CA$1,450",
    creationTime: 1790125632,
    locationText: "Mississauga, Ontario",
    url: "https://www.facebook.com/marketplace/item/2253354775457674",
  },
];

const input = {
  apiBase,
  token,
  source: "post-suite-market",
  componentType: "gpu",
  market: { latitude: 43.5891, longitude: -79.6441, radiusKm: 22 },
  listings,
};

const summary: IngestSummary = {
  received: 1,
  stored: 1,
  outcomes: { NEW: 1, CHANGED: 0, UNCHANGED: 0, FAILED: 0 },
  contributions: {
    recorded: 0,
    restored: 0,
    removed: 0,
    none: 0,
    "skipped-no-price": 0,
    "skipped-no-model": 1,
    "skipped-invalid": 0,
  },
  pricesUnparsed: 0,
  usage: { rowsRead: 1, rowsWritten: 3 },
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  // NO TEST IN THIS FILE MAY DIAL OUT, and that is enforced rather than promised.
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("a test reached the network");
  });
});

describe("posting a batch to the Worker", () => {
  it("Q1: the exact request -- custom header, no Origin, exactly five wire fields", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse(200, summary);
    }) as unknown as typeof fetch;

    await postListings(input, fake);

    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe(`${apiBase}/api/listings`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "X-Collector-Token": token,
    });
    // An Origin header is refused by the route outright, and the token in `Authorization` would
    // be read by the Worker's Firebase bearer path on every other route.
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain("Origin");
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain("Authorization");

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["componentType", "listings", "market", "source"]);
    const wire = (body.listings as Array<Record<string, unknown>>)[0];
    // EXACTLY these five. `creationTime` sorted the page and is deliberately dropped; there is
    // no priceCents, modelKey, variantKey, validity or observedAt field to set.
    expect(Object.keys(wire).sort()).toEqual([
      "listingId",
      "locationText",
      "priceText",
      "title",
      "url",
    ]);
    expect(wire.listingId).toBe("2253354775457674");
  });

  /**
   * Q5: THE NULLS SURVIVE THE WIRE. The parser produces `null` for a price-less or location-less
   * listing and the route accepts it; coercing either to "" here (or dropping the key) turns a
   * real listing into a 400 that stores NOTHING for the whole batch.
   */
  it("Q5: a listing with no price and no location keeps both as null, not empty strings", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse(200, summary);
    }) as unknown as typeof fetch;

    await postListings(
      { ...input, listings: [{ ...listings[0], priceText: null, locationText: null }] },
      fake,
    );

    const wire = (JSON.parse(calls[0][1].body as string) as { listings: Array<Record<string, unknown>> })
      .listings[0];
    expect(Object.keys(wire).sort()).toEqual([
      "listingId",
      "locationText",
      "priceText",
      "title",
      "url",
    ]);
    expect(wire.priceText).toBeNull();
    expect(wire.locationText).toBeNull();
  });

  it("Q2: a 200 carries the Worker's summary back", async () => {
    const fake = (async () => jsonResponse(200, summary)) as unknown as typeof fetch;

    await expect(postListings(input, fake)).resolves.toEqual({
      ok: true,
      status: 200,
      summary,
    });
  });

  it.each([
    [400, false],
    [401, false],
    [403, false],
    [413, false],
    [415, false],
    [500, true],
    [503, true],
  ])("Q3: a %i is retryable=%s", async (status, retryable) => {
    const fake = (async () =>
      jsonResponse(status, { error: { code: "SOME_CODE" } })) as unknown as typeof fetch;

    await expect(postListings(input, fake)).resolves.toEqual({
      ok: false,
      status,
      code: "SOME_CODE",
      retryable,
    });
  });

  it("Q3: a transport failure is retryable and carries no status", async () => {
    const fake = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(postListings(input, fake)).resolves.toEqual({
      ok: false,
      status: null,
      code: null,
      retryable: true,
    });
  });

  /**
   * P-1: THE TIMEOUT, AND IT WAS MEASURED MISSING. A fetch POST to a TCP server that accepts the
   * connection and never responds HAD NOT SETTLED AFTER 20 s on Node 24 -- only the harness's own
   * AbortController ended it. With one search per process a hung POST hung one process; with N
   * targets in ONE process it STRANDS THE REMAINING N-1 and pushes the process past its window.
   *
   * TWO ASSERTIONS AND BOTH ARE NEEDED: the `signal` is what would actually be dropped, and the
   * abort mapping is what makes the drop matter.
   */
  it("P-1: the request carries an abort signal", async () => {
    const calls: RequestInit[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return jsonResponse(200, summary);
    }) as unknown as typeof fetch;

    await postListings(input, fake);

    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("P-1: the default bound is the shipped 10 s, not merely 'some' timeout", async () => {
    expect(REQUEST_TIMEOUT_MS).toBe(10_000);

    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fake = (async () => jsonResponse(200, summary)) as unknown as typeof fetch;

    await postListings(input, fake);

    // `run.ts` calls `post(input, fetchImplementation)` with no third argument, so THE DEFAULT IS
    // WHAT PRODUCTION USES and the injected `timeoutMs: 5` below never reaches it.
    expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
  });

  it("P-1: an injected AbortError is retryable -- the next run is the retry", async () => {
    const fake = (async () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;

    await expect(postListings(input, fake)).resolves.toEqual({
      ok: false,
      status: null,
      code: null,
      retryable: true,
    });
  });

  it("P-1: a real timeout aborts rather than hanging", async () => {
    const fake = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("timed out");
          error.name = "TimeoutError";
          reject(error);
        });
      })) as unknown as typeof fetch;

    await expect(postListings(input, fake, 5)).resolves.toEqual({
      ok: false,
      status: null,
      code: null,
      retryable: true,
    });
  });

  /**
   * Q4: ONE request, no retry, ever. The next scheduled run is the retry, `recordSightings` is
   * idempotent so nothing is lost, and a retry loop is what turns one bad run on a laptop into
   * a hot loop.
   */
  it("Q4: a 503 is not retried", async () => {
    let calls = 0;
    const fake = (async () => {
      calls += 1;
      return jsonResponse(503, { error: { code: "INGEST_STORAGE_FAILED" } });
    }) as unknown as typeof fetch;

    await postListings(input, fake);

    expect(calls).toBe(1);
  });
});
