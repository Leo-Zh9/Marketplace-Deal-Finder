/**
 * GET /api/verdicts -- the evaluated listings the page shows: every stored listing with the
 * verdict 3D committed for it, the market average AS IT STANDS NOW, newest-first inside a
 * deal-first ordering, bounded.
 *
 * "AS IT STANDS NOW", NOT "THE AVERAGE THAT VERDICT RESTED ON". The earlier wording claimed
 * more than this read can deliver: the basis of a verdict is never persisted -- 3D commits
 * `verdict` and not `reason`, and nothing stores the aggregate it was computed against -- and
 * `evaluateBatch.ts:98-100` states that NOTHING REQUEUES A TASK WHEN THE MARKET CHANGES. So an
 * older DEAL steady-states beside a comparison drawn from a market that has since moved, and
 * the page can read `Deal / vs. market average 4.0% above`. That is a true statement of two
 * separately-true facts, and it is the cost of serving a verdict and a live aggregate together.
 * Serving the basis instead would need it persisted, which is a 3D change this slice does not
 * make. Do not restore the stronger wording without that column.
 */

import { referenceAverageCents } from "../evaluation/dealRules";
import { MINIMUM_REFERENCE_COUNT } from "../evaluation/types";
import { CATALOG_COMPONENT_ID } from "../normalize/catalogIndex";
import type { ComponentType } from "../../src/types";

export const VERDICT_PAGE_SIZE = 50;

export type WireStatus = "DEAL" | "NOT_DEAL" | "NEEDS_REVIEW" | "PENDING";

export interface WireListing {
  source: string;
  listingId: string;
  componentType: ComponentType;
  modelKey: string | null;
  variantKey: string | null;
  title: string;
  priceCents: number | null;
  location: string | null;
  url: string;
  observedAt: string;
  evaluation: {
    status: WireStatus;
    averagePriceCents?: number;
    discountPercent?: number;
  };
}

export interface VerdictsBody {
  listings: WireListing[];
  truncated: boolean;
}

export type VerdictsResult =
  | { ok: true; status: 200; body: VerdictsBody }
  | {
      ok: false;
      status: number;
      /**
       * TWO CODES, NOT ONE, AND THE DISTINCTION IS THE WHOLE REASON THE `try` BELOW IS NARROW.
       * `VERDICTS_STORAGE_FAILED` means the READ failed -- D1, the binding, the migration.
       * `VERDICTS_ROWS_UNUSABLE` means the read SUCCEEDED and every row it returned was
       * unpresentable -- a catalog/collector version skew, or a bad hand-written write. Those
       * are two different fixes, and `worker/index.ts`'s own rule is that three fixes behind
       * one code sends an operator to the wrong one. Returning the storage code here would
       * reintroduce, on the wire, exactly the miscoding narrowing the `try` removed.
       */
      code: "VERDICTS_STORAGE_FAILED" | "VERDICTS_ROWS_UNUSABLE";
    };

/**
 * THE PLAN, THE GROWTH TERM AND THE LEVER, in the idiom `migrations/0002` already uses for its
 * own three statements. MEASURED on miniflare D1 via `EXPLAIN QUERY PLAN`:
 *
 *   SCAN l USING INDEX sqlite_autoindex_listings_1
 *   SEARCH t USING INDEX sqlite_autoindex_evaluation_tasks_1 (source=? AND listing_id=?) LEFT-JOIN
 *   SEARCH p USING INDEX sqlite_autoindex_price_observations_1 (source=? AND listing_id=?) LEFT-JOIN
 *   SEARCH s USING INDEX sqlite_autoindex_model_stats_1 (market_key=? AND model_key=? AND variant_key=?) LEFT-JOIN
 *   USE TEMP B-TREE FOR ORDER BY
 *
 * A full scan of `listings` plus one primary-key seek per row into each of the three joined
 * tables. `rows_read` is LINEAR IN THE CORPUS and each POPULATED joined table adds exactly one
 * more multiple of it. MEASURED, `rows_read` at corpus 200 and 400 (identical ratios at both,
 * so the term is linear and not a fixture artefact):
 *
 *   listings alone ................... 2x corpus
 *   + evaluation_tasks ............... 3x
 *   + price_observations ............. 4x
 *   + model_stats .................... 5x   <-- production's shape
 *
 * So budget 5 x corpus per page load. `LIMIT 51` BOUNDS THE RESPONSE AND NOT `rows_read`;
 * saying otherwise would be a claim wider than the measurement.
 *
 * NO INDEX FIXES THIS, and the reason is structural rather than a missing index: the leading
 * term of the ORDER BY is a CASE over a JOINED table's column, which no index on `listings` can
 * serve. Four variants were measured on a 2,000-row corpus -- an index on
 * `listings(last_seen_at)`, one on `evaluation_tasks(verdict)`, both together, and
 * `last_seen_at` clustered into heartbeat buckets -- and every one left `rows_read` unchanged
 * with a byte-identical plan. THE LEVER IS A DENORMALISED VERDICT COLUMN ON `listings`, which
 * is a migration AND a second writer, not an index.
 *
 * THE TRIGGER, as a share, the way `runMonitor.ts` phrases its own: revisit when this
 * endpoint's share approaches the 20% of the daily read allowance `runCleanup` already reserves
 * -- i.e. when `corpus x loads-per-day x 5` approaches 1,000,000. At the design's stated ~8,300
 * listing ceiling that is ~24 page loads/day; at 20 loads/day it is a corpus of 10,000. Both
 * readings of one inequality, and both measurable today.
 */
export const SELECT_VERDICTS = `SELECT l.source, l.listing_id, l.component_type, l.model_key,
       l.variant_key, l.title, l.price_cents, l.location_text, l.url, l.last_seen_at,
       t.verdict AS verdict,
       CASE WHEN p.listing_id IS NULL THEN s.count
            ELSE s.count - 1 END                               AS reference_count,
       CASE WHEN p.listing_id IS NULL THEN s.total_price_cents
            ELSE s.total_price_cents - p.price_cents END        AS reference_total_cents
  FROM listings l
  LEFT JOIN evaluation_tasks t
         ON t.source = l.source AND t.listing_id = l.listing_id
  LEFT JOIN price_observations p
         ON p.source = l.source AND p.listing_id = l.listing_id
  LEFT JOIN model_stats s
         ON s.market_key  = COALESCE(p.market_key,  l.market_key)
        AND s.model_key   = COALESCE(p.model_key,   l.model_key)
        AND s.variant_key = COALESCE(p.variant_key, l.variant_key)
 ORDER BY CASE WHEN t.verdict IS NULL      THEN 2
               WHEN t.verdict = 'DEAL'     THEN 0
               WHEN t.verdict = 'NOT_DEAL' THEN 3
               ELSE 1 END,
          l.last_seen_at DESC, l.listing_id
 LIMIT ?1`;

interface VerdictRow {
  source: string;
  listing_id: string;
  component_type: string;
  model_key: string | null;
  variant_key: string;
  title: string;
  price_cents: number | null;
  location_text: string | null;
  url: string;
  last_seen_at: number;
  verdict: string | null;
  reference_count: number | null;
  reference_total_cents: number | null;
}

export const statusFor = (verdict: string | null): WireStatus =>
  verdict === null
    ? "PENDING"
    : verdict === "DEAL"
      ? "DEAL"
      : verdict === "NOT_DEAL"
        ? "NOT_DEAL"
        : "NEEDS_REVIEW";

export const discountPercentFrom = (
  priceCents: number | null,
  averageCents: number | null,
): number | null =>
  priceCents === null || averageCents === null || averageCents <= 0
    ? null
    : ((averageCents - priceCents) / averageCents) * 100;

/**
 * THE SAME GATE `decide` APPLIES TO THE SAME TWO VALUES, and it is not defence in depth.
 * `dealRules.ts:190-198` refuses to judge on a `count` or `total` that is negative or not a safe
 * integer, and answers `invalid-reference-aggregate` rather than `insufficient-evidence`
 * precisely because "waiting repairs 4; waiting never repairs -1, a non-integer, or a negative
 * total". This path had no such gate: `referenceAverageCents` gates only on `count <= 0`
 * (dealRules.ts:124-128) and the presentation gate below tests only
 * `count >= MINIMUM_REFERENCE_COUNT`, which BOTH `6` and the non-integer `5.5` pass. So
 * `reference_count: 6, reference_total_cents: -600000` served `averagePriceCents: -100000` and
 * the card rendered "Market average  -$1,000.00".
 *
 * REACHABILITY IS BETTER THAN "SOMEONE WROTE A CORRUPT ROW", AND MEASURED: two of the three
 * corrupt states are manufactured BY THE EXCLUSION ARITHMETIC IN THE STATEMENT ABOVE out of
 * rows that satisfy every `CHECK` on `model_stats` (`count >= 0`, `total_price_cents >= 0`,
 * `count > 0 OR total_price_cents = 0`). `s.total_price_cents - p.price_cents` goes negative as
 * soon as the observation and the aggregate drift apart -- the divergence 3C's own doc keeps a
 * drift-detection section for -- and `s.count - 1` goes negative on a perfectly legal `(0, 0)`
 * aggregate. The third needs no drift at all: `count` is INTEGER *affinity*, so `5.5` passes
 * `count >= 0`, reads back as `5.5`, and then passes `>= MINIMUM_REFERENCE_COUNT`. All three are
 * pinned by V-22.
 *
 * IT WARNS RATHER THAN ONLY WITHHOLDING. Withholding in silence is indistinguishable from thin
 * evidence on the wire and on the page, which is the exact miscoding `decide`'s two separate
 * reasons exist to prevent -- it "sends an operator looking for more observations when
 * observations were never the problem".
 */
const corruptAggregate = (value: number | null): boolean =>
  value !== null && (!Number.isSafeInteger(value) || value < 0);

const catalogComponent = (value: string): ComponentType | null =>
  Object.hasOwn(CATALOG_COMPONENT_ID, value)
    ? CATALOG_COMPONENT_ID[value as keyof typeof CATALOG_COMPONENT_ID]
    : null;

export const toWireListing = (row: VerdictRow): WireListing | null => {
  const componentType = catalogComponent(row.component_type);
  if (componentType === null) {
    console.warn(`verdicts: unknown component_type ${JSON.stringify(row.component_type)}`);
    return null;
  }

  const count = row.reference_count;
  const total = row.reference_total_cents;
  let averageCents: number | null = null;
  if (corruptAggregate(count) || corruptAggregate(total)) {
    console.warn(
      `verdicts: listing ${row.listing_id} has a corrupt reference aggregate ` +
        `(count ${String(count)}, total ${String(total)}); withholding the market average`,
    );
  } else if (count !== null && count >= MINIMUM_REFERENCE_COUNT) {
    averageCents = referenceAverageCents(total, count);
  }
  const discountPercent = discountPercentFrom(row.price_cents, averageCents);

  return {
    source: row.source,
    listingId: row.listing_id,
    componentType,
    modelKey: row.model_key,
    variantKey: row.variant_key === "" ? null : row.variant_key,
    title: row.title,
    priceCents: row.price_cents,
    location: row.location_text,
    url: row.url,
    observedAt: new Date(row.last_seen_at * 1000).toISOString(),
    evaluation: {
      status: statusFor(row.verdict),
      ...(averageCents === null ? {} : { averagePriceCents: averageCents }),
      ...(discountPercent === null ? {} : { discountPercent }),
    },
  };
};

export const handleGetVerdicts = async (db: D1Database): Promise<VerdictsResult> => {
  // THE try COVERS THE DATABASE CALL AND NOTHING ELSE. With the mapping inside it, a mapper
  // throw was reported as a storage failure -- the wrong subsystem, and the reason the
  // RangeError above was a 503 rather than one missing card.
  let rows: VerdictRow[];
  try {
    const read = await db
      .prepare(SELECT_VERDICTS)
      .bind(VERDICT_PAGE_SIZE + 1)
      .all<VerdictRow>();
    rows = read.results;
  } catch {
    return { ok: false, status: 503, code: "VERDICTS_STORAGE_FAILED" };
  }

  // MAP AND DROP FIRST, BOUND SECOND. Dropping after the slice let a page of 49 report
  // `truncated: false`, which is the silent claim `truncated` exists to prevent.
  //
  // THE PER-ROW try IS THE MECHANISM, NOT A BACKSTOP, and it is why there is no explicit
  // `Number.isFinite` check on `last_seen_at`. `last_seen_at` is INTEGER *affinity*, so a
  // hand-written `wrangler d1 execute` -- the writer this route's unknown-verdict rule already
  // assumes -- can store 'not-a-time' or 1e18, and `toISOString()` throws RangeError on both.
  // MEASURED: an explicit guard for exactly that case had NO killing mutation, because this
  // catch already produces the same outcome (one card lost, page intact, one warning naming the
  // listing). A line no mutation can kill is the dead code worker/storage/marketKey.ts:25-29
  // removed for the same reason. The shape is `evaluateBatch`'s per-task try: "a `decide` that
  // throws for one candidate must not abort the other fourteen".
  const served: WireListing[] = [];
  for (const row of rows) {
    try {
      const listing = toWireListing(row);
      if (listing !== null) served.push(listing);
    } catch (error) {
      console.warn(`verdicts: listing ${row.listing_id} could not be served: ${String(error)}`);
    }
  }

  // A TOTAL MAPPING FAILURE IS A FAILURE, NOT AN EMPTY PAGE. The rule, and the measured
  // defect behind it, are worker/api/listings.ts:421-438 on the write path: an outage that
  // reads clean at every layer an operator can see. An empty page is also the one state the
  // orchestrator's show-everything ruling exists to prevent.
  //
  // `rows.length > 0 &&` IS LOAD-BEARING AND IS THE WHOLE GUARD ON THE COMMONEST STATE THERE
  // IS. Without it an EMPTY DATABASE answers 503 -- and an empty database is what every fresh
  // deployment holds until the first collection run lands. MEASURED: deleting that conjunct
  // turns V-17 red and nothing else, so V-17 is the only test standing between "nothing
  // collected yet" and "the service is broken". Do not delete V-17 as a decorative control.
  if (rows.length > 0 && served.length === 0) {
    return { ok: false, status: 503, code: "VERDICTS_ROWS_UNUSABLE" };
  }

  return {
    ok: true,
    status: 200,
    body: {
      listings: served.slice(0, VERDICT_PAGE_SIZE),
      // "YOU ARE NOT SEEING EVERYTHING", not "the statement hit its bound". Either cause
      // makes the page partial, so either cause sets the flag; `console.warn` above is what
      // tells an operator which.
      truncated: served.length > VERDICT_PAGE_SIZE || served.length < rows.length,
    },
  };
};
