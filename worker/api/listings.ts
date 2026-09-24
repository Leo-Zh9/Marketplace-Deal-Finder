/**
 * POST /api/listings -- the only path by which a listing can enter the database.
 *
 * It returns a RESULT, never a Response: worker/index.ts owns securityHeaders, `Vary` and the
 * error envelope, exactly as worker/api/settings.ts does, so a handler cannot ship a reply that
 * forgot one.
 *
 * THE BACKEND IS THE AUTHORITY OVER EVERYTHING THAT CAN MOVE MONEY. The wire carries five
 * fields per listing -- listingId, title, priceText, locationText, url -- and nothing else.
 * `priceCents` is computed here from the text; `modelKey`, `variantKey`, `validity` and
 * `observedAt` are set here; `componentType` and `market` come from the envelope and are
 * validated before use. Unknown keys are REFUSED, not dropped, at both levels, so a field this
 * module does not know about cannot arrive and be ignored.
 *
 * `recordSightings` is CALLED, not reimplemented, not wrapped and not defended against. It is
 * the aggregate's only writer and 3C's suite pins it.
 */

import { recordSightings } from "../storage/recordSightings";
import type { Listing, Sighting, SightingReport } from "../storage/types";
import { parsePriceText } from "./priceText";

/**
 * One real Marketplace page yields 24 listings (measured). 100 is ~4x headroom and bounds the
 * request's D1 work at 2 classification reads plus at most 100 per-listing batches.
 */
export const MAX_LISTINGS_PER_BATCH = 100;

/**
 * 128 KiB -- A DELIBERATE POLICY BOUND BELOW THE THEORETICAL MAXIMUM, NOT A DERIVATION.
 *
 * Every per-field limit below is a `.length` limit, i.e. UTF-16 code units, and one unit can
 * cost up to three UTF-8 bytes. The worst LEGAL batch is therefore ~100 x (3 x 1,028 + ~90)
 * = ~317 KB, which this cap refuses. What it admits, with a 5.7x margin, is the worst batch
 * this collector can produce (17-char ids, <=99-char titles, ~55-char urls, ~25-char
 * locations, all ASCII: ~230 B/listing, ~23 KB for 100) and a 100-listing batch at every field
 * maximum in ASCII (~112 KB, test L8c).
 *
 * THE CONSEQUENCE, NAMED SO IT IS NOT DISCOVERED IN PRODUCTION: a future collector sending 100
 * listings with long multi-byte titles gets 413, not 400, because the body cap fires before
 * per-field validation. L8d asserts that gap deliberately. Raising this constant is the fix.
 */
export const MAX_INGEST_BODY_BYTES = 131_072;

const MAX_LISTING_ID_LENGTH = 64;
const MAX_TITLE_LENGTH = 300;
const MAX_URL_LENGTH = 512;
const MAX_LOCATION_LENGTH = 120;
const MAX_PRICE_TEXT_LENGTH = 32;
const MAX_SOURCE_LENGTH = 64;

/**
 * EXHAUSTIVE over `Listing["componentType"]` by construction: the Record type makes adding a
 * component type to worker/storage/types.ts without adding it here a compile error.
 * `Object.hasOwn`, never `key in`, so "toString" and "constructor" are not component types.
 */
const COMPONENT_TYPES: Record<Listing["componentType"], true> = {
  cpu: true,
  cpu_cooler: true,
  motherboard: true,
  ram: true,
  storage: true,
  gpu: true,
  psu: true,
  case: true,
  case_fan: true,
};

/** EXACTLY the five fields that map to a stored column. Anything else is refused. */
const WIRE_KEYS = new Set(["listingId", "title", "priceText", "locationText", "url"]);
const ENVELOPE_KEYS = new Set(["source", "componentType", "market", "listings"]);

/**
 * `source` stays opaque -- shape-validated, never enumerated (invariant 1). No `m` flag and no
 * `[\s\S]`: MEASURED that JavaScript's `$` does not match before a trailing newline, so
 * "facebook\n" is refused. A port of this regex to Python would accept it.
 */
const SOURCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Ids are keys in a composite primary key and go into a URL; keep the alphabet boring. */
const LISTING_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface IngestBody {
  received: number;
  stored: number;
  outcomes: Record<string, number>;
  contributions: Record<string, number>;
  pricesUnparsed: number;
  usage: { rowsRead: number; rowsWritten: number };
}

export type IngestResult =
  | { ok: true; status: 200; body: IngestBody }
  | { ok: false; status: number; code: string; details?: Record<string, unknown> };

const fail = (
  status: number,
  code: string,
  details?: Record<string, unknown>,
): IngestResult => (details === undefined ? { ok: false, status, code } : { ok: false, status, code, details });

/**
 * The body bound is enforced by READING THE STREAM AND CANCELLING, not by trusting
 * Content-Length.
 *
 * worker/api/settings.ts documents that its own byte check happens after `request.text()` has
 * already buffered a chunked body, and accepts it because its only reachable caller is an
 * approved human spending their own isolate. HERE THE CALLER IS A BEARER SECRET WITH NO HUMAN
 * BEHIND IT, so that reasoning does not transfer. MEASURED: a stream body carries no
 * Content-Length at all, so the declared check is skipped entirely for one.
 *
 * ONE HONEST LIMIT: the check runs AFTER the offending chunk has been read, so the bound is
 * "at most one chunk over the cap", not "never more than N bytes resident". Do not write the
 * tighter comment.
 *
 * `request.body === null` -- a POST with no body at all, which is the shape a broken collector
 * actually sends -- returns `{ok:true, text:""}`, which lands on INVALID_JSON. Deliberate, and
 * pinned by L10 rather than left incidental.
 */
export const readBoundedBody = async (
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> => {
  const body = request.body;
  if (body === null) return { ok: true, text: "" };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
};

/**
 * COUNTS ONLY. `SightingResult.error` carries D1's message ("no such table: listings") and MUST
 * NOT cross the wire -- a caller holding only a bearer secret learns nothing about the schema
 * from a failure. Failed listings are `console.warn`ed with their id and message instead, for
 * `wrangler tail`. L15 asserts the serialized body contains neither "error" nor the message.
 *
 * All seven contribution keys and all four outcome keys are always present at 0, so the shape
 * is stable for a caller that indexes it.
 */
export const summarizeReport = (
  report: SightingReport,
  received: number,
  pricesUnparsed: number,
): IngestBody => {
  const outcomes: Record<string, number> = { NEW: 0, CHANGED: 0, UNCHANGED: 0, FAILED: 0 };
  const contributions: Record<string, number> = {
    recorded: 0,
    restored: 0,
    removed: 0,
    none: 0,
    "skipped-no-price": 0,
    "skipped-no-model": 0,
    "skipped-invalid": 0,
  };

  for (const result of report.results) {
    outcomes[result.outcome] += 1;
    contributions[result.contribution] += 1;
  }

  return {
    received,
    stored: report.results.length,
    outcomes,
    contributions,
    pricesUnparsed,
    usage: report.usage,
  };
};

const isBoundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

export const handlePostListings = async (
  request: Request,
  db: D1Database,
  now: number,
): Promise<IngestResult> => {
  const mediaType = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") return fail(415, "UNSUPPORTED_MEDIA_TYPE");

  // The DECLARED size, refused before the body stream is touched at all.
  const declared = Number.parseInt(request.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_INGEST_BODY_BYTES) {
    return fail(413, "PAYLOAD_TOO_LARGE");
  }

  // The MEASURED size. A disconnect mid-POST rejects here; unwrapped it would throw out of
  // handleRequest as a bare 500 carrying none of securityHeaders and no error envelope.
  let raw: { ok: true; text: string } | { ok: false };
  try {
    raw = await readBoundedBody(request, MAX_INGEST_BODY_BYTES);
  } catch {
    return fail(400, "INVALID_JSON");
  }
  if (!raw.ok) return fail(413, "PAYLOAD_TOO_LARGE");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    return fail(400, "INVALID_JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail(400, "INVALID_JSON");
  }

  // REFUSED, NOT DROPPED -- at both levels. `JSON.parse` makes "__proto__" an OWN key, so
  // Object.keys sees it and this loop refuses it; a client cannot smuggle a field past a
  // whitelist by naming it after something on Object.prototype.
  const envelope = parsed as Record<string, unknown>;
  for (const key of Object.keys(envelope)) {
    if (!ENVELOPE_KEYS.has(key)) return fail(400, "INVALID_LISTINGS", { field: key });
  }

  const source = envelope.source;
  if (
    typeof source !== "string" ||
    source.length > MAX_SOURCE_LENGTH ||
    !SOURCE_PATTERN.test(source)
  ) {
    return fail(400, "INVALID_LISTINGS", { field: "source" });
  }

  const componentType = envelope.componentType;
  if (typeof componentType !== "string" || !Object.hasOwn(COMPONENT_TYPES, componentType)) {
    return fail(400, "INVALID_LISTINGS", { field: "componentType" });
  }

  // THE MARKET IS VALIDATED BEFORE recordSightings IS CALLED, AND THAT IS A NAMED TRAP.
  // `marketKey` throws below 1 km, and `recordSightings` computes it OUTSIDE its per-listing
  // try/catch -- so an unvalidated `radiusKm: 0.4` rejects the whole call and surfaces as a
  // 503, or as a bare 500 without the wrapping try/catch below. Validated here it is a 400
  // naming the field. L6 covers 0.4 (refused) and 0.5 (accepted, because it rounds to 1).
  const market = envelope.market;
  if (typeof market !== "object" || market === null || Array.isArray(market)) {
    return fail(400, "INVALID_LISTINGS", { field: "market" });
  }
  const { latitude, longitude, radiusKm } = market as Record<string, unknown>;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return fail(400, "INVALID_LISTINGS", { field: "market.latitude" });
  }
  if (
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return fail(400, "INVALID_LISTINGS", { field: "market.longitude" });
  }
  if (typeof radiusKm !== "number" || !Number.isFinite(radiusKm) || Math.round(radiusKm) < 1) {
    return fail(400, "INVALID_LISTINGS", { field: "market.radiusKm" });
  }

  const listings = envelope.listings;
  if (!Array.isArray(listings)) return fail(400, "INVALID_LISTINGS", { field: "listings" });
  if (listings.length === 0) return fail(400, "INGEST_EMPTY_BATCH");
  if (listings.length > MAX_LISTINGS_PER_BATCH) return fail(400, "INGEST_BATCH_TOO_LARGE");

  const sightings: Sighting[] = [];
  let pricesUnparsed = 0;
  // Required by `Listing`; MEASURED that `recordSightings` never reads it.
  const observedAt = new Date(now * 1000).toISOString();

  for (const [index, entry] of listings.entries()) {
    const at = (field: string) => ({ field: `listings[${index}].${field}` });
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return fail(400, "INVALID_LISTINGS", { field: `listings[${index}]` });
    }

    const row = entry as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      if (!WIRE_KEYS.has(key)) return fail(400, "INVALID_LISTINGS", at(key));
    }

    if (!isBoundedString(row.listingId, MAX_LISTING_ID_LENGTH) || !LISTING_ID_PATTERN.test(row.listingId)) {
      return fail(400, "INVALID_LISTINGS", at("listingId"));
    }
    if (!isBoundedString(row.title, MAX_TITLE_LENGTH)) {
      return fail(400, "INVALID_LISTINGS", at("title"));
    }
    // `https://` EXACTLY, not `https?:`. The url is stored and later rendered as a link.
    if (!isBoundedString(row.url, MAX_URL_LENGTH) || !row.url.startsWith("https://")) {
      return fail(400, "INVALID_LISTINGS", at("url"));
    }
    if (!isBoundedString(row.priceText, MAX_PRICE_TEXT_LENGTH)) {
      return fail(400, "INVALID_LISTINGS", at("priceText"));
    }
    if (!isBoundedString(row.locationText, MAX_LOCATION_LENGTH)) {
      return fail(400, "INVALID_LISTINGS", at("locationText"));
    }

    // Unparseable is NULL, not a rejection: the listing is real and is stored with a null
    // price. The count is surfaced by `pricesUnparsed` and by nothing else -- MEASURED that
    // `skipped-no-price` is structurally unreachable while modelKey is always null, because
    // `skipReason` tests the model key first.
    const priceCents = parsePriceText(row.priceText);
    if (priceCents === null) pricesUnparsed += 1;

    sightings.push({
      listing: {
        listingId: row.listingId,
        componentType: componentType as Listing["componentType"],
        // HARDCODED. Normalization is the next slice; `recordSightings` reports a null model
        // key as `skipped-no-model`, which is precisely the signal that says "normalization
        // has not run yet" and the signal that slice watches go to zero.
        modelKey: null,
        variantKey: null,
        title: row.title,
        priceCents,
        locationText: row.locationText,
        url: row.url,
        observedAt,
      },
      // HARDCODED "VALID". A blanket NEEDS_REVIEW would flip every listing to
      // `skipped-invalid` and MASK `skipped-no-model`.
      validity: "VALID",
    });
  }

  let report: SightingReport;
  try {
    report = await recordSightings(db, {
      source,
      market: { latitude, longitude, radiusKm },
      sightings,
      now,
    });
  } catch {
    return fail(503, "INGEST_STORAGE_FAILED");
  }

  for (const result of report.results) {
    if (result.outcome === "FAILED") {
      console.warn(`ingest: listing ${result.listingId} failed: ${result.error ?? "unknown"}`);
    }
  }

  // A TOTAL STORAGE FAILURE IS A STORAGE FAILURE, NOT A SUCCESS.
  // MEASURED before this check existed: a D1 whose classification read succeeds and whose
  // per-listing batches all reject answered 200 {"stored":3,...,"FAILED":3} with ZERO rows
  // written, and the collector exited 0. An outage read clean at every layer an operator can
  // see. L14b is the test that kills it -- a D1 that rejects EVERY call throws on the
  // classification read instead and lands on the 503 above, which is why L14a alone cannot see
  // the defect.
  //
  // A PARTIAL failure still returns 200 with truthful counts (L14c): refusing the whole batch
  // would discard the rows that did land, and `recordSightings`' deliberate "never let one
  // poisoned listing abort a scan" is a property this route must not undo. The collector exits
  // non-zero on `outcomes.FAILED > 0`, so a partial failure is not silent either.
  if (report.results.length > 0 && report.results.every((result) => result.outcome === "FAILED")) {
    return fail(503, "INGEST_STORAGE_FAILED");
  }

  return {
    ok: true,
    status: 200,
    body: summarizeReport(report, sightings.length, pricesUnparsed),
  };
};
