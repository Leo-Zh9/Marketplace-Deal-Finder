/**
 * The evaluation batch: claim durable tasks, read each candidate's benchmark with the
 * candidate already excluded from it, decide, and commit each verdict behind a fence.
 *
 * Style follows worker/storage/: SQL as module constants, plain functions taking `db` first,
 * injected seams, and statement builders exported so tests re-issue the BYTE-IDENTICAL
 * statement rather than a hand-copy that would not carry a mutation.
 *
 * Round trips: 4 claims + 1 read + 1 write batch = 6, all O(batchSize) in rows read and
 * independent of corpus size, market size and history depth.
 */

import { decide, referenceAverageCents, validateSettings } from "./dealRules";
import {
  EVALUATION_BATCH_SIZE,
  EVALUATION_LEASE_SECONDS,
  MAX_EVALUATION_BATCH_SIZE,
  type CandidateReference,
  type DiscardedEvaluation,
  type EvaluationOutcome,
  type EvaluationReason,
  type EvaluationReport,
  type EvaluationSettings,
  type Verdict,
} from "./types";
import type { D1Usage } from "../storage/types";

/**
 * THE FOUR CLAIM TIERS. DO NOT SIMPLIFY into a single statement with a CASE in the ORDER BY.
 *
 * That form was built and measured. It works, and it costs rows_read ~ 2 * |eligible| because
 * an ORDER BY cannot ride a MULTI-INDEX OR: EXPLAIN reports USE TEMP B-TREE FOR ORDER BY, so
 * the ENTIRE eligible set is materialised and sorted to pick 15. Immediately after a revision
 * bump -- the spec's required mechanism and this design's own recovery path -- every task is
 * eligible, and draining a 20,000-task backlog costs ~53,000,000 rows read. The tiered form
 * costs ~132,000 (measured: 99 rows per claim, flat at 200 / 5,000 / 20,000 eligible).
 *
 * The tiers are STATUS-DISJOINT, so the split costs nothing in correctness: no row is claimable
 * by two tiers and no eligible row is unreachable (verified exhaustively over all 48
 * combinations of 4 statuses x evaluated_revision in {NULL, below, equal, above} x lease in
 * {expired, exactly now, future}).
 */

/** Tier 1 -- fresh work. ?1 source, ?2 limit, ?3 lease_expires_at, ?4 lease_token */
export const CLAIM_PENDING = `UPDATE evaluation_tasks SET status='PROCESSING', lease_expires_at=?3, lease_token=?4
 WHERE rowid IN (SELECT rowid FROM evaluation_tasks
                  WHERE source=?1 AND status='PENDING'
                  ORDER BY created_at, listing_id LIMIT ?2)
RETURNING listing_id`;

/** Tier 2 -- abandoned work whose lease expired. ?5 now */
export const CLAIM_EXPIRED = `UPDATE evaluation_tasks SET status='PROCESSING', lease_expires_at=?3, lease_token=?4
 WHERE rowid IN (SELECT rowid FROM evaluation_tasks
                  WHERE source=?1 AND status='PROCESSING' AND lease_expires_at <= ?5
                  ORDER BY created_at, listing_id LIMIT ?2)
RETURNING listing_id`;

/**
 * Tier 4 -- evaluated under a different revision. ?5 current searchRevision. RUNS THIRD.
 *
 * Three range terms, NOT `evaluated_revision IS NOT ?5`. They select a provably identical set
 * (verified by set equality), but `IS NOT` is not indexable: measured 8,042 rows read versus 43.
 * `IS NULL` is a separate term because `NULL < ?` and `NULL > ?` are NULL, not true -- and the
 * IS NULL rows are exactly the tasks a database that already ran 3C holds.
 * `>` is not redundant with `<`: revisions are monotone in normal operation, but a restore from
 * backup lowers the current revision and `>` is what re-opens those tasks.
 *
 * `source=?1` IS REPEATED INSIDE EVERY OR TERM AND MUST STAY THERE. Factored out as
 * `WHERE source=?1 AND (... OR ... OR ...)`, SQLite abandons the MULTI-INDEX OR and falls back
 * to the primary-key autoindex: 8,041 rows read for a 15-row claim, versus 43 (measured on two
 * independently built fixtures; without the 3D index the same query reads 48,146).
 *
 * No ORDER BY: there is no fairness ordering among "re-check under new settings", and adding one
 * reintroduces the TEMP B-TREE. Tests assert count and set membership, never order.
 */
export const CLAIM_STALE_REVISION = `UPDATE evaluation_tasks SET status='PROCESSING', lease_expires_at=?3, lease_token=?4
 WHERE rowid IN (SELECT rowid FROM evaluation_tasks
                  WHERE (source=?1 AND status='COMPLETE' AND evaluated_revision IS NULL)
                     OR (source=?1 AND status='COMPLETE' AND evaluated_revision < ?5)
                     OR (source=?1 AND status='COMPLETE' AND evaluated_revision > ?5)
                  LIMIT ?2)
RETURNING listing_id`;

/**
 * Tier 3 -- waiting for market evidence. RUNS LAST. Unconditionally eligible: nothing requeues a
 * task when the MARKET changes, so re-checking is the only way `reference_count` can reach 5.
 *
 * ORDER BY evaluated_at, NOT created_at. Nothing ever advances created_at for a task that stays
 * in this queue -- COMPLETE_TASK does not write it, and QUEUE_TASK fires only on NEW or a
 * contribution change -- so ordering by it makes the claim a FIXED POINT on the same 15 rows,
 * forever, while every other NEEDS_REVIEW task is never re-examined (measured over five calls).
 * evaluated_at is rewritten by every completion, so the row that was just examined goes to the
 * back. A NULL evaluated_at (not reachable today: every NEEDS_REVIEW row got there via a
 * completion) sorts first, which is the safe direction.
 */
export const CLAIM_NEEDS_REVIEW = `UPDATE evaluation_tasks SET status='PROCESSING', lease_expires_at=?3, lease_token=?4
 WHERE rowid IN (SELECT rowid FROM evaluation_tasks
                  WHERE source=?1 AND status='NEEDS_REVIEW'
                  ORDER BY evaluated_at, listing_id LIMIT ?2)
RETURNING listing_id`;

/**
 * The candidate read: one statement for the whole batch. ?1 = source, then one placeholder
 * per claimed id.
 *
 * Let C = s.count, T = s.total_price_cents, q = p.price_cents:
 *
 *   observation present : reference_count = C - 1   reference_total = T - q
 *   observation absent  : reference_count = C       reference_total = T
 *   aggregate row absent: reference_count = NULL    reference_total = NULL   (LEFT JOIN)
 *
 * The EXISTENCE OF A price_observations ROW is the ledger entry for "this listing's price_cents
 * is currently inside that model_stats row". `p.listing_id IS NULL` is the inclusion test and
 * `p.price_cents` is the amount -- the same row, the same join, one statement, so "is it
 * included" and "how much is it worth" cannot disagree. Reconstructing the rule from the listing
 * row (`validity='VALID' AND model_key IS NOT NULL AND price_cents IS NOT NULL`) looks right and
 * is wrong for every cleaned observation: cleanupStaleObservations leaves the listing row intact
 * with its price, so that form would subtract a price that is no longer in the aggregate.
 *
 * candidate_price_cents comes from `listings`; the subtraction uses `price_observations`. Each
 * column for its own role: l.price_cents is the asking price being judged and is the only one
 * that exists for a non-contributor; p.price_cents is the amount that is inside the aggregate
 * and the only one that may be subtracted.
 *
 * The COALESCE on the join keys is DEFENSIVE, not a live case: recordSightings writes UPSERT_OBS
 * and UPSERT_LISTING in one batch from the same values. It exists so the observation wins when
 * it exists (it names the row the price actually went into) and the listing's own keys name the
 * right aggregate when it does not. Caveat: if a market MOVE ever did produce divergence,
 * COALESCE would pick the aggregate of the market the candidate has left. Nothing today can
 * produce it; a future multi-market write path must re-check this.
 */
export const candidateReadSql = (idCount: number): string => {
  const placeholders = Array.from({ length: idCount }, (_, index) => `?${index + 2}`).join(", ");
  return `SELECT l.listing_id,
       l.price_cents AS candidate_price_cents,
       l.validity    AS validity,
       CASE WHEN p.listing_id IS NULL THEN s.count
            ELSE s.count - 1 END                                AS reference_count,
       CASE WHEN p.listing_id IS NULL THEN s.total_price_cents
            ELSE s.total_price_cents - p.price_cents END        AS reference_total_cents
  FROM listings l
  LEFT JOIN price_observations p
         ON p.source = l.source AND p.listing_id = l.listing_id
  LEFT JOIN model_stats s
         ON s.market_key  = COALESCE(p.market_key,  l.market_key)
        AND s.model_key   = COALESCE(p.model_key,   l.model_key)
        AND s.variant_key = COALESCE(p.variant_key, l.variant_key)
 WHERE l.source = ?1 AND l.listing_id IN (${placeholders})`;
};

/**
 * The completion, fenced on the claim's token.
 * ?1 source, ?2 listing_id, ?3 status, ?4 verdict, ?5 evaluated_revision, ?6 evaluated_at,
 * ?7 lease_token.
 *
 * evaluated_at=?6 is bound to the call's `now` on EVERY completion, including
 * insufficient-evidence ones. That write is tier 3's rotation key; without it the NEEDS_REVIEW
 * queue is a fixed point.
 *
 * The fence is `status='PROCESSING' AND lease_token=?7`. The lease VALUE cannot serve as the
 * token: claimant A claims at `now`, recordSightings requeues the row to PENDING (it never
 * touches lease_expires_at), claimant B claims it legally at the same `now` and writes the SAME
 * lease value -- A's stale completion then applies and B's fresh one is discarded, leaving a
 * COMPLETE row at the current revision carrying the stale verdict, ineligible under all four
 * tiers. Measured end to end. `created_at` closes the common case and still lets a task created
 * and requeued within the same second through. A fresh UUID per claim does not.
 */
export const COMPLETE_TASK = `UPDATE evaluation_tasks
   SET status=?3, verdict=?4, evaluated_revision=?5, evaluated_at=?6,
       lease_expires_at=0, lease_token=''
 WHERE source=?1 AND listing_id=?2 AND status='PROCESSING' AND lease_token=?7`;

export interface ClaimedTask {
  listingId: string;
}

interface ClaimedRow {
  listing_id: string;
}

interface CandidateRow {
  listing_id: string;
  candidate_price_cents: number | null;
  validity: string;
  reference_count: number | null;
  reference_total_cents: number | null;
}

/**
 * The four tiers, RUN IN THE ORDER 1, 2, 4, 3 -- finite work before infinite work.
 *
 * Tier 3 (NEEDS_REVIEW) is unbounded and perpetual: every row in it is eligible on every call,
 * forever, by design. Tier 4 (stale revision) is finite: each row is claimed once, stamped, and
 * stops being eligible. With tier 3 running third, tier 4 receives `batchSize - alreadyClaimed`,
 * which is ZERO whenever |NEEDS_REVIEW| >= batchSize -- measured with 40 NEEDS_REVIEW and 30
 * stale COMPLETE, the stale set was never claimed at all over five calls and the state was
 * stationary. That breaks "search revisions trigger reevaluation" AND the documented recovery
 * path for bad arithmetic, which would silently do nothing.
 *
 * THE LOOP BREAKS ONLY WHEN THE BATCH IS FULL. It must never break because a tier returned zero
 * rows: in the ordinary steady state nothing is PENDING, so `if (tier1.length === 0) return`
 * would disable expired-lease recovery, evidence re-checks and revision bumps all at once.
 *
 * RETURNING order is rowid order, not ORDER BY order (measured). The ORDER BY chooses WHICH rows;
 * nothing downstream may depend on the returned order.
 */
export const claimEvaluationTasks = async (
  db: D1Database,
  input: {
    source: string;
    batchSize: number;
    now: number;
    leaseSeconds: number;
    leaseToken: string;
    searchRevision: number;
  },
): Promise<{ tasks: ClaimedTask[]; usage: D1Usage }> => {
  const { source, now, leaseToken, searchRevision } = input;
  const leaseExpiresAt = now + input.leaseSeconds;
  const usage: D1Usage = { rowsRead: 0, rowsWritten: 0 };
  const tasks: ClaimedTask[] = [];

  const tiers: Array<(limit: number) => D1PreparedStatement> = [
    (limit) => db.prepare(CLAIM_PENDING).bind(source, limit, leaseExpiresAt, leaseToken),
    (limit) => db.prepare(CLAIM_EXPIRED).bind(source, limit, leaseExpiresAt, leaseToken, now),
    (limit) =>
      db.prepare(CLAIM_STALE_REVISION).bind(source, limit, leaseExpiresAt, leaseToken, searchRevision),
    (limit) => db.prepare(CLAIM_NEEDS_REVIEW).bind(source, limit, leaseExpiresAt, leaseToken),
  ];

  for (const tier of tiers) {
    const limit = input.batchSize - tasks.length;
    if (limit <= 0) {
      break;
    }
    const claimed = await tier(limit).all<ClaimedRow>();
    usage.rowsRead += claimed.meta.rows_read;
    usage.rowsWritten += claimed.meta.rows_written;
    for (const row of claimed.results) {
      tasks.push({ listingId: row.listing_id });
    }
  }

  return { tasks, usage };
};

/**
 * One completion statement. Exported so tests can re-issue the BYTE-IDENTICAL statement rather
 * than a hand-copied lookalike, which would not carry a mutation applied here.
 */
export const completionStatement = (
  db: D1Database,
  args: {
    source: string;
    listingId: string;
    status: "COMPLETE" | "NEEDS_REVIEW";
    verdict: Verdict;
    searchRevision: number;
    now: number;
    leaseToken: string;
  },
): D1PreparedStatement =>
  db
    .prepare(COMPLETE_TASK)
    .bind(
      args.source,
      args.listingId,
      args.status,
      args.verdict,
      args.searchRevision,
      args.now,
      args.leaseToken,
    );

export const evaluateBatch = async (
  db: D1Database,
  input: {
    source: string;
    settings: EvaluationSettings;
    now: number;
    batchSize?: number;
    leaseSeconds?: number;
    leaseToken?: string;
  },
): Promise<EvaluationReport> => {
  const { source, now } = input;

  // ALL FOUR CALL PARAMETERS ARE VALIDATED BEFORE THE CLAIM, so a bad input throws without
  // stranding anything in PROCESSING.
  const settings = validateSettings(input.settings);

  const batchSize = input.batchSize ?? EVALUATION_BATCH_SIZE;
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_EVALUATION_BATCH_SIZE
  ) {
    throw new Error(
      `evaluateBatch: batchSize must be a safe integer in [1, ${MAX_EVALUATION_BATCH_SIZE}]: ${batchSize}`,
    );
  }

  // leaseSeconds >= 1, not >= 0. At 0 the lease is exactly `now`, so tier 2's
  // `lease_expires_at <= ?5` matches the rows tier 1 just claimed INSIDE THE SAME CALL:
  // measured, 3 PENDING tasks produced 6 claim entries with 3 duplicate ids, a duplicated id
  // in the read's IN list, two completions for one task with one landing in `discarded`, and
  // `claimed` at twice the truth.
  const leaseSeconds = input.leaseSeconds ?? EVALUATION_LEASE_SECONDS;
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new Error(`evaluateBatch: leaseSeconds must be a safe integer >= 1: ${leaseSeconds}`);
  }

  // One token per call, shared by every row the call claims, and an injected seam so tests are
  // deterministic -- exactly as heartbeatSeconds is in recordSightings.
  //
  // The emptiness check is not defensive clutter: `input.leaseToken ?? crypto.randomUUID()`
  // passes '' through, '' is the column's DEFAULT, and a completion carrying '' against a
  // PROCESSING row whose token is still '' measures changes = 1 -- the fence silently off.
  const leaseToken = input.leaseToken ?? crypto.randomUUID();
  if (typeof leaseToken !== "string" || leaseToken.length === 0) {
    throw new Error("evaluateBatch: leaseToken must be a non-empty string");
  }

  const usage: D1Usage = { rowsRead: 0, rowsWritten: 0 };

  const claim = await claimEvaluationTasks(db, {
    source,
    batchSize,
    now,
    leaseSeconds,
    leaseToken,
    searchRevision: settings.searchRevision,
  });
  usage.rowsRead += claim.usage.rowsRead;
  usage.rowsWritten += claim.usage.rowsWritten;

  if (claim.tasks.length === 0) {
    return { outcomes: [], discarded: [], claimed: 0, usage };
  }

  const ids = claim.tasks.map((task) => task.listingId);
  const read = await db
    .prepare(candidateReadSql(ids.length))
    .bind(source, ...ids)
    .all<CandidateRow>();
  usage.rowsRead += read.meta.rows_read;
  usage.rowsWritten += read.meta.rows_written;

  const references = new Map<string, CandidateReference>();
  for (const row of read.results) {
    references.set(row.listing_id, {
      candidatePriceCents: row.candidate_price_cents,
      validity: row.validity,
      referenceCount: row.reference_count,
      referenceTotalCents: row.reference_total_cents,
    });
  }

  const pending: EvaluationOutcome[] = [];
  const statements: D1PreparedStatement[] = [];

  // ITERATE THE CLAIMED SET, NOT THE READ SET, with a per-task try/catch. Two things depend on
  // it: a claimed task whose `listings` row is absent produces no read row, and iterating the
  // read set would silently never complete it, leaving it PROCESSING to be re-claimed at tier 2
  // forever; and a `decide` that throws for one candidate must not abort the other fourteen.
  // Every claimed task therefore gets exactly one completion statement, and every failure mode
  // is terminal, so nothing loops.
  for (const task of claim.tasks) {
    const reference = references.get(task.listingId);

    let decision: {
      verdict: Verdict;
      status: "COMPLETE" | "NEEDS_REVIEW";
      reason: EvaluationReason;
    };
    try {
      decision = decide(reference, settings);
    } catch {
      // `evaluation-error`, NOT `no-price`. A bug in `decide` must not surface as fifteen
      // priced listings claiming to have no price, with the only diagnostic the report offers
      // pointing away from the fault.
      decision = { verdict: "NEEDS_REVIEW", status: "COMPLETE", reason: "evaluation-error" };
    }

    const referenceCount = reference?.referenceCount ?? null;
    const referenceTotalCents = reference?.referenceTotalCents ?? null;

    pending.push({
      source,
      listingId: task.listingId,
      verdict: decision.verdict,
      reason: decision.reason,
      status: decision.status,
      candidatePriceCents: reference?.candidatePriceCents ?? null,
      referenceCount,
      referenceTotalCents,
      referenceAverageCents: referenceAverageCents(referenceTotalCents, referenceCount),
    });

    statements.push(
      completionStatement(db, {
        source,
        listingId: task.listingId,
        status: decision.status,
        verdict: decision.verdict,
        searchRevision: settings.searchRevision,
        now,
        leaseToken,
      }),
    );
  }

  // All of a batch's completions in one db.batch -- one round trip, up to batchSize statements.
  const applied = await db.batch(statements);
  const outcomes: EvaluationOutcome[] = [];
  const discarded: DiscardedEvaluation[] = [];

  applied.forEach((result, index) => {
    usage.rowsRead += result.meta.rows_read;
    usage.rowsWritten += result.meta.rows_written;
    const outcome = pending[index];
    // changes === 1 committed; 0 means the fence rejected it -- the task changed under us and
    // this verdict was computed from state that no longer holds. DISCARDED, NOT APPLIED.
    if (result.meta.changes === 1) {
      outcomes.push(outcome);
    } else {
      discarded.push({
        source: outcome.source,
        listingId: outcome.listingId,
        verdict: outcome.verdict,
        reason: outcome.reason,
      });
    }
  });

  return { outcomes, discarded, claimed: claim.tasks.length, usage };
};
