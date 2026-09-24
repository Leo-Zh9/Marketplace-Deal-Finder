// @vitest-environment node

import { MAX_PRICE_CENTS, parsePriceText } from "./priceText";

describe("turning a source's price text into cents", () => {
  it.each([
    ["CA$0", 0],
    ["CA$1", 100],
    ["CA$20", 2000],
    ["CA$25", 2500],
    ["CA$40", 4000],
    ["CA$80", 8000],
    ["CA$85", 8500],
    ["CA$160", 16000],
    ["CA$250", 25000],
    ["CA$330", 33000],
    ["CA$400", 40000],
    ["CA$950", 95000],
    ["CA$1,000", 100000],
    ["CA$1,450", 145000],
    ["CA$1,500", 150000],
    ["CA$1,650", 165000],
    ["CA$1,800", 180000],
    ["CA$2,000", 200000],
    ["CA$2,100", 210000],
    ["CA$2,200", 220000],
    ["CA$3,000", 300000],
    ["CA$3,500", 350000],
    // Not from this capture, but the forms a second currency prefix and a fraction produce.
    ["$1,234.56", 123456],
    ["£7.50", 750],
    // THESE TWO ROWS ARE WHAT KILLS `parseFloat(x) * 100`. MEASURED: the textbook example
    // ("1234.56") is exactly 123456 in V8 and survives, while 1.09 -> 109.00000000000001 and
    // 0.07 -> 7.000000000000001 are not safe integers and become null.
    ["$1.09", 109],
    ["CA$0.07", 7],
    ["  CA$3,000  ", 300000],
  ])("M1: %s is %d cents", (raw, cents) => {
    expect(parsePriceText(raw)).toBe(cents);
  });

  /**
   * M2 IS PR #6's LIVE CASE. A real free listing appeared in the captured data as "CA$0", and
   * `cents || null` or `if (!cents) return null` turns it into "no price", which is a different
   * listing. `toBe(0)` alone would pass for `null` under a loose matcher, so both are asserted.
   */
  it("M2: CA$0 is zero cents, not null", () => {
    expect(parsePriceText("CA$0")).toBe(0);
    expect(parsePriceText("CA$0")).not.toBeNull();
    expect(parsePriceText("CA$0.00")).toBe(0);
    expect(parsePriceText("CA$0.00")).not.toBeNull();
  });

  it.each([
    ["Free"],
    [""],
    ["   "],
    ["Swap"],
    ["CA$"],
    ["CA$1.5"],
    ["CA$1.234"],
    ["1,23,456"],
    ["CA$1,2345"],
    ["CA$1e3"],
    ["CA$ 1 000"],
    ["CA$3,000 or best offer"],
    ["3000CAD"],
    ["CA$<script>"],
  ])("M3: %s is not a price", (raw) => {
    expect(parsePriceText(raw)).toBeNull();
  });

  /**
   * M4 IS A DEFECT THAT EXISTED IN A DRAFT OF THIS MODULE. With a `[^0-9]*` currency prefix all
   * three of these parse as 500 -- the minus sign is simply eaten as "currency". Measured on all
   * three forms, including the Unicode minus, which is not the ASCII one.
   */
  it.each([["CA$-5"], ["-CA$5"], ["CA$−5"]])("M4: %s is refused, not read as 500", (raw) => {
    expect(parsePriceText(raw)).toBeNull();
  });

  it("M5: the cap is exact", () => {
    expect(parsePriceText("CA$1,000,000")).toBe(100000000);
    expect(parsePriceText("CA$1,000,000.00")).toBe(100000000);
    expect(parsePriceText("CA$1,000,000.01")).toBeNull();
    expect(parsePriceText("CA$1,000,001")).toBeNull();
    expect(parsePriceText("CA$999999999999999999")).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 3000],
    ["an object", {}],
    ["an array", []],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("M6: %s is null and does not throw", (_label, raw) => {
    expect(() => parsePriceText(raw)).not.toThrow();
    expect(parsePriceText(raw)).toBeNull();
  });

  it("M7: the shipped cap", () => {
    expect(MAX_PRICE_CENTS).toBe(100_000_000);
  });

  /**
   * M8 PINS THE ABSENCE OF THE `m` FLAG. With it, `^`...`$` anchor to a LINE rather than to the
   * string, so a multi-line value has its first line read as the price and the rest discarded.
   *
   * MEASURED CORRECTION TO THE PLAN, recorded rather than quietly fixed: the plan's row was
   * `"CA$5\n" -> null`, and the measured answer is 500, because `parsePriceText` trims before
   * matching and `trim` removes the trailing newline. The fact the plan wanted pinned -- that
   * JavaScript's `$` does not match before a trailing line terminator while Python's does -- is
   * real, but it is load-bearing on the SOURCE regex, which is NOT trimmed; `listings.test.ts`
   * L6's "facebook\n" row is where it bites. Here the newline that survives trimming is an
   * INTERIOR one, and that is what this test uses.
   */
  it("M8: an interior newline is refused -- the pattern anchors to the string, not a line", () => {
    expect(parsePriceText("CA$5\nCA$9")).toBeNull();
    expect(parsePriceText("CA$5")).toBe(500);
    // Measured, and the reason the row above is not the plan's: trim eats a TRAILING newline.
    expect(parsePriceText("CA$5\n")).toBe(500);
  });
});
