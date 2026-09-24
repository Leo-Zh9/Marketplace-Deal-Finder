/**
 * The one request the collector makes to the Worker. ONE request, NO retry.
 *
 * The POST is not retried, even on 5xx. The next run re-collects the same listings and
 * `recordSightings` is idempotent, so declining to retry loses nothing -- and a retry loop on a
 * process that lives on a laptop is precisely what turns one bad run into a hot loop.
 */

import type { RawListing } from "./types.ts";

/** Mirrors the Worker's `IngestBody`. Counts only; the Worker never sends an error string. */
export interface IngestSummary {
  received: number;
  stored: number;
  outcomes: Record<string, number>;
  contributions: Record<string, number>;
  pricesUnparsed: number;
  usage: { rowsRead: number; rowsWritten: number };
}

export type PostResult =
  | { ok: true; status: 200; summary: IngestSummary }
  | { ok: false; status: number | null; code: string | null; retryable: boolean };

export interface PostInput {
  apiBase: string;
  token: string;
  source: string;
  componentType: string;
  market: { latitude: number; longitude: number; radiusKm: number };
  listings: readonly RawListing[];
}

/**
 * EXACTLY the five wire fields, AND `priceText`/`locationText` PASS THROUGH AS `null` when the
 * source omitted them. Coercing either to "" -- or dropping the key -- turns a real listing into
 * a 400 that stores nothing for the WHOLE batch; the route accepts null for exactly these two.
 * `creationTime` is dropped here on purpose -- it sorted and
 * sliced the page and no column stores it -- and there is no `priceCents`, `modelKey`,
 * `variantKey`, `validity` or `observedAt` field for a compromised collector to set. The
 * Worker refuses unknown keys rather than dropping them, so adding one here is a 400, not a
 * silent partial write.
 */
const wireListing = (listing: RawListing) => ({
  listingId: listing.id,
  title: listing.title,
  priceText: listing.priceText,
  locationText: listing.locationText,
  url: listing.url,
});

/**
 * RETRYABILITY IS ABOUT WHO MUST ACT, not about the number.
 * 4xx is a CONTRACT error -- the collector and the Worker disagree about the payload, or the
 * credential is wrong -- and a human must look, so it is never retryable. 5xx and a transport
 * failure are the server's problem and the next scheduled run is the retry.
 */
const isRetryable = (status: number): boolean => status >= 500;

export const postListings = async (
  input: PostInput,
  fetchImplementation: typeof fetch = globalThis.fetch,
): Promise<PostResult> => {
  const body = JSON.stringify({
    source: input.source,
    componentType: input.componentType,
    market: input.market,
    listings: input.listings.map(wireListing),
  });

  let response: Response;
  try {
    response = await fetchImplementation(`${input.apiBase}/api/listings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // A CUSTOM header, never `Authorization`, and NO `Origin`: the ingest route refuses any
        // request carrying an Origin at all, and the token in `Authorization` would be read by
        // the Worker's Firebase bearer path on every other route.
        "X-Collector-Token": input.token,
      },
      body,
    });
  } catch {
    return { ok: false, status: null, code: null, retryable: true };
  }

  if (response.status === 200) {
    const summary = (await response.json()) as IngestSummary;
    return { ok: true, status: 200, summary };
  }

  let code: string | null = null;
  try {
    const parsed = (await response.json()) as { error?: { code?: unknown } };
    if (typeof parsed?.error?.code === "string") code = parsed.error.code;
  } catch {
    code = null;
  }

  return { ok: false, status: response.status, code, retryable: isRetryable(response.status) };
};
