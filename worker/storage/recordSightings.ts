/**
 * The write path: classify each sighting as NEW / CHANGED / UNCHANGED, then apply it
 * as exactly one db.batch().
 *
 * db.batch() is the only atomicity primitive D1 offers -- BEGIN TRANSACTION and
 * SAVEPOINT are rejected outright, and interactive transactions do not exist. So every
 * atomic unit here is one batch and nothing else.
 *
 * The one discipline, which everything else rests on: JavaScript chooses WHICH
 * statements to send; SQL computes every amount from the row's current stored value,
 * INSIDE the transaction. A JS-side read can go stale between the read and the batch;
 * a subquery inside the batch cannot. That is what makes every write path idempotent
 * and retry-safe -- replaying a batch subtracts what it just added and adds it back,
 * netting zero. If you find yourself binding a number you read a moment ago, stop.
 */

import { marketKey as computeMarketKey, type Market } from "./marketKey";
import {
  HEARTBEAT_SECONDS,
  type ContributionOutcome,
  type D1Usage,
  type Listing,
  type ObservationValidity,
  type Sighting,
  type SightingOutcome,
  type SightingReport,
  type SightingResult,
} from "./types";

/**
 * The '' sentinel, applied at exactly one place on the way in.
 *
 * Listing.variantKey is `string | null`, but a NULL in the database would break three
 * things silently: a NULL key column does not deduplicate in a UNIQUE index, ON CONFLICT
 * never fires on it, and every `WHERE variant_key = ?` bound to NULL matches ZERO rows --
 * which is SUBTRACT_OLD's correlated EXISTS and both of cleanup's subqueries. The
 * aggregate arithmetic would skip every variant-less listing while reporting success.
 */
export const normalizeVariantKey = (variantKey: string | null): string => variantKey ?? "";

const encoder = new TextEncoder();

/**
 * SHA-256 hex over the fields that define "has this listing's content changed".
 * JSON is injective over these types, so there is no delimiter-escaping problem.
 *
 * `variantKey` must be the ALREADY-normalized value -- the same one written to the row.
 * This function therefore takes a pre-normalized input object rather than a raw Listing,
 * so it is not possible to hash one value and store another. `null` and '' produce an
 * identical stored row but different hashes, so hashing the raw value makes a one-time
 * 3B normalization change re-hash the whole corpus: at N = 3,000 that is 18,000 rows
 * written in a single scan for no semantic change at all.
 *
 * `observedAt` is deliberately absent: including it would make every sighting CHANGED
 * and collapse the entire write budget.
 *
 * `source` is deliberately absent: the hash is only ever compared against the stored hash
 * of the row with that same (source, listing_id) key, so source is already held constant
 * by the lookup.
 */
export const contentHash = async (input: {
  marketKey: string;
  componentType: Listing["componentType"];
  modelKey: string | null;
  variantKey: string;
  title: string;
  priceCents: number | null;
  locationText: string | null;
  url: string;
  validity: ObservationValidity;
}): Promise<string> => {
  const canonical = JSON.stringify([
    input.componentType,
    input.modelKey,
    input.variantKey,
    input.title,
    input.priceCents,
    input.locationText,
    input.url,
    input.validity,
    input.marketKey,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonical));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * D1 caps bound parameters at 100 per statement: 100 placeholders succeed, 101 throws
 * `variable number must be between ?1 and ?100`. The classification statement spends ?1
 * on `source`, so the hard ceiling is 99 ids. DO NOT RAISE THIS ABOVE 99.
 */
const CHUNK_SIZE = 50;

const classifySql = (idCount: number): string => {
  const placeholders = Array.from({ length: idCount }, (_, index) => `?${index + 2}`).join(", ");
  // The LEFT JOIN returns both the stored listing state AND the stored contribution in
  // one read -- not just "does a row exist" but "what exactly does it hold".
  return `SELECT l.listing_id,
       l.content_hash,
       p.listing_id   AS obs_listing_id,
       p.market_key   AS obs_market_key,
       p.model_key    AS obs_model_key,
       p.variant_key  AS obs_variant_key,
       p.price_cents  AS obs_price_cents,
       l.last_seen_at AS listing_last_seen_at,
       p.last_seen_at AS obs_last_seen_at
  FROM listings l
  LEFT JOIN price_observations p
         ON p.source = l.source AND p.listing_id = l.listing_id
 WHERE l.source = ?1 AND l.listing_id IN (${placeholders})`;
};

interface StoredRow {
  listing_id: string;
  content_hash: string;
  obs_listing_id: string | null;
  obs_market_key: string;
  obs_model_key: string;
  obs_variant_key: string;
  obs_price_cents: number;
  listing_last_seen_at: number;
  obs_last_seen_at: number | null;
}

const SUBTRACT_OLD = `UPDATE model_stats
   SET count = count - 1,
       total_price_cents = total_price_cents -
           (SELECT p.price_cents FROM price_observations p
             WHERE p.source = ?1 AND p.listing_id = ?2)
 WHERE EXISTS (SELECT 1 FROM price_observations p
                WHERE p.source = ?1 AND p.listing_id = ?2
                  AND p.market_key  = model_stats.market_key
                  AND p.model_key   = model_stats.model_key
                  AND p.variant_key = model_stats.variant_key)`;

const ADD_NEW = `INSERT INTO model_stats (market_key, model_key, variant_key, count, total_price_cents)
VALUES (?1, ?2, ?3, 1, ?4)
ON CONFLICT (market_key, model_key, variant_key) DO UPDATE
   SET count = model_stats.count + 1,
       total_price_cents = model_stats.total_price_cents + excluded.total_price_cents`;

const UPSERT_OBS = `INSERT INTO price_observations
       (source, listing_id, market_key, model_key, variant_key, price_cents, last_seen_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
ON CONFLICT (source, listing_id) DO UPDATE
   SET market_key = excluded.market_key, model_key = excluded.model_key,
       variant_key = excluded.variant_key, price_cents = excluded.price_cents,
       last_seen_at = excluded.last_seen_at`;

const DELETE_OBS = `DELETE FROM price_observations WHERE source = ?1 AND listing_id = ?2`;

// first_seen_at is deliberately NOT in the DO UPDATE SET list.
const UPSERT_LISTING = `INSERT INTO listings (source, listing_id, market_key, component_type, model_key, variant_key,
                      title, price_cents, location_text, url, validity, content_hash,
                      first_seen_at, last_seen_at)
VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)
ON CONFLICT (source, listing_id) DO UPDATE
   SET market_key = excluded.market_key, component_type = excluded.component_type,
       model_key = excluded.model_key, variant_key = excluded.variant_key,
       title = excluded.title, price_cents = excluded.price_cents,
       location_text = excluded.location_text, url = excluded.url,
       validity = excluded.validity, content_hash = excluded.content_hash,
       last_seen_at = excluded.last_seen_at`;

const QUEUE_TASK = `INSERT INTO evaluation_tasks (source, listing_id, status, created_at)
VALUES (?1, ?2, 'PENDING', ?3)
ON CONFLICT (source, listing_id) DO UPDATE
   SET status = 'PENDING', created_at = excluded.created_at`;

// ?3 = now, ?4 = now - heartbeatSeconds. The suppression lives in the WHERE clause, not
// in a JS `if`, so a caller cannot bypass it and its effect is visible in D1's accounting.
const HEARTBEAT_LISTING = `UPDATE listings           SET last_seen_at = ?3
 WHERE source = ?1 AND listing_id = ?2 AND last_seen_at < ?4`;

const HEARTBEAT_OBS = `UPDATE price_observations SET last_seen_at = ?3
 WHERE source = ?1 AND listing_id = ?2 AND last_seen_at < ?4`;

interface Contribution {
  marketKey: string;
  modelKey: string;
  variantKey: string;
  priceCents: number;
}

const skipReason = (validity: ObservationValidity, listing: Listing): ContributionOutcome =>
  validity !== "VALID"
    ? "skipped-invalid"
    : listing.modelKey === null
      ? "skipped-no-model"
      : "skipped-no-price";

export const recordSightings = async (
  db: D1Database,
  input: {
    source: string;
    market: Market;
    sightings: Sighting[];
    now: number;
    heartbeatSeconds?: number;
  },
): Promise<SightingReport> => {
  const { source, now } = input;
  const heartbeatSeconds = input.heartbeatSeconds ?? HEARTBEAT_SECONDS;
  const marketKey = computeMarketKey(input.market);
  const usage: D1Usage = { rowsRead: 0, rowsWritten: 0 };
  const results: SightingResult[] = [];

  // One listing id may appear at most once per page, LAST WINS.
  //
  // The classification read below runs ONCE, before the loop, so a second entry for the same
  // id would classify against pre-page state rather than against what the first entry just
  // wrote. Every branch tolerates that except the removal path, which sends SUBTRACT_OLD and
  // DELETE_OBS only when the STALE read saw a stored contribution: a page holding the same
  // listing first as VALID and then as INVALID_REFERENCE (or with a null price) would leave
  // the observation and the aggregate row behind while storing the non-contributing listing,
  // and repeating that page would oscillate between the two states forever rather than heal.
  // The odd scans of that cycle also classify UNCHANGED and take the heartbeat branch, so
  // UPSERT_LISTING never runs and the stored row reflects the FIRST entry, not the last.
  //
  // A Map keyed by listing id, built in order, keeps the last entry for each id -- which is
  // the caller's most recent word on that listing -- and makes the pre-loop read sufficient
  // by construction. Nothing upstream guarantees uniqueness: `sightings` is an array, 3B is
  // not written yet, and neither the spec nor the plan states such a contract.
  const sightings = [
    ...new Map(
      input.sightings.map((sighting) => [sighting.listing.listingId, sighting]),
    ).values(),
  ];

  if (sightings.length === 0) {
    return { results, usage };
  }

  const ids = sightings.map((sighting) => sighting.listing.listingId);
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += CHUNK_SIZE) {
    chunks.push(ids.slice(index, index + CHUNK_SIZE));
  }

  const reads = await db.batch<StoredRow>(
    chunks.map((chunk) => db.prepare(classifySql(chunk.length)).bind(source, ...chunk)),
  );
  const storedRows = new Map<string, StoredRow>();
  for (const read of reads) {
    usage.rowsRead += read.meta.rows_read;
    usage.rowsWritten += read.meta.rows_written;
    for (const row of read.results) {
      storedRows.set(row.listing_id, row);
    }
  }

  for (const { listing, validity } of sightings) {
    try {
      const row = storedRows.get(listing.listingId);
      const variantKey = normalizeVariantKey(listing.variantKey);
      const freshHash = await contentHash({
        marketKey,
        componentType: listing.componentType,
        modelKey: listing.modelKey,
        variantKey,
        title: listing.title,
        priceCents: listing.priceCents,
        locationText: listing.locationText,
        url: listing.url,
        validity,
      });

      // What this sighting WOULD write, or null if it must not contribute.
      //
      // `> 0`, NOT `>= 0`. PLAN.md:59 -- "Only positive reference prices enter the average" --
      // and PLAN.md:52 prices an explicitly free item at 0. A free listing is still STORED and
      // still EVALUATED: evaluateBatch reads the asking price from `listings`, and the ABSENCE
      // of a price_observations row is exactly how it knows nothing must be subtracted from the
      // benchmark. It simply is not a price reference.
      //
      // THIS IS NOT THE SAME QUESTION AS dealRules' `isSafeCents`, which stays `>= 0` a hundred
      // lines away and MUST: this asks "may other listings be judged against this price", that
      // asks "can this price be judged at all". Tightening that one to match this one turns
      // every free listing into NEEDS_REVIEW / no-price. See R15b.
      //
      // Admitting zero incremented the divisor without moving the dividend, so one free listing
      // beside one 30,000c listing HALVED the benchmark -- and the benchmark is what "deal" is
      // defined against. `>= 0` was not a typo, but it was wrong.
      const contributes =
        validity === "VALID" &&
        listing.modelKey !== null &&
        listing.priceCents !== null &&
        Number.isSafeInteger(listing.priceCents) &&
        listing.priceCents > 0;

      const desired: Contribution | null = contributes
        ? {
            marketKey,
            modelKey: listing.modelKey!,
            variantKey,
            priceCents: listing.priceCents!,
          }
        : null;

      // What the database currently holds. obs_listing_id is the absence sentinel:
      // price_observations.listing_id is NOT NULL, so it is null only when the LEFT JOIN missed.
      const stored: Contribution | null =
        row === undefined || row.obs_listing_id === null
          ? null
          : {
              marketKey: row.obs_market_key,
              modelKey: row.obs_model_key,
              variantKey: row.obs_variant_key,
              priceCents: row.obs_price_cents,
            };

      // FIELD BY FIELD. Do NOT deep-equal the raw row against `desired`: the row's keys are
      // obs_market_key / obs_model_key / obs_variant_key / obs_price_cents, which share NO key
      // names with Contribution, so a structural comparison is FALSE for every contributing
      // listing on every scan -- turning every sighting into a write. That form was measured at
      // 217 rows/listing/day and a ceiling of 460 listings: a 21x budget blowout.
      const contributionMatchesStored =
        desired === null || stored === null
          ? desired === stored
          : desired.marketKey === stored.marketKey &&
            desired.modelKey === stored.modelKey &&
            desired.variantKey === stored.variantKey &&
            desired.priceCents === stored.priceCents;

      // UNCHANGED means BOTH rows already hold what we would write, not just the hash.
      // Without the contributionMatchesStored term, a listing whose observation cleanup
      // deleted after a >7-day gap re-sights as UNCHANGED, takes the heartbeat branch, and
      // its UPDATE matches zero rows -- the observation is never recreated and the listing
      // contributes nothing, permanently, while looking perfectly healthy.
      // last_seen_at is deliberately excluded from the comparison: it is the one field the
      // heartbeat is allowed to move without the sighting counting as a change.
      const outcome: SightingOutcome =
        row === undefined
          ? "NEW"
          : row.content_hash !== freshHash
            ? "CHANGED"
            : !contributionMatchesStored
              ? "CHANGED"
              : "UNCHANGED";

      const statements: D1PreparedStatement[] = [];
      let contribution: ContributionOutcome;

      if (outcome === "UNCHANGED") {
        contribution = "none";
        statements.push(
          db.prepare(HEARTBEAT_LISTING).bind(source, listing.listingId, now, now - heartbeatSeconds),
        );
        if (stored !== null) {
          statements.push(
            db.prepare(HEARTBEAT_OBS).bind(source, listing.listingId, now, now - heartbeatSeconds),
          );
        }
      } else {
        if (desired !== null) {
          // "restored" when the listing row already existed and the observation had to be
          // recreated, so the repair is visible in the report rather than silent.
          contribution = stored === null && row !== undefined ? "restored" : "recorded";
          statements.push(
            // SUBTRACT_OLD looks redundant for a NEW listing. That is the point: it makes the
            // batch's effect a function of stored state rather than of the JS read.
            db.prepare(SUBTRACT_OLD).bind(source, listing.listingId),
            db
              .prepare(ADD_NEW)
              .bind(desired.marketKey, desired.modelKey, desired.variantKey, desired.priceCents),
            db
              .prepare(UPSERT_OBS)
              .bind(
                source,
                listing.listingId,
                desired.marketKey,
                desired.modelKey,
                desired.variantKey,
                desired.priceCents,
                now,
              ),
          );
        } else if (stored !== null) {
          contribution = "removed";
          statements.push(
            db.prepare(SUBTRACT_OLD).bind(source, listing.listingId),
            db.prepare(DELETE_OBS).bind(source, listing.listingId),
          );
        } else {
          // A null price or null model cannot reach an aggregate -- not because of an `if`
          // inside the arithmetic, but because the arithmetic statements are absent.
          contribution = skipReason(validity, listing);
        }

        statements.push(
          db
            .prepare(UPSERT_LISTING)
            .bind(
              source,
              listing.listingId,
              marketKey,
              listing.componentType,
              listing.modelKey,
              variantKey,
              listing.title,
              listing.priceCents,
              listing.locationText,
              listing.url,
              validity,
              freshHash,
              now,
            ),
        );

        // A task is queued on NEW, and on any change where the CONTRIBUTION changed
        // (ARCHITECTURE.md section 8: "each new or relevantly changed listing"). A purely
        // cosmetic change does not queue one; refining "relevant" further is 3D's.
        if (outcome === "NEW" || !contributionMatchesStored) {
          statements.push(db.prepare(QUEUE_TASK).bind(source, listing.listingId, now));
        }
      }

      const written = await db.batch(statements);
      for (const statement of written) {
        usage.rowsRead += statement.meta.rows_read;
        usage.rowsWritten += statement.meta.rows_written;
      }

      results.push({ listingId: listing.listingId, outcome, contribution });
    } catch (error) {
      // A failing listing is recorded as FAILED and the rest of the page still proceeds.
      // Never let one poisoned listing abort a scan.
      results.push({
        listingId: listing.listingId,
        outcome: "FAILED",
        contribution: "none",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { results, usage };
};
