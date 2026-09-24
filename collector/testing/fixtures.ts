/**
 * The two committed captures, plus the derived pages. EVERY VARIANT IS ONE STRING OPERATION ON
 * A REAL CAPTURE, so what makes a variant different is visible on one line rather than hidden in
 * a second hand-built file that can drift.
 *
 * A trimmed fixture's real risk is a mis-trim that is internally consistent but no longer
 * resembles a real page: it would still parse and still pass P1 while no longer being ABLE to
 * kill P2's mutation. The provenance comments inside the two .html files record exactly what was
 * cut and what was preserved, and P1/P2 pin values measured on the untouched 684 KB capture.
 */

import emptyHtml from "./fixtures/facebookSearchEmpty.html?raw";
import pageHtml from "./fixtures/facebookSearchPage.html?raw";

export const facebookSearchPage = pageHtml;
export const facebookSearchEmpty = emptyHtml;

/** The six ids, in capture order, which is also strictly-descending creation_time order. */
export const FIXTURE_IDS = [
  "1807946430653887",
  "915010494744438",
  "913388811629562",
  "1812246723463464",
  "2253354775457674",
  "1814788326341654",
] as const;

const EDGE_PATTERN =
  /\{"node":\{"__typename":"MarketplaceFeedListingStoryObject".*?,"cursor":null,"__typename":"MarketplaceSearchFeedStoriesEdge"\}/gs;

/**
 * The same six listings in REVERSE capture order, so the source's own order is ascending.
 * `sourceOrdered` must go false while the parser still returns all six newest-first -- and a
 * parser that slices before sorting returns the four OLDEST ids here, which is the point.
 */
export const reordered = (html: string = pageHtml): string => {
  const edges = html.match(EDGE_PATTERN) ?? [];
  let index = edges.length;
  return html.replace(EDGE_PATTERN, () => edges[(index -= 1)]);
};

/** The anchor's typename renamed: zero blocks parse, and every evidence marker survives. */
export const withRenamedTypename = (html: string = pageHtml): string =>
  html.replaceAll('"__typename":"GroupCommerceProductItem"', '"__typename":"GroupCommerceProductItemV2"');

/** One block's JSON made unparseable while its braces stay balanced: 5 accepted, 1 unparsed. */
export const withCorruptBlock = (html: string = pageHtml): string =>
  html.replace('"is_live":true', '"is_live":tru');

/** The body cut inside the last block, so its braces never close: 5 accepted, 1 unparsed. */
export const truncatedMidBlock = (html: string = pageHtml): string =>
  html.slice(0, html.lastIndexOf('"listing":{"__typename":"GroupCommerceProductItem"') + 400);

/** One block loses a required field: 5 accepted, 1 rejected. */
export const withMissingTitle = (html: string = pageHtml): string =>
  html.replace('"marketplace_listing_title"', '"marketplace_listing_name"');

/** Every block loses it. */
export const withAllTitlesRenamed = (html: string = pageHtml): string =>
  html.replaceAll('"marketplace_listing_title"', '"marketplace_listing_name"');

/** The CA$0 listing keeps its `city` but loses `city_page`, so the `??` fallback is exercised. */
export const withoutCityPage = (html: string = pageHtml): string =>
  html.replace(
    '"city_page":{"display_name":"Markdale, Ontario","id":"105390926160713"}',
    '"city_page":null',
  );

/** The CA$0 listing loses `location` entirely, so `locationText` must be null and not throw. */
export const withoutLocation = (html: string = pageHtml): string =>
  html.replace(
    '"location":{"reverse_geocode":{"city":"Grey Highlands","state":"ON","city_page":{"display_name":"Markdale, Ontario","id":"105390926160713"}}}',
    '"location":null',
  );

/** All three shell markers removed; the evidence markers are untouched. */
export const withoutShellMarkers = (html: string = pageHtml): string =>
  html
    .replaceAll("CometMarketplaceSearchContentContainer", "CometSearchContainerX")
    .replaceAll("MarketplaceFilterField", "FilterFieldX")
    .replaceAll("marketplace_seo_page", "seo_page_x");

/** ~650 KB, the size of a real capture, for the parse-cost measurement. */
export const paddedToRealisticSize = (html: string = pageHtml): string =>
  `${html}<!--${"x".repeat(Math.max(0, 650_000 - html.length))}-->`;
