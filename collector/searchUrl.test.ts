// @vitest-environment node

import { buildListingUrl, buildSearchUrl, SEARCH_HEADERS } from "./searchUrl.ts";
import { MAX_RESULT_LIMIT, type ProviderSearchQuery } from "./types.ts";

const query = (overrides: Partial<ProviderSearchQuery> = {}): ProviderSearchQuery => ({
  location: "waterloo",
  query: "graphics card",
  limit: 4,
  radiusKm: 12,
  daysSinceListed: 3,
  ...overrides,
});

describe("the search URL and its headers", () => {
  it("U1: the exact URL, with %20 and no limit parameter", () => {
    expect(buildSearchUrl(query())).toBe(
      "https://www.facebook.com/marketplace/waterloo/search" +
        "?query=graphics%20card&sortBy=creation_time_descend&daysSinceListed=3&radius=12",
    );
  });

  /**
   * U2 pins the header MAP, not its size. MEASURED: dropping the Sec-Fetch-* set reproduces an
   * HTTP 400 from the source, so every entry here is load-bearing.
   */
  it("U2: all seven measured headers, exactly", () => {
    expect({ ...SEARCH_HEADERS }).toEqual({
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Upgrade-Insecure-Requests": "1",
    });
  });

  it.each([[".."], ["../login"], ["toronto/search"], ["Toronto"], [""], ["to ronto"]])(
    "U3: a location of %s never reaches the path",
    (location) => {
      expect(() => buildSearchUrl(query({ location }))).toThrow(TypeError);
    },
  );

  it("U4: the numeric bounds, on both sides", () => {
    expect(() => buildSearchUrl(query({ limit: 1 }))).not.toThrow();
    expect(() => buildSearchUrl(query({ limit: MAX_RESULT_LIMIT }))).not.toThrow();
    for (const limit of [0, MAX_RESULT_LIMIT + 1, 1.5, Number.NaN]) {
      expect(() => buildSearchUrl(query({ limit }))).toThrow(TypeError);
    }
    for (const radiusKm of [0, -1]) {
      expect(() => buildSearchUrl(query({ radiusKm }))).toThrow(TypeError);
    }
    for (const daysSinceListed of [0, -1]) {
      expect(() => buildSearchUrl(query({ daysSinceListed }))).toThrow(TypeError);
    }
    // An empty query is a configuration bug, not an empty market.
    expect(() => buildSearchUrl(query({ query: "  " }))).toThrow(TypeError);
  });

  it("U5: the listing URL shape that MEASURABLY resolves", () => {
    expect(buildListingUrl("915010494744438")).toBe(
      "https://www.facebook.com/marketplace/item/915010494744438",
    );
  });
});
