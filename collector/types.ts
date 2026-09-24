/**
 * The collector's contracts. Nothing here is Facebook-specific: `source` is an opaque value
 * the operator configures, and neither this file nor the Worker enumerates it.
 *
 * The collector runs on the operator's machine because Facebook Marketplace CANNOT be collected
 * from Cloudflare. Measured, identical code, two egress points, one minute apart: 10 listings
 * from a residential IP; 0 listings and a login wall at HTTP 200 from Cloudflare. Everything
 * else -- storage, evaluation, monitoring, telemetry -- stays on Cloudflare exactly as built.
 */

export type ProviderResultState =
  | "SUCCESS"
  | "SOURCE_EMPTY"
  | "PROVIDER_FAILURE"
  | "RATE_LIMITED"
  | "UNAVAILABLE";

export type ProviderReason =
  | "ok"
  | "no-results"
  | "parser-blind"
  | "block-unparseable"
  | "listing-schema-changed"
  | "unrecognized-page"
  | "unexpected-redirect"
  | "blocked-redirect"
  | "http-client-error"
  | "http-server-error"
  | "rate-limited"
  | "timeout"
  | "network-error";

/**
 * RAW, deliberately NOT the Worker's `Listing`: no modelKey, no variantKey, no priceCents.
 * The collector never computes any of those -- the backend is the authority over every field
 * that can move money, and the wire format has no room for them.
 */
export interface RawListing {
  id: string;
  title: string;
  /** VERBATIM, e.g. "CA$3,000" or "CA$0". Never falsy-coerced: "CA$0" is a real price. */
  priceText: string | null;
  /** Unix SECONDS, as the source reports it. Used to sort and slice, then DISCARDED -- no
   * column stores it, so it never crosses the wire. */
  creationTime: number;
  locationText: string | null;
  url: string;
}

export interface ProviderSearchQuery {
  location: string;
  radiusKm: number;
  query: string;
  limit: number;
  daysSinceListed: number;
}

export interface ParsedPage {
  /** Sorted newest-first; NOT yet limited. */
  listings: RawListing[];
  acceptedBlocks: number;
  unparsedBlocks: number;
  rejectedBlocks: number;
  sourceOrdered: boolean;
  shellPresent: boolean;
  evidencePresent: boolean;
}

/** The spec's limit. Exported as the value a caller should pass; never a silent default. */
export const SPEC_RESULT_LIMIT = 15;

/** One page yields ~24 listings and the collector does not paginate. */
export const MAX_RESULT_LIMIT = 50;
