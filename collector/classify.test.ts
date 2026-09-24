// @vitest-environment node

import { classifyParsedPage } from "./parseSearchPage.ts";
import type { ParsedPage } from "./types.ts";

const page = (overrides: Partial<ParsedPage>): ParsedPage => ({
  listings: [],
  acceptedBlocks: 0,
  unparsedBlocks: 0,
  rejectedBlocks: 0,
  sourceOrdered: true,
  shellPresent: true,
  evidencePresent: true,
  ...overrides,
});

/**
 * C1 IS THE WHOLE POINT OF THE PARSER. Row 4 -- zero accepted, evidence present, shell present --
 * is the row that says "we went blind" rather than "the market is empty", and deleting branch 4
 * turns it into SOURCE_EMPTY. Every boundary row uses 1, never 2, so `> 0` -> `> 1` is red.
 */
describe("classifying a parsed page", () => {
  it.each([
    ["a healthy page", { acceptedBlocks: 6 }, "SUCCESS", "ok"],
    ["one unparseable block", { acceptedBlocks: 5, unparsedBlocks: 1 }, "PROVIDER_FAILURE", "block-unparseable"],
    ["one rejected block", { acceptedBlocks: 5, rejectedBlocks: 1 }, "PROVIDER_FAILURE", "listing-schema-changed"],
    ["evidence with nothing parsed", { evidencePresent: true }, "PROVIDER_FAILURE", "parser-blind"],
    ["a genuinely empty market", { evidencePresent: false }, "SOURCE_EMPTY", "no-results"],
    ["an unrecognised page", { evidencePresent: false, shellPresent: false }, "UNAVAILABLE", "unrecognized-page"],
    // Accepted outranks shell: a rename of the source's own module names must not black us out.
    ["listings without the shell", { acceptedBlocks: 6, shellPresent: false }, "SUCCESS", "ok"],
    // Unparsed outranks rejected, and both outrank accepted.
    [
      "one of each anomaly",
      { acceptedBlocks: 4, unparsedBlocks: 1, rejectedBlocks: 1 },
      "PROVIDER_FAILURE",
      "block-unparseable",
    ],
    [
      "a rejected block beside good ones",
      { acceptedBlocks: 5, rejectedBlocks: 1, shellPresent: false },
      "PROVIDER_FAILURE",
      "listing-schema-changed",
    ],
  ])("C1: %s is %s / %s", (_label, overrides, state, reason) => {
    expect(classifyParsedPage(page(overrides))).toEqual({ state, reason });
  });
});
