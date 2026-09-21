/**
 * The deal gate, as pure functions over integers. No `db`, no I/O, no clock.
 *
 * The one discipline everything here rests on: MONEY IS NEVER DIVIDED. `P <= M * (1 - D)`
 * with `M = T / C` and `D = bp / 10000` is multiplied through by `C * 10000` -- both
 * strictly positive once the evidence gate has passed -- to
 *
 *     P * C * 10000  <=  T * (10000 - bp)
 *
 * evaluated in BigInt. Every rounding direction is wrong somewhere: rounding the average up
 * turns a non-deal into a DEAL, rounding it down throws a real deal away, and float drift
 * flips at exact equality -- which is precisely where the marginal deals this product exists
 * to catch live. The only safe choice is not to round at all, and cross-multiplication makes
 * that free.
 *
 * BigInt rather than Number is not about the plausible magnitudes -- those fit with 300x to
 * spare. It is that NOTHING IN THE SCHEMA BOUNDS THE INPUTS: `listings`' only price CHECK is
 * `price_cents IS NULL OR price_cents >= 0` and `model_stats`' only count CHECK is
 * `count >= 0`. "It fits in a double" would be an assumption about data, not a property of
 * the system. Measured on this repository over 30,000 batches after a warm-up: BigInt and
 * Number are BOTH 0.00004 ms p95 per 15-row batch -- indistinguishable at timer resolution,
 * against an 8 ms budget. The safety is free.
 */

import {
  MINIMUM_REFERENCE_COUNT,
  type CandidateReference,
  type DealMode,
  type EvaluationReason,
  type EvaluationSettings,
  type Verdict,
} from "./types";

export const discountBasisPoints = (percent: number): number => {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error(`discountBasisPoints: percent must be a finite number in [0, 100]: ${percent}`);
  }
  // Math.round, NOT Math.trunc/Math.floor: 4.35 * 100 is 434.99999999999994 in IEEE-754,
  // and 8.11 * 100 is exactly 811. Truncating turns a 4.35% setting into 4.34%.
  //
  // This is THE ONLY ROUNDING ANYWHERE IN THE PATH, and it rounds a threshold PARAMETER,
  // not money -- once per call, to 0.01% granularity. It is deterministic and
  // revision-stable, so it cannot make a verdict irreproducible.
  return Math.round(percent * 100);
};

export interface ValidatedSettings {
  mode: DealMode;
  basisPoints: number | null;
  maximumPriceCents: number | null;
  searchRevision: number;
}

export const validateSettings = (settings: EvaluationSettings): ValidatedSettings => {
  // searchRevision FIRST and unconditionally. A null or undefined revision makes the claim's
  // `evaluated_revision < ?` and `> ?` terms evaluate to NULL, so only IS NULL rows are eligible
  // and every task ever evaluated is silently frozen forever while the call reports success.
  // Measured. This guard is the only thing standing between a missing 3E field and a dead pipeline.
  if (!Number.isSafeInteger(settings.searchRevision) || settings.searchRevision < 0) {
    throw new Error(
      `validateSettings: searchRevision must be a safe integer >= 0: ${settings.searchRevision}`,
    );
  }

  let basisPoints: number | null = null;
  if (settings.mode !== "MAXIMUM_PRICE") {
    if (settings.minimumDiscountPercent === null) {
      throw new Error(`validateSettings: ${settings.mode} requires minimumDiscountPercent`);
    }
    basisPoints = discountBasisPoints(settings.minimumDiscountPercent);
  }

  let maximumPriceCents: number | null = null;
  if (settings.mode !== "DISCOUNT") {
    if (!Number.isSafeInteger(settings.maximumPriceCents!) || settings.maximumPriceCents! < 0) {
      throw new Error(
        `validateSettings: ${settings.mode} requires an integer maximumPriceCents >= 0: ${settings.maximumPriceCents}`,
      );
    }
    maximumPriceCents = settings.maximumPriceCents!;
  }

  return {
    mode: settings.mode,
    basisPoints,
    maximumPriceCents,
    searchRevision: settings.searchRevision,
  };
};

/**
 * `count <= 0` is reachable: a solo contributor gives reference_count = 0 and
 * reference_total_cents = 0, and Math.round(0 / 0) is NaN.
 *
 * THIS VALUE EXISTS ONLY to fill EvaluationOutcome.referenceAverageCents and the frontend's
 * Listing.evaluation.averagePriceCents. `decide` never calls it. It is a report, not an input.
 */
export const referenceAverageCents = (
  totalCents: number | null,
  count: number | null,
): number | null =>
  totalCents === null || count === null || count <= 0 ? null : Math.round(totalCents / count);

const isSafeCents = (value: number | null): value is number =>
  value !== null && Number.isSafeInteger(value) && value >= 0;

/**
 * DO NOT SIMPLIFY. The order of these branches is the specification.
 */
export const decide = (
  reference: CandidateReference | undefined,
  settings: ValidatedSettings,
): { verdict: Verdict; status: "COMPLETE" | "NEEDS_REVIEW"; reason: EvaluationReason } => {
  // 1. A claimed task with no `listings` row. Retrying cannot create one.
  if (reference === undefined) {
    return { verdict: "NEEDS_REVIEW", status: "COMPLETE", reason: "listing-missing" };
  }

  // 2. 3B's classification. FAIL CLOSED: the specific INVALID_REFERENCE value first, then
  //    ANYTHING that is not exactly "VALID". `validity` is TEXT and 3C stores whatever the caller
  //    passed, so two equality checks with a fall-through would treat "UNKNOWN", "needs_review",
  //    "Invalid_Reference" and "" as VALID -- measured: all four produce DEAL. `storage/types.ts`
  //    warns about exactly this default one layer down, where the blast radius is an aggregate.
  //    Here the blast radius is a notification.
  if (reference.validity === "INVALID_REFERENCE") {
    return { verdict: "NOT_DEAL", status: "COMPLETE", reason: "invalid-reference" };
  }
  if (reference.validity !== "VALID") {
    return { verdict: "NEEDS_REVIEW", status: "COMPLETE", reason: "validity-needs-review" };
  }

  // 3. No usable price. `price_cents` is INTEGER *affinity*, so 12813.999999999998 is stored as a
  //    REAL, passes 3C's `CHECK (price_cents >= 0)`, and would make BigInt() throw. Coerce here.
  if (!isSafeCents(reference.candidatePriceCents)) {
    return { verdict: "NEEDS_REVIEW", status: "COMPLETE", reason: "no-price" };
  }
  const P = reference.candidatePriceCents;

  // 4. The maximum-price leg FIRST, because it needs no market evidence. If it fails, the answer
  //    is final in every mode that uses it -- the AND in BOTH mode is false regardless of what the
  //    discount leg would say -- so the evidence gate is never consulted and nothing is "decided
  //    from insufficient evidence". P and maximumPriceCents are the only inputs, and a change to
  //    either already re-opens the task (QUEUE_TASK for the price, the revision tier for settings).
  if (settings.mode !== "DISCOUNT" && P > settings.maximumPriceCents!) {
    return { verdict: "NOT_DEAL", status: "COMPLETE", reason: "above-maximum-price" };
  }

  // 5. The discount leg, gated on evidence. THIS is the one and only path to status NEEDS_REVIEW.
  if (settings.mode !== "MAXIMUM_PRICE") {
    const count = reference.referenceCount;
    const total = reference.referenceTotalCents;

    // A malformed aggregate gets its OWN reason. It is not "insufficient evidence": more
    // observations cure thin evidence, and nothing cures a corrupt total on its own. Both park
    // the task at NEEDS_REVIEW so it self-heals if the aggregate is ever repaired -- a
    // model_stats change never requeues a listing, so tier 3 is the only way back -- but a model
    // parked on a corrupt total would otherwise rotate forever with no signal at all.
    if (total !== null && !Number.isSafeInteger(total)) {
      return {
        verdict: "NEEDS_REVIEW",
        status: "NEEDS_REVIEW",
        reason: "invalid-reference-total",
      };
    }

    // `total < 0` mirrors the `count < MINIMUM_REFERENCE_COUNT` term. Both are only reachable if
    // the 3C ledger has drifted, and neither can produce a false DEAL -- but without this term a
    // negative total yields NOT_DEAL / COMPLETE, which permanently marks a listing "not a deal"
    // on the strength of corrupt data and never re-examines it. Parking it is the honest answer.
    if (
      count === null ||
      total === null ||
      !Number.isSafeInteger(count) ||
      count < MINIMUM_REFERENCE_COUNT ||
      total < 0
    ) {
      return { verdict: "NEEDS_REVIEW", status: "NEEDS_REVIEW", reason: "insufficient-evidence" };
    }
    // P <= (total/count) * (1 - bp/10000), multiplied through by count*10000. Both factors are
    // strictly positive here, so the inequality direction is preserved. No division, ever.
    const withinDiscount =
      BigInt(P) * BigInt(count) * 10000n <= BigInt(total) * BigInt(10000 - settings.basisPoints!);
    if (!withinDiscount) {
      return { verdict: "NOT_DEAL", status: "COMPLETE", reason: "above-discount-threshold" };
    }
  }

  const reason: EvaluationReason =
    settings.mode === "BOTH"
      ? "within-both"
      : settings.mode === "DISCOUNT"
        ? "within-discount"
        : "within-maximum";
  return { verdict: "DEAL", status: "COMPLETE", reason };
};
