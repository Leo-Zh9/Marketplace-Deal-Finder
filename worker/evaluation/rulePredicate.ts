/**
 * A USER'S DEAL RULE, IN SQL. One constant shared by the notify enqueue, the notify re-check and the
 * Preview sort, so "would this user be alerted" and "does this user's page put it first" are the same
 * text and cannot disagree.
 *
 * Shared evaluation, per-user rule (migrations/0009): the drain judges every listing once under the
 * frozen DISCOUNT evidence rule; each user's own rule is applied HERE, at read and notify time, to the
 * live aggregate. The aliases it needs: `l` listings, `u` users, `p` price_observations (LEFT JOIN),
 * `s` model_stats (LEFT JOIN on STATS_JOIN_KEYS).
 *
 * THE ONE PROPERTY: RULE_PREDICATE true IMPLIES decide(...) === DEAL, always -- never a false DEAL --
 * and the two are EQUAL inside the bounds below. rulePredicate.test.ts checks it over the plan's
 * cross product of validity, price, count, total, mode, basis points and maximum.
 *
 * WHY THE BOUNDS. `decide` multiplies in BigInt (dealRules.ts says why at length). SQLite integers are
 * 64-bit and an overflowing product silently becomes a REAL. Bounding P to 1e8 cents ($1M) and C to
 * 1e5 comparables keeps the LEFT side under 1e17 -- exact. The RIGHT side T * (10000 - bp) may still
 * overflow for a T near MAX_SAFE_INTEGER, but then its true value exceeds 9.2e18 > 1e17 >= LEFT, and
 * the REAL it becomes is just as far above LEFT, so the comparison keeps its exact answer. Outside the
 * bounds the predicate is FALSE: an alert is missed for a $1M part, never invented.
 *
 * DELIBERATELY NOT tier 3's `(p.listing_id IS NOT NULL OR l.price_cents = 0)`: that term decides which
 * parked tasks are worth RE-CLAIMING, not what a listing's evidence says.
 */

import { REFERENCE_COUNT_SQL, REFERENCE_TOTAL_SQL } from "./evaluateBatch";
import { MINIMUM_REFERENCE_COUNT } from "./types";

export const RULE_MAX_PRICE_CENTS = 100_000_000;
export const RULE_MAX_REFERENCE_COUNT = 100_000;

const P = "l.price_cents";
const C = `(${REFERENCE_COUNT_SQL})`;
const T = `(${REFERENCE_TOTAL_SQL})`;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * `decide`'s two evidence gates, as one complement: both aggregates safe integers (`typeof` is the SQL
 * side of `Number.isSafeInteger`; a REAL 6.5 is refused), the total >= 0 and the count >=
 * MINIMUM_REFERENCE_COUNT. The constant is interpolated, never written as a literal.
 */
export const EVIDENCE_GATE = `typeof(${C}) = 'integer' AND typeof(${T}) = 'integer'
       AND ${C} BETWEEN ${MINIMUM_REFERENCE_COUNT} AND ${MAX_SAFE}
       AND ${T} BETWEEN 0 AND ${MAX_SAFE}`;

/** A usable asking price, as `decide`'s isSafeCents, bounded for the product below. */
const PRICE_GATE = `typeof(${P}) = 'integer' AND ${P} BETWEEN 0 AND ${RULE_MAX_PRICE_CENTS}`;

export const RULE_PREDICATE = `(u.mode IS NOT NULL
   AND l.validity = 'VALID'
   AND ${PRICE_GATE}
   AND (u.mode = 'DISCOUNT' OR ${P} <= u.maximum_price_cents)
   AND (u.mode = 'MAXIMUM_PRICE'
        OR (${EVIDENCE_GATE}
            AND ${C} <= ${RULE_MAX_REFERENCE_COUNT}
            AND ${P} * ${C} * 10000 <= ${T} * (10000 - u.minimum_discount_bp))))`;

/**
 * `decide`'s NOT_DEAL, for the Preview SORT ONLY (bucket 3, last). Labels are computed by `decide`
 * itself in JS; this only orders rows. Equal to `decide` inside the bounds (rulePredicate.test.ts);
 * outside them a row may sort into the middle bucket, never be mislabelled.
 */
export const NOT_DEAL_PREDICATE = `(u.mode IS NOT NULL
   AND (l.validity = 'INVALID_REFERENCE'
        OR (l.validity = 'VALID'
            AND typeof(${P}) = 'integer' AND ${P} BETWEEN 0 AND ${MAX_SAFE}
            AND ((u.mode <> 'DISCOUNT' AND ${P} > u.maximum_price_cents)
                 OR ((u.mode = 'DISCOUNT' OR ${P} <= u.maximum_price_cents)
                     AND u.mode <> 'MAXIMUM_PRICE'
                     AND ${EVIDENCE_GATE}
                     AND ${P} * ${C} * 10000 > ${T} * (10000 - u.minimum_discount_bp))))))`;

/**
 * AREA MEMBERSHIP: the listing was seen in the area whose market key is bound at `param`. A NULL key
 * (a user with no area) matches nothing, which is the fail-closed answer for every caller.
 */
export const areaMembership = (param: string): string =>
  `EXISTS (SELECT 1 FROM listing_markets m
                WHERE m.market_key = ${param} AND m.source = l.source
                  AND m.listing_id = l.listing_id)`;
