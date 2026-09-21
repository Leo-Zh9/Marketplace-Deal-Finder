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
   * The aggregate itself is malformed: a `total_price_cents` that is not a safe integer. Its own
   * reason, not `insufficient-evidence`, because the two need different responses -- more
   * observations fix thin evidence, and nothing fixes a corrupt total on its own. Every candidate
   * in that model parks at NEEDS_REVIEW and rotates in tier 3 until the aggregate is repaired, so
   * this reason is the only signal that a model is stuck rather than merely young.
   */
  | "invalid-reference-total"
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
