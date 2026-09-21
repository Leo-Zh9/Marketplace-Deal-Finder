/**
 * Daily stale cleanup. 3C implements the logic; 3E calls it -- there is no Cron trigger,
 * no Workflow and no scheduled() handler here.
 *
 * Stale means last_seen_at older than the window (7 days by default). Expired observations
 * are grouped by market/model/variant, their prices subtracted from the aggregate, and the
 * rows deleted -- the adjustment and the deletion atomic per bounded batch.
 */

import { STALE_AFTER_SECONDS, type CleanupReport, type D1Usage } from "./types";

const GROUPS = `SELECT market_key, model_key, variant_key
  FROM price_observations
 WHERE last_seen_at < ?1
 GROUP BY market_key, model_key, variant_key
 LIMIT ?2`;

/**
 * CLEAN_A and CLEAN_B are in the same transaction and carry the SAME predicate, so B deletes
 * exactly the rows A counted -- nothing can be re-observed between them, and a re-run matches
 * no rows and subtracts nothing. The amounts are computed by subqueries at execution time,
 * never carried from the JS read; the JS read only chooses WHICH GROUPS TO VISIT.
 */
const CLEAN_A = `UPDATE model_stats
   SET count = count - (SELECT COUNT(*) FROM price_observations p
                         WHERE p.market_key = ?1 AND p.model_key = ?2
                           AND p.variant_key = ?3 AND p.last_seen_at < ?4),
       total_price_cents = total_price_cents -
           (SELECT COALESCE(SUM(p.price_cents), 0) FROM price_observations p
             WHERE p.market_key = ?1 AND p.model_key = ?2
               AND p.variant_key = ?3 AND p.last_seen_at < ?4)
 WHERE market_key = ?1 AND model_key = ?2 AND variant_key = ?3`;

const CLEAN_B = `DELETE FROM price_observations
 WHERE market_key = ?1 AND model_key = ?2 AND variant_key = ?3 AND last_seen_at < ?4`;

/**
 * The orphan sweep. Not a per-group statement, and it runs even when nothing expired.
 *
 * Two kinds of row need it. First, the write path creates count = 0 orphans cleanup could
 * never otherwise reach: when the LAST contributing listing in a group leaves via a market
 * move, price -> null, model -> null or a validity flip, SUBTRACT_OLD drives that row to 0/0
 * and nothing deletes it. A per-group sweep cannot help, because GROUPS selects FROM
 * price_observations and that group no longer has any. Second -- and this is why the sweep is
 * load-bearing rather than tidy-up -- it is now the ONLY thing that removes a fully-expired
 * group's aggregate row, which in a system with a 7-day window is eventually every group.
 *
 * Leaving a 0/0 row is not cosmetic: 3D derives average = total_price_cents / count, and on a
 * count = 0 row SQLite returns NULL, so a null average would flow silently into pricing. And
 * the table would grow without bound: one dead row per group per location or radius change.
 */
const CLEAN_SWEEP = `DELETE FROM model_stats WHERE count = 0`;

export interface StaleGroup {
  market_key: string;
  model_key: string;
  variant_key: string;
}

/** The groups the next bounded batch would visit. Exported so test 6 can capture the same set. */
export const staleGroups = async (
  db: D1Database,
  cutoff: number,
  limit: number,
): Promise<{ groups: StaleGroup[]; usage: D1Usage }> => {
  const [read] = await db.batch<StaleGroup>([db.prepare(GROUPS).bind(cutoff, limit)]);
  return {
    groups: read.results,
    usage: { rowsRead: read.meta.rows_read, rowsWritten: read.meta.rows_written },
  };
};

/**
 * The two statements the loop sends for one group, in order.
 *
 * Exported so test 6 can re-issue the BYTE-IDENTICAL batch rather than a hand-copied
 * lookalike: a copy in the test would not carry a mutation applied here, and the mutant would
 * survive. Merely calling cleanupStaleObservations twice is not enough either -- the second
 * run's GROUPS query returns nothing, so the loop exits before any statement runs.
 */
export const staleGroupStatements = (
  db: D1Database,
  group: StaleGroup,
  cutoff: number,
): D1PreparedStatement[] => [
  db.prepare(CLEAN_A).bind(group.market_key, group.model_key, group.variant_key, cutoff),
  db.prepare(CLEAN_B).bind(group.market_key, group.model_key, group.variant_key, cutoff),
];

export const cleanupStaleObservations = async (
  db: D1Database,
  input: {
    now: number;
    staleAfterSeconds?: number;
    groupsPerBatch?: number;
    maxBatches?: number;
  },
): Promise<CleanupReport> => {
  const staleAfterSeconds = input.staleAfterSeconds ?? STALE_AFTER_SECONDS;
  const groupsPerBatch = input.groupsPerBatch ?? 25;
  const maxBatches = input.maxBatches ?? 40;
  const cutoff = input.now - staleAfterSeconds;

  const usage: D1Usage = { rowsRead: 0, rowsWritten: 0 };
  let groups = 0;
  let observationsDeleted = 0;
  let batches = 0;
  let remaining = false;

  while (true) {
    // Bounded, so 3E resumes rather than overflowing. `remaining` is set only when the loop
    // stops at maxBatches with the previous batch full -- a short batch proves exhaustion.
    if (batches >= maxBatches) {
      remaining = true;
      break;
    }

    const found = await staleGroups(db, cutoff, groupsPerBatch);
    usage.rowsRead += found.usage.rowsRead;
    usage.rowsWritten += found.usage.rowsWritten;
    if (found.groups.length === 0) {
      break;
    }

    // ONE db.batch() for the whole set of groups: two statements per group.
    const statements = found.groups.flatMap((group) =>
      staleGroupStatements(db, group, cutoff),
    );

    const applied = await db.batch(statements);
    applied.forEach((statement, index) => {
      usage.rowsRead += statement.meta.rows_read;
      usage.rowsWritten += statement.meta.rows_written;
      // Odd indices are the CLEAN_B deletes.
      if (index % 2 === 1) {
        observationsDeleted += statement.meta.changes;
      }
    });

    groups += found.groups.length;
    batches += 1;

    if (found.groups.length < groupsPerBatch) {
      break;
    }
  }

  // Unconditionally, exactly once per call, after the loop -- including when zero groups
  // expired and when the loop bailed early at maxBatches.
  const [swept] = await db.batch([db.prepare(CLEAN_SWEEP)]);
  usage.rowsRead += swept.meta.rows_read;
  usage.rowsWritten += swept.meta.rows_written;

  return {
    groups,
    observationsDeleted,
    aggregatesPruned: swept.meta.changes,
    batches,
    remaining,
    usage,
  };
};
