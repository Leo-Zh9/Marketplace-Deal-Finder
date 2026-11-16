/**
 * THE DISCORD MESSAGE: plain `content`, at most 2000 characters, no embeds, no mentions.
 *
 * TWO FIELDS ARE ATTACKER-CONTROLLED -- the listing title and location are whatever a seller typed
 * on Facebook -- and both are made inert the same way: every run of whitespace (newlines
 * included) collapses to one space, so a title cannot start a `# heading` or a `> quote` on its
 * own line, and then every Markdown-significant character is backslash-escaped, so
 * `[click](https://evil.example)` renders as literal text rather than a masked link. Mentions are
 * neutralised by the payload, not here: `allowed_mentions: {parse: []}` (deliver.ts) means
 * `@everyone` in a title pings nobody.
 *
 * THE LINK IS BUILT FROM `listing_id`, NEVER FROM THE STORED `url`. That column is written by
 * whoever holds the collector token; the id is validated at ingest against `^[A-Za-z0-9_-]+$`
 * (worker/api/listings.ts) and is encoded here as well. The shape is the collector's own
 * `buildListingUrl` (collector/searchUrl.ts); format.test.ts asserts the two agree.
 */

import { referenceAverageCents } from "../evaluation/dealRules";
import { MINIMUM_REFERENCE_COUNT } from "../evaluation/types";
import { discountPercentFrom } from "../api/verdicts";
import type { RecheckedListing } from "./recheck";

export const MAX_CONTENT_CHARS = 2000;
export const MAX_TITLE_CHARS = 200;
export const MAX_LOCATION_CHARS = 100;

/** collector/searchUrl.ts FACEBOOK_ORIGIN + buildListingUrl's path. */
export const LISTING_URL_PREFIX = "https://www.facebook.com/marketplace/item/";

export const listingUrl = (listingId: string): string =>
  `${LISTING_URL_PREFIX}${encodeURIComponent(listingId)}`;

const MARKDOWN = /[\\*_~|>[\]()`#]/g;

/** Collapse whitespace, cut to `max` code points, then escape. Cut first so no escape is split. */
export const sanitizeText = (raw: string, max: number): string => {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  const points = Array.from(collapsed);
  const cut = points.length > max ? `${points.slice(0, max - 1).join("")}…` : collapsed;
  return cut.replace(MARKDOWN, (character) => `\\${character}`);
};

export const formatCents = (cents: number): string => {
  const dollars = Math.floor(cents / 100).toLocaleString("en-US");
  return `CA$${dollars}.${String(cents % 100).padStart(2, "0")}`;
};

const ruleText = (listing: RecheckedListing): string => {
  const parts: string[] = [];
  if (listing.mode !== "MAXIMUM_PRICE" && listing.minimumDiscountPercent !== null) {
    parts.push(`at least ${listing.minimumDiscountPercent}% below average`);
  }
  if (listing.mode !== "DISCOUNT" && listing.maximumPriceCents !== null) {
    parts.push(`at most ${formatCents(listing.maximumPriceCents)}`);
  }
  return parts.join(" and ");
};

export interface FormatInput {
  listingId: string;
  listing: RecheckedListing;
  now: number;
}

export const formatMessage = ({ listingId, listing, now }: FormatInput): string => {
  const count = listing.referenceCount;
  const average =
    count !== null && count >= MINIMUM_REFERENCE_COUNT
      ? referenceAverageCents(listing.referenceTotalCents, count)
      : null;
  const discount = discountPercentFrom(listing.priceCents, average);
  const hours = Math.max(0, Math.floor((now - listing.lastSeenAt) / 3600));

  const lines = [
    `Deal: ${sanitizeText(listing.modelKey, 100)} for ${
      listing.priceCents === null ? "an unknown price" : formatCents(listing.priceCents)
    }`,
    `Rule: ${ruleText(listing)}`,
    average === null
      ? `Market: no average yet (${count ?? 0} references)`
      : `Market: average ${formatCents(average)}, ${(discount ?? 0).toFixed(1)}% below, ` +
        `${count} references`,
    `Area: ${listing.radiusKm === null ? "unknown" : `${listing.radiusKm} km`} radius, ` +
      `listed in ${
        listing.locationText === null
          ? "an unknown location"
          : sanitizeText(listing.locationText, MAX_LOCATION_CHARS)
      }, last seen ${hours}h ago`,
    `Title: ${sanitizeText(listing.title, MAX_TITLE_CHARS)}`,
    listingUrl(listingId),
  ];
  // Bounded by construction (title 200, location 100, model 100, the rest short); the slice is
  // the backstop that makes the 2000-character limit a property rather than an estimate.
  return lines.join("\n").slice(0, MAX_CONTENT_CHARS);
};
