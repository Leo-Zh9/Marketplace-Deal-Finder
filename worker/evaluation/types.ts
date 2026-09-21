/**
 * The contracts the Phase 3D evaluation layer consumes and produces.
 *
 * Settings are a PARAMETER of the evaluate call. 3D owns no settings table and creates
 * none: defining a search revision belongs to 3E, exactly as `source` and `validity`
 * belong to the caller in 3C. 3D only has to persist WHICH revision a task was last
 * evaluated under, which is a column on `evaluation_tasks`.
 */

import type { D1Usage } from "../storage/types";

export type DealMode = "DISCOUNT" | "MAXIMUM_PRICE" | "BOTH";
export type Verdict = "DEAL" | "NOT_DEAL" | "NEEDS_REVIEW";
export type TaskStatus = "PENDING" | "PROCESSING" | "COMPLETE" | "NEEDS_REVIEW";

export type EvaluationReason =
  | "within-discount"
  | "within-maximum"
  | "within-both"
  | "above-discount-threshold"
  | "above-maximum-price"
  | "insufficient-evidence"
  /**
   * The aggregate itself is corrupt, in whichever column it is corrupt: a `count` or a
   * `total_price_cents` that is not a safe integer, or that is below zero.
   *
   * NAMED FOR THE AGGREGATE, not for one column, and that is load-bearing. It covered only the
   * total for one review round while also being the answer for a corrupt count, which is exactly
   * the kind of identifier whose meaning drifts from its name and then outlives everyone who knew.
   *
   * NOT REACHABLE FROM 3C AS WRITTEN, and the comment says so on purpose. `recordSightings` gates
   * every contribution on `Number.isSafeInteger(priceCents)`, so a non-integer price reaches
   * `listings` but never `price_observations` or `model_stats` -- the canonical `19.99 * 100`
   * artifact is stored as a listing and simply never contributes. This is defence in depth against
   * the drift 3C's own doc anticipates between the observation ledger and the aggregate, not a
   * live hazard. The column's INTEGER affinity would permit it; the only writer does not.
   *
   * It is separate from `insufficient-evidence` because the two need different RESPONSES, and the
   * predicate they trip is not what separates them. `count = 4` and `count = -1` both fail
   * `count < MINIMUM_REFERENCE_COUNT`; waiting repairs the first and NEVER repairs the second.
   * Reporting them alike is precisely the misreading this reason exists to stop -- an operator
   * looking for more observations, when observations were never the problem. Every candidate in
   * that model parks at NEEDS_REVIEW and rotates in tier 3 until the aggregate is repaired.
   * Note the signal lives in the returned `EvaluationReport` only: 3D persists `verdict`, not
   * `reason`, so a stuck model is visible to the caller of the batch, not in `evaluation_tasks`.
   */
  | "invalid-reference-aggregate"
  | "no-price"
  | "validity-needs-review"
  | "invalid-reference"
  | "listing-missing"
  /** Used ONLY by evaluateBatch's per-task catch. Never returned by `decide`. */
  | "evaluation-error";

/** Settings are a PARAMETER of the call. 3D owns no settings table; 3E does. */
export interface EvaluationSettings {
  mode: DealMode;
  minimumDiscountPercent: number | null; // required for DISCOUNT and BOTH
  maximumPriceCents: number | null; // required for MAXIMUM_PRICE and BOTH
  searchRevision: number; // safe integer >= 0
}

/** Exactly one row of the candidate read. */
export interface CandidateReference {
  candidatePriceCents: number | null; // listings.price_cents -- the P being judged
  /**
   * TEXT from the database, NOT narrowed to ObservationValidity. The column is TEXT and
   * 3C stores whatever the caller passed; typing it as the union would let TypeScript
   * convince the reader that the three cases are exhaustive when at runtime they are not.
   * `decide` fails closed instead: anything that is not exactly "VALID" is not a deal.
   */
  validity: string;
  referenceCount: number | null; // aggregate ALREADY excluding the candidate
  referenceTotalCents: number | null;
}

export interface EvaluationOutcome {
  source: string;
  listingId: string;
  verdict: Verdict;
  reason: EvaluationReason;
  status: "COMPLETE" | "NEEDS_REVIEW";
  candidatePriceCents: number | null;
  referenceCount: number | null;
  referenceTotalCents: number | null;
  referenceAverageCents: number | null; // REPORT ONLY. Never an input to a verdict.
}

/** A verdict whose write the fence rejected: the task changed under us. DO NOT ACT ON THESE. */
export interface DiscardedEvaluation {
  source: string;
  listingId: string;
  verdict: Verdict;
  reason: EvaluationReason;
}

/**
 * `outcomes` and `discarded` are separate arrays, not one array with a `committed` flag,
 * so a caller cannot act on a rejected verdict by forgetting to filter.
 */
export interface EvaluationReport {
  outcomes: EvaluationOutcome[]; // committed; safe to act on
  discarded: DiscardedEvaluation[];
  claimed: number;
  usage: D1Usage;
}

export const EVALUATION_BATCH_SIZE = 15;
export const MINIMUM_REFERENCE_COUNT = 5;
export const EVALUATION_LEASE_SECONDS = 300;
/** D1 caps bound parameters at 100 per statement; the candidate read spends ?1 on `source`. */
export const MAX_EVALUATION_BATCH_SIZE = 98;
