/**
 * THE EVALUATION CORPUS' FINGERPRINT, AND ONE COPY OF IT. Two suites now assert that editing what
 * you hunt costs ZERO verdicts -- `worker/api/watchTargets.test.ts` (the collector's read) and
 * `worker/api/watch.test.ts` (the browser's read and write) -- and two copies of this helper can
 * drift until one of them stops measuring anything.
 *
 * THE CLAIM IS PRECISE, AND IT IS NOT "the files diff clean": the `results`-only fingerprint of
 * `search_revisions`, `search_settings` and `evaluation_tasks`. A `wrangler --json` envelope
 * carries a `meta.duration` that differs between runs and says nothing.
 *
 * It is the WIDE fingerprint: `SELECT *` pins `created_at`, `lease_token` and `lease_expires_at`
 * as well as the verdict columns, so a write that touched only the lease would still show.
 *
 * IT DELIBERATELY DOES NOT COVER `model_stats` OR `price_observations`. That width is the right
 * one for the invariant being asserted -- a watch-list edit must invalidate no VERDICT -- and a
 * market change really does reset the price benchmarks, which is disclosed in the UI rather than
 * prevented. Widening this helper to those two tables would make the claim false by design.
 *
 * EVERY CALLER MUST ALSO ASSERT THE CONTROL IS NON-EMPTY. MEASURED: replacing `fingerprint` with
 * one returning `{revisions: [], settings: [], tasks: []}` left BOTH the claim and the control
 * green -- a mutation satisfied by both sides losing, in the helper two suites share. The control
 * suites therefore capture a before, assert `not.toEqual`, AND assert all three sub-arrays are
 * non-empty.
 */

import { claimEvaluationTasks } from "../evaluation/evaluateBatch";
import { loadCurrentSettings } from "../search/settings";

export interface EvaluationFingerprint {
  revisions: Record<string, unknown>[];
  settings: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
}

export const fingerprint = async (db: D1Database): Promise<EvaluationFingerprint> => {
  const revisions = await db.prepare("SELECT * FROM search_revisions ORDER BY revision").all();
  const settings = await db.prepare("SELECT * FROM search_settings ORDER BY id").all();
  const tasks = await db
    .prepare("SELECT * FROM evaluation_tasks ORDER BY source, listing_id")
    .all();
  return {
    revisions: revisions.results as Record<string, unknown>[],
    settings: settings.results as Record<string, unknown>[],
    tasks: tasks.results as Record<string, unknown>[],
  };
};

export const seedEvaluationCorpus = async (db: D1Database): Promise<void> => {
  await db.batch([
    db.prepare(
      "INSERT INTO search_revisions (revision, mode, minimum_discount_percent, maximum_price_cents, created_at) VALUES (0, 'MAXIMUM_PRICE', NULL, 80000, 1700000000)",
    ),
    db.prepare(
      "INSERT INTO search_revisions (revision, mode, minimum_discount_percent, maximum_price_cents, created_at) VALUES (1, 'MAXIMUM_PRICE', NULL, 74900, 1700000100)",
    ),
    db.prepare("INSERT INTO search_settings (id, current_revision) VALUES (1, 1)"),
  ]);

  const verdicts = ["DEAL", "NEEDS_REVIEW", "NOT_DEAL"];
  await db.batch(
    verdicts.map((verdict, index) =>
      db
        .prepare(
          `INSERT INTO evaluation_tasks
             (source, listing_id, status, created_at, evaluated_revision, verdict, evaluated_at,
              lease_expires_at, lease_token)
           VALUES ('facebook-marketplace', ?1, 'COMPLETE', 1700000200, 1, ?2, 1700000300, 0, '')`,
        )
        .bind(`listing-${index}`, verdict),
    ),
  );
};

/** How many tasks a drain would re-open right now. 0 means no verdict was invalidated. */
export const claim = async (db: D1Database): Promise<number> => {
  const current = await loadCurrentSettings(db);
  const claimed = await claimEvaluationTasks(db, {
    source: "facebook-marketplace",
    batchSize: 15,
    now: 1700001000,
    leaseSeconds: 300,
    leaseToken: "watch-suite-lease",
    searchRevision: current.settings?.searchRevision ?? 0,
  });
  return claimed.tasks.length;
};
