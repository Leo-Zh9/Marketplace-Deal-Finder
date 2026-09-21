/**
 * The contracts the Phase 3C storage layer consumes. Nothing here is source-specific:
 * `source` and `validity` are opaque values the caller supplies, and storage never
 * enumerates or branches on them.
 */

/** The normalized listing contract (PHASE_3 section 3B, lines 163-199). */
export interface Listing {
  listingId: string;
  componentType:
    | "cpu"
    | "cpu_cooler"
    | "motherboard"
    | "ram"
    | "storage"
    | "gpu"
    | "psu"
    | "case"
    | "case_fan";
  modelKey: string | null;
  variantKey: string | null;
  title: string;
  priceCents: number | null;
  locationText: string | null;
  url: string;
  observedAt: string;
}

/**
 * 3B's classification of a price reference. 3C never computes this: it is supplied
 * by the caller alongside each listing, exactly like `source`. 3C owns only the rule
 * that non-VALID does not contribute. It is required and never defaulted -- a silent
 * default to VALID would let a 3B bug poison aggregates invisibly.
 */
export type ObservationValidity = "VALID" | "NEEDS_REVIEW" | "INVALID_REFERENCE";

export interface Sighting {
  listing: Listing;
  validity: ObservationValidity;
}

export type SightingOutcome = "NEW" | "CHANGED" | "UNCHANGED" | "FAILED";

export type ContributionOutcome =
  | "recorded"
  | "restored"
  | "removed"
  | "none"
  | "skipped-no-price"
  | "skipped-no-model"
  | "skipped-invalid";

/** Summed from D1's own `meta`, so "D1 usage is measurable" is a read, not a research project. */
export interface D1Usage {
  rowsRead: number;
  rowsWritten: number;
}

export interface SightingResult {
  listingId: string;
  outcome: SightingOutcome;
  contribution: ContributionOutcome;
  error?: string;
}

export interface SightingReport {
  results: SightingResult[];
  usage: D1Usage;
}

export interface CleanupReport {
  groups: number;
  observationsDeleted: number;
  aggregatesPruned: number;
  batches: number;
  remaining: boolean;
  usage: D1Usage;
}

/** 3E wires this binding in; 3C only names it. */
export interface StorageEnvironment {
  DB: D1Database;
}

export const STALE_AFTER_SECONDS = 7 * 24 * 60 * 60;

/**
 * PLAN.md section 15's LISTING_HEARTBEAT_INTERVAL. An unchanged listing's last_seen_at
 * is refreshed only when the persisted value is at least this old: 12 rows/listing/day
 * instead of 144, which is the difference between a design that dies at ~700 tracked
 * listings and one that dies at ~8,300.
 */
export const HEARTBEAT_SECONDS = 6 * 60 * 60;
