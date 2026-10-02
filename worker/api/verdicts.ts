/**
 * GET /api/verdicts -- the evaluated listings the page shows: every stored listing with the
 * verdict 3D committed for it, the market average that verdict rested on, newest-first inside
 * a deal-first ordering, bounded.
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
  const averageCents =
    count !== null && count >= MINIMUM_REFERENCE_COUNT
      ? referenceAverageCents(row.reference_total_cents, count)
      : null;
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
