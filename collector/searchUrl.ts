import { MAX_RESULT_LIMIT, type ProviderSearchQuery } from "./types.ts";

export const FACEBOOK_ORIGIN = "https://www.facebook.com";

/** A path-segment guard: a location of ".." or "toronto/search" must never reach the URL. */
export const LOCATION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * THE SEVEN MEASURED HEADERS. Dropping the `Sec-Fetch-*` set reproduces an HTTP 400 from
 * Facebook -- the header set is load-bearing, not decoration, and that was measured by getting
 * it wrong first.
 *
 * The exact `User-Agent` string is the one line in this repo that NO TEST CAN PIN: it was
 * recorded only as "Chrome 141 desktop", and a wrong one surfaces as a clean
 * UNAVAILABLE / unrecognized-page rather than a crash. It is settled by a live run, not by the
 * suite, and it is named in the uncovered-lines list.
 */
export const SEARCH_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1",
});

/**
 * Validation throws `TypeError`, and that is deliberate: a bad location or limit is a CONFIG
 * BUG, not a source outcome. Mapping it to PROVIDER_FAILURE would let a typo masquerade as
 * Facebook being broken and be retried forever.
 *
 * `encodeURIComponent`, not `URLSearchParams`: a space must be `%20`, which is what a browser
 * address bar sends, not `+`.
 *
 * `limit` is NOT a URL parameter -- it bounds the slice after parsing. The source has no such
 * parameter, and pretending it does would silently return whatever the page held.
 */
export const buildSearchUrl = (query: ProviderSearchQuery): string => {
  if (!LOCATION_PATTERN.test(query.location)) {
    throw new TypeError(`location must match ${LOCATION_PATTERN}: ${query.location}`);
  }
  if (typeof query.query !== "string" || query.query.trim() === "") {
    throw new TypeError("query must be a non-empty string");
  }
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_RESULT_LIMIT) {
    throw new TypeError(`limit must be an integer in [1, ${MAX_RESULT_LIMIT}]: ${query.limit}`);
  }
  if (!Number.isInteger(query.radiusKm) || query.radiusKm < 1) {
    throw new TypeError(`radiusKm must be a positive integer: ${query.radiusKm}`);
  }
  if (!Number.isInteger(query.daysSinceListed) || query.daysSinceListed < 1) {
    throw new TypeError(`daysSinceListed must be a positive integer: ${query.daysSinceListed}`);
  }

  return (
    `${FACEBOOK_ORIGIN}/marketplace/${query.location}/search` +
    `?query=${encodeURIComponent(query.query)}` +
    `&sortBy=creation_time_descend` +
    `&daysSinceListed=${query.daysSinceListed}` +
    `&radius=${query.radiusKm}`
  );
};

/** MEASURED to resolve for a real listing id. */
export const buildListingUrl = (id: string): string =>
  `${FACEBOOK_ORIGIN}/marketplace/item/${id}`;
