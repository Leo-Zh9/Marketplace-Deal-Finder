// @vitest-environment node

import {
  parseSearchPage,
  RESULT_EVIDENCE_MARKERS,
  SHELL_MARKERS,
} from "./parseSearchPage.ts";
import {
  facebookSearchEmpty,
  facebookSearchPage,
  FIXTURE_IDS,
  paddedToRealisticSize,
  reordered,
  withoutCityPage,
  withoutLocation,
} from "./testing/fixtures.ts";

describe("parsing a real Marketplace search page", () => {
  /**
   * THE LENGTH IS ASSERTED FIRST, AND THEN THE EXACT ID SEQUENCE, because `[].every(...)` is
   * `true`: an ordering check over zero listings prints "newest-first: true" and proves nothing.
   * That exact mistake was made on this work. A parser that returns [] dies on the first
   * assertion here, and one that returns source order dies in P4.
   */
  it("P1: six listings, the exact ids in order, and strictly descending", () => {
    const page = parseSearchPage(facebookSearchPage);

    expect(page.listings).toHaveLength(6);
    expect(page.listings.map((listing) => listing.id)).toEqual([...FIXTURE_IDS]);
    expect(page.acceptedBlocks).toBe(6);
    expect(page.unparsedBlocks).toBe(0);
    expect(page.rejectedBlocks).toBe(0);
    for (let index = 1; index < page.listings.length; index += 1) {
      expect(page.listings[index - 1].creationTime).toBeGreaterThan(
        page.listings[index].creationTime,
      );
    }
  });

  /**
   * P2 IS THE NESTED-ID TEST. Every listing block contains a SECOND `"id"` -- the photo's -- and
   * a parser that takes "the first id after the typename" reads 1105823888449116 instead of
   * 1807946430653887. MEASURED on the untouched capture that no photo id equals any listing id,
   * which is what makes that mutation lethal rather than merely wrong.
   *
   * It is also PR #6's price case: `listing_price.amount` is "0.00" and `formatted_amount` is
   * "CA$0", and `price || null` drops the latter.
   */
  it("P2: the CA$0 listing, field by field, and never the photo's id", () => {
    const [first] = parseSearchPage(facebookSearchPage).listings;

    expect(first).toEqual({
      id: "1807946430653887",
      title: "For trade: MSI RTX 3060 Ventus 2X 12GB for an Intel Arc B580 12gb",
      priceText: "CA$0",
      creationTime: 1790261503,
      locationText: "Markdale, Ontario",
      url: "https://www.facebook.com/marketplace/item/1807946430653887",
    });
    // The hazard is really in the fixture: it was preserved through the redaction on purpose.
    expect(facebookSearchPage).toContain('"id":"1105823888449116"');
    expect(first.id).not.toBe("1105823888449116");
  });

  /**
   * P3: `display_name` BEFORE `city`. MEASURED that the two differ on all 24 captured rows
   * ("Grey Highlands" vs "Markdale, Ontario"), so swapping the `??` order makes the first row
   * red rather than passing by coincidence.
   */
  it.each([
    ["display_name present", facebookSearchPage, "Markdale, Ontario"],
    ["city_page null", withoutCityPage(), "Grey Highlands"],
    ["location null", withoutLocation(), null],
  ])("P3: with %s the location text is %s", (_label, html, expected) => {
    const page = parseSearchPage(html);
    expect(page.listings).toHaveLength(6);
    expect(page.listings[0].locationText).toBe(expected);
  });

  it("P4: a page in the wrong source order is flagged AND corrected", () => {
    const page = parseSearchPage(reordered());

    expect(page.sourceOrdered).toBe(false);
    expect(page.listings).toHaveLength(6);
    expect(page.listings.map((listing) => listing.id)).toEqual([...FIXTURE_IDS]);
    // ...and the page that is already in order is not flagged, so the flag is not a constant.
    expect(parseSearchPage(facebookSearchPage).sourceOrdered).toBe(true);
  });

  it("P5: the real empty capture has the shell and no evidence", () => {
    const page = parseSearchPage(facebookSearchEmpty);

    expect(page.listings).toHaveLength(0);
    expect(page.acceptedBlocks).toBe(0);
    expect(page.unparsedBlocks).toBe(0);
    expect(page.rejectedBlocks).toBe(0);
    expect(page.shellPresent).toBe(true);
    expect(page.evidencePresent).toBe(false);
  });

  /**
   * THE MARKER STRINGS ARE SPELLED OUT HERE, NOT MAPPED FROM THE MODULE'S OWN LISTS. Iterating
   * over `RESULT_EVIDENCE_MARKERS` would make this test agree with itself: shortening the list
   * would simply drop a row and the suite would stay green. MEASURED -- that is exactly what
   * happened to the first version of this test.
   */
  it("P6: the two marker lists are exactly these, and nothing else", () => {
    expect([...RESULT_EVIDENCE_MARKERS]).toEqual([
      "GroupCommerceProductItem",
      "marketplace_listing_title",
      "listing_price",
      "__isMarketplaceListingRenderable",
    ]);
    expect([...SHELL_MARKERS]).toEqual([
      "CometMarketplaceSearchContentContainer",
      "MarketplaceFilterField",
      "marketplace_seo_page",
    ]);
  });

  it.each([
    ["GroupCommerceProductItem"],
    ["marketplace_listing_title"],
    ["listing_price"],
    ["__isMarketplaceListingRenderable"],
  ])("P6: %s alone is evidence of results", (marker) => {
    expect(parseSearchPage(marker).evidencePresent).toBe(true);
    expect(parseSearchPage(marker).shellPresent).toBe(false);
  });

  it.each([
    ["CometMarketplaceSearchContentContainer"],
    ["MarketplaceFilterField"],
    ["marketplace_seo_page"],
  ])("P6: %s alone identifies a Marketplace page", (marker) => {
    expect(parseSearchPage(marker).shellPresent).toBe(true);
    expect(parseSearchPage(marker).evidencePresent).toBe(false);
  });

  it("P6: a page with neither marker set flags neither", () => {
    const page = parseSearchPage("<html><body>nothing to see</body></html>");
    expect(page.shellPresent).toBe(false);
    expect(page.evidencePresent).toBe(false);
  });

  /**
   * P7 HAS NO KILLING MUTATION AND IS NOT CLAIMED AS A GUARD -- it is a smoke test against a
   * catastrophic parse-cost regression on a realistic page.
   *
   * The plan predicted that replacing `indexOf(ANCHOR, from)` with a fresh `slice(from)` per
   * block would be measurably quadratic here. MEASURED, and it is not: on this 650 KB page the
   * two forms are indistinguishable (p95 0.075 ms vs 0.070 ms), because V8's sliced strings make
   * `slice` O(1) and the padding sits after the last anchor. The bound below is therefore set
   * ~600x above the measured cost: it cannot go red from load, and it still catches a parser
   * that became accidentally exponential.
   */
  it("P7: a 650 KB page parses in well under a frame", () => {
    const padded = paddedToRealisticSize();
    expect(padded.length).toBeGreaterThan(640_000);

    for (let index = 0; index < 10; index += 1) parseSearchPage(padded);
    const timings: number[] = [];
    for (let index = 0; index < 200; index += 1) {
      const started = performance.now();
      parseSearchPage(padded);
      timings.push(performance.now() - started);
    }
    timings.sort((a, b) => a - b);

    expect(parseSearchPage(padded).listings).toHaveLength(6);
    expect(timings[Math.floor(timings.length * 0.95)]).toBeLessThan(50);
  });
});
