/**
 * THE CENTRAL PROBLEM THIS FILE SOLVES: a blind parse must not look like an empty market.
 *
 * A parser that silently returns nothing when Facebook renames a field is indistinguishable
 * from a genuinely empty search, and the difference is "a human must look" versus "carry on".
 * So the page is read by TWO independent detectors plus two counters:
 *
 *   P (precise)    -- the listing anchor, brace-scanned and JSON.parsed. This also dissolves the
 *                     "second nested id" hazard BY CONSTRUCTION: we read `object.id`, never "the
 *                     first id after the typename". The nested photo id is preserved in the
 *                     fixture precisely so P2 can kill that mutation.
 *   W (evidence)   -- four field names MEASURED at 0 occurrences on a real empty capture and
 *                     >=1 on a real populated one. W IS A BOOLEAN, NEVER A COUNT:
 *                     `listing_price` occurs 72 times for 24 listings because
 *                     `min_listing_price` contains it, so any ratio built on W is a fabrication.
 *   S (shell)      -- three strings MEASURED IDENTICAL on both captures (19/14/2). Any one means
 *                     "this is a Marketplace search page".
 *   counters       -- `unparsedBlocks` (anchor found, scan or parse failed) and `rejectedBlocks`
 *                     (parsed, but a required field is missing or wrong-typed).
 *
 * HONEST LIMIT, stated here rather than buried: the four evidence markers are NOT independent.
 * One wholesale response rename could remove all four together with the anchor, and we would
 * report SOURCE_EMPTY forever. A single response cannot rule that out; the residual defence is
 * an alarm on N consecutive empty runs, which needs cross-run state and is NOT built here.
 */

import { buildListingUrl } from "./searchUrl.ts";
import type { ParsedPage, ProviderReason, ProviderResultState, RawListing } from "./types.ts";

export const LISTING_ANCHOR = '"listing":{"__typename":"GroupCommerceProductItem"';

/** MEASURED identical on a 24-result and a 0-result capture. */
export const SHELL_MARKERS: readonly string[] = [
  "CometMarketplaceSearchContentContainer",
  "MarketplaceFilterField",
  "marketplace_seo_page",
];

/**
 * MEASURED 120 / 24 / 72 / 24 on the populated capture and 0 / 0 / 0 / 0 on the empty one.
 * DELIBERATELY NOT a captcha string: "captcha" occurs 24 times on a perfectly healthy page, so
 * a string-search captcha detector is a permanent false positive.
 */
export const RESULT_EVIDENCE_MARKERS: readonly string[] = [
  "GroupCommerceProductItem",
  "marketplace_listing_title",
  "listing_price",
  "__isMarketplaceListingRenderable",
];

/**
 * Brace-balanced scan honouring JSON string escapes. `indexOf(ANCHOR, from)` on the ORIGINAL
 * string, never `indexOf` over a fresh `slice(from)` per block -- that form is quadratic and
 * measurably so on a 640 KB page.
 */
const extractObject = (source: string, openIndex: number): string | null => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, index + 1);
    }
  }
  return null;
};

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export const parseSearchPage = (html: string): ParsedPage => {
  const shellPresent = SHELL_MARKERS.some((marker) => html.includes(marker));
  const evidencePresent = RESULT_EVIDENCE_MARKERS.some((marker) => html.includes(marker));

  const listings: RawListing[] = [];
  let unparsedBlocks = 0;
  let rejectedBlocks = 0;
  let from = 0;

  for (;;) {
    const at = html.indexOf(LISTING_ANCHOR, from);
    if (at === -1) break;
    from = at + LISTING_ANCHOR.length;

    const raw = extractObject(html, html.indexOf("{", at));
    if (raw === null) {
      unparsedBlocks += 1;
      continue;
    }

    let block: Record<string, unknown>;
    try {
      block = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      unparsedBlocks += 1;
      continue;
    }

    const id = stringOrNull(block.id);
    const title = stringOrNull(block.marketplace_listing_title);
    const creationTime = block.creation_time;
    if (id === null || title === null || typeof creationTime !== "number" || !Number.isFinite(creationTime)) {
      rejectedBlocks += 1;
      continue;
    }

    // `formatted_amount`, never `amount` -- `amount` is "0.00" for the free listing and the
    // stored column takes the source's own rendering. Never falsy-coerced.
    const price = (block.listing_price as Record<string, unknown> | null | undefined)?.formatted_amount;
    // display_name BEFORE city. MEASURED that the two differ on all 24 captured rows
    // ("Grey Highlands" vs "Markdale, Ontario"), which is what makes the swapped order lethal.
    const geocode = (block.location as { reverse_geocode?: Record<string, unknown> } | null | undefined)
      ?.reverse_geocode;
    const displayName = stringOrNull(
      (geocode?.city_page as Record<string, unknown> | null | undefined)?.display_name,
    );

    listings.push({
      id,
      title,
      creationTime,
      priceText: stringOrNull(price),
      locationText: displayName ?? stringOrNull(geocode?.city),
      url: buildListingUrl(id),
    });
  }

  // `sourceOrdered` records whether the SOURCE's order was already descending; the listings are
  // then sorted before the caller slices. Sorting is not the "client-side discovery" the design
  // rejected -- it guarantees the N we keep really are the newest N of what came back, while
  // `sourceOrdered: false` still raises the alarm that `sortBy` stopped working. Both signals
  // survive and neither hides the other.
  const sourceOrdered = listings.every(
    (listing, index) => index === 0 || listings[index - 1].creationTime >= listing.creationTime,
  );

  return {
    listings: [...listings].sort((a, b) => b.creationTime - a.creationTime),
    acceptedBlocks: listings.length,
    unparsedBlocks,
    rejectedBlocks,
    sourceOrdered,
    shellPresent,
    evidencePresent,
  };
};

/**
 * THE ORDER OF THESE SIX BRANCHES IS THE DESIGN, and two of them are deliberate:
 *
 * STRICT (1 and 2 before 3): any unparsed OR any rejected block fails the WHOLE result and the
 * caller posts nothing. The rejected alternative -- keep the good blocks, report the counts --
 * converts a schema change into slow, silent, partial data loss into a running aggregate, which
 * is the exact failure this detector exists to prevent. Defensible because the three required
 * fields are not "usually present": 24/24 captured blocks carry all three, correctly typed.
 *
 * ACCEPTED OUTRANKS SHELL (3 before 5): if Facebook renames its internal Relay module names but
 * listings still parse, this returns SUCCESS. Shell-first would turn such a rename into a
 * permanent self-inflicted blackout. The cost is a wrong telemetry label on a genuinely empty
 * day after such a rename -- identical behaviour, wrong word. Wrong label beats blackout.
 *
 * DELETING BRANCH 4 IS THE MUTATION THIS WHOLE MODULE EXISTS TO FAIL: without it, a page with
 * evidence of results that we could not parse returns SOURCE_EMPTY, and the pipeline goes quiet
 * instead of loud. classify.test.ts C1 row 4 is that test.
 */
export const classifyParsedPage = (
  page: ParsedPage,
): { state: ProviderResultState; reason: ProviderReason } => {
  if (page.unparsedBlocks > 0) return { state: "PROVIDER_FAILURE", reason: "block-unparseable" };
  if (page.rejectedBlocks > 0) {
    return { state: "PROVIDER_FAILURE", reason: "listing-schema-changed" };
  }
  if (page.acceptedBlocks > 0) return { state: "SUCCESS", reason: "ok" };
  if (page.evidencePresent) return { state: "PROVIDER_FAILURE", reason: "parser-blind" };
  if (!page.shellPresent) return { state: "UNAVAILABLE", reason: "unrecognized-page" };
  return { state: "SOURCE_EMPTY", reason: "no-results" };
};
