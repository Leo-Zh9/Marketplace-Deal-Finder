/**
 * Where a source's money TEXT becomes cents -- on the server, once, and nowhere else.
 *
 * The collector sends `priceText` verbatim ("CA$0", "CA$3,000") and never a number: a client
 * that could send `priceCents` could set the amount every downstream aggregate is computed
 * from. This module is the only converter, and `worker/api/listings.ts` is its only caller.
 */

/** CA$1,000,000.00. Pinned directly by M7 -- every behavioural test passes with other values. */
export const MAX_PRICE_CENTS = 100_000_000;

/**
 * THE CURRENCY PREFIX IS AN EXPLICIT ALLOWLIST, NOT `[^0-9]*`, AND THAT IS A MEASURED FIX.
 * With `[^0-9]*` the strings "CA$-5", "-CA$5" and "CA$<U+2212>5" all parse as 500 -- the minus
 * sign is simply consumed as part of the "currency prefix". Measured on all three forms; M4 is
 * the test. The allowlist admits the prefixes a real source emits (CA$, US$, $, EUR, £, ¥, ₹)
 * and no sign character of any kind.
 *
 * Two known loosenesses, named rather than fixed because neither can produce a wrong non-zero
 * amount and neither is reachable from a `formatted_amount`: the letter class means "USD5" and
 * "e5" parse as five dollars, and "CA$0,000" parses as 0. A free-text price field on a future
 * provider WOULD mis-parse ("Best offer 500" -> 50000); that is a reason to validate at that
 * provider, and it is written down here so it is not rediscovered.
 *
 * NO `m` FLAG. With it, `^`...`$` anchor to a LINE rather than to the string, so a multi-line
 * value would have its first line read as the price and the rest discarded. M8 pins that with an
 * INTERIOR newline (`"CA$5\nCA$9"`).
 *
 * MEASURED CORRECTION, because the obvious version of this comment is wrong: a TRAILING newline
 * never reaches the anchor here, since `parsePriceText` trims first -- `parsePriceText("CA$5\n")`
 * is 500, not null, and M8 records that too. The fact that JavaScript's `$` does not match before
 * a trailing line terminator while Python's does IS real and IS load-bearing, but on
 * `SOURCE_PATTERN` in worker/api/listings.ts, which is NOT trimmed: `"facebook\n"` is refused
 * there, pinned by listings.test.ts L6.
 */
const PRICE_PATTERN = /^[A-Za-z$€£¥₹\s]*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?$/;

/**
 * Cents, or null when the text is not a price this parser will stand behind.
 *
 * INTEGER ARITHMETIC ONLY: the whole and the fraction are read as separate integers and
 * combined, so no float ever touches the amount. MEASURED, because the usual example is wrong --
 * `parseFloat("1234.56") * 100` is EXACTLY 123456 in V8. The float form breaks on smaller
 * fractions: `parseFloat("1.09") * 100` is 109.00000000000001 and `parseFloat("0.07") * 100` is
 * 7.000000000000001, neither a safe integer, so both would be refused as unparseable. Those two
 * rows are in M1 precisely so the float form cannot survive.
 *
 * "CA$0" IS 0, NEVER NULL. Facebook renders a genuinely free item as "CA$0" and one appeared in
 * live data; PR #6 exists because a $0 listing reached the benchmark. The rule that keeps zero
 * out of the benchmark is `recordSightings`' `priceCents > 0`, one layer down -- not a null here.
 * "Free" IS null, not 0: inventing an amount from a word is the same class of guess.
 */
export const parsePriceText = (raw: unknown): number | null => {
  if (typeof raw !== "string") return null;

  const match = PRICE_PATTERN.exec(raw.trim());
  if (match === null) return null;

  const whole = Number(match[1].replace(/,/g, ""));
  const fraction = Number(match[2] ?? "00");
  const cents = whole * 100 + fraction;

  // UNREACHABLE and kept as defence in depth: the arithmetic is integer-only and the cap check
  // on the next line already refuses everything that could reach 2^53. No mutation can kill it.
  if (!Number.isSafeInteger(cents)) return null;
  if (cents < 0 || cents > MAX_PRICE_CENTS) return null;
  return cents;
};
