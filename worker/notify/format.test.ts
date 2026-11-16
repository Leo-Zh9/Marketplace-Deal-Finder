// @vitest-environment node

import { formatMessage, listingUrl, MAX_CONTENT_CHARS, sanitizeText } from "./format";
import type { RecheckedListing } from "./recheck";

const T = 1_700_000_000;

const listing = (overrides: Partial<RecheckedListing> = {}): RecheckedListing => ({
  modelKey: "GeForce RTX 4070 Super",
  title: "MSI RTX 4070 Super Ventus",
  priceCents: 45_000,
  locationText: "Toronto, ON",
  lastSeenAt: T - 2 * 3600 - 59,
  mode: "DISCOUNT",
  minimumDiscountPercent: 20,
  maximumPriceCents: null,
  radiusKm: 25,
  referenceCount: 7,
  referenceTotalCents: 7 * 60_000,
  ...overrides,
});

describe("formatMessage", () => {
  /**
   * F1. THE WHOLE MESSAGE, PINNED. Every element the brief lists: model, price, rule, average and
   * discount recomputed from the aggregate, reference count, radius, location, last seen, title,
   * link. Kills: any element dropped or computed from the wrong field.
   */
  it("F1: carries every element, one per line", () => {
    expect(formatMessage({ listingId: "915010494744438", listing: listing(), now: T })).toBe(
      [
        "Deal: GeForce RTX 4070 Super for CA$450.00",
        "Rule: at least 20% below average",
        "Market: average CA$600.00, 25.0% below, 7 references",
        "Area: 25 km radius, listed in Toronto, ON, last seen 2h ago",
        "Title: MSI RTX 4070 Super Ventus",
        "https://www.facebook.com/marketplace/item/915010494744438",
      ].join("\n"),
    );
  });

  /**
   * F2. BELOW MINIMUM_REFERENCE_COUNT THERE IS NO AVERAGE, as on the dashboard. Kills: averaging
   * over four references (the `>= MINIMUM_REFERENCE_COUNT` guard dropped).
   */
  it("F2: a MAXIMUM_PRICE deal with four references shows no average", () => {
    const text = formatMessage({
      listingId: "1",
      listing: listing({
        mode: "MAXIMUM_PRICE",
        minimumDiscountPercent: null,
        maximumPriceCents: 74_900,
        referenceCount: 4,
        referenceTotalCents: 4 * 60_000,
      }),
      now: T,
    });
    expect(text.split("\n").slice(1, 3)).toEqual([
      "Rule: at most CA$749.00",
      "Market: no average yet (4 references)",
    ]);
  });

  it("F2b: BOTH names both halves of the rule", () => {
    const text = formatMessage({
      listingId: "1",
      listing: listing({ mode: "BOTH", minimumDiscountPercent: 17.5, maximumPriceCents: 123_456 }),
      now: T,
    });
    expect(text.split("\n")[1]).toBe("Rule: at least 17.5% below average and at most CA$1,234.56");
  });

  /**
   * F3. THE BOUND. A 5,000-character title and location still produce <= 2,000 characters, with
   * the title cut to 200 code points. Kills: dropping the title cut.
   */
  it("F3: oversized fields are cut and the message stays under 2000 characters", () => {
    const text = formatMessage({
      listingId: "1",
      listing: listing({ title: "a".repeat(5_000), locationText: "b".repeat(5_000) }),
      now: T,
    });
    expect(text.length).toBeLessThanOrEqual(MAX_CONTENT_CHARS);
    expect(text.split("\n")[4]).toBe(`Title: ${"a".repeat(199)}…`);
  });
});

describe("sanitizeText", () => {
  /**
   * F4. EVERY MARKDOWN CHARACTER IN THE BRIEF'S LIST IS ESCAPED, AND WHITESPACE COLLAPSES.
   * Kills: dropping any one character from the escape class, or the collapse.
   */
  it("F4: escapes \\ * _ ~ | > [ ] ( ) ` # and collapses whitespace", () => {
    expect(sanitizeText("\\ * _ ~ | > [ ] ( ) ` #", 200)).toBe(
      "\\\\ \\* \\_ \\~ \\| \\> \\[ \\] \\( \\) \\` \\#",
    );
    expect(sanitizeText("  a\n\n# b\r\n\t> c  ", 200)).toBe("a \\# b \\> c");
    expect(sanitizeText("[click](https://evil.example)", 200)).toBe(
      "\\[click\\]\\(https://evil.example\\)",
    );
  });

  /** F5. The cut happens before escaping, so an escape is never split. */
  it("F5: cuts before escaping", () => {
    expect(sanitizeText("abc*", 4)).toBe("abc\\*");
    expect(sanitizeText("abcd*", 4)).toBe("abc…");
  });
});

describe("listingUrl", () => {
  /**
   * F6. THE LINK IS THE COLLECTOR'S OWN SHAPE. Imported dynamically so the worker's tsc program
   * does not have to compile the collector's `.ts`-extension imports. Kills: drift between the
   * two (a changed origin or path on either side).
   */
  it("F6: agrees with the collector's buildListingUrl", async () => {
    const collector = "../../collector/searchUrl.ts";
    const { buildListingUrl } = (await import(/* @vite-ignore */ collector)) as {
      buildListingUrl: (id: string) => string;
    };
    for (const id of ["915010494744438", "e2e-two-type-3080"]) {
      expect(listingUrl(id)).toBe(buildListingUrl(id));
    }
  });

  it("F6b: encodes what the ingest pattern would never let through", () => {
    expect(listingUrl("a/../b?c#d")).toBe(
      "https://www.facebook.com/marketplace/item/a%2F..%2Fb%3Fc%23d",
    );
  });
});
