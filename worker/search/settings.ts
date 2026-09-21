/**
 * The search settings singleton and its revision log -- the tables 3C and 3D both deferred
 * to 3E.
 *
 * Style follows worker/storage/ and worker/evaluation/: SQL as module constants, plain
 * functions taking `db` first, no clock (the caller passes `now`), no platform imports.
 *
 * WHAT THIS FILE MUST NEVER DO: name `evaluation_tasks`. Invariant 1 is that a settings
 * change bumps the revision and destroys no evaluation history. 3D made eligibility a
 * READ-TIME predicate over `evaluated_revision` (claim tier 4) precisely so a bump costs
 * zero writes to that table. An `UPDATE evaluation_tasks SET status='PENDING'` here would
 * be faster to write and would throw away every verdict, every `evaluated_at`, and the
 * "previously successful notification identities remain preserved" contract with it.
 */

import { validateSettings } from "../evaluation/dealRules";
import type { DealMode, EvaluationSettings } from "../evaluation/types";
import type { D1Usage } from "../storage/types";

/**
 * One statement, joining the pointer to the revision it names. It reads BOTH tables, which
 * is what makes the pair a table with a reader rather than a committed shape nobody uses.
 */
const LOAD = `SELECT r.revision, r.mode, r.minimum_discount_percent, r.maximum_price_cents
  FROM search_settings s
  JOIN search_revisions r ON r.revision = s.current_revision
 WHERE s.id = 1`;

const INSERT_REVISION = `INSERT INTO search_revisions
  (revision, mode, minimum_discount_percent, maximum_price_cents, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5)`;

/**
 * The pointer move. Upsert rather than INSERT-or-UPDATE because the first configure has no
 * row to update and every later one has exactly one. `id` is pinned to the literal 1 by the
 * statement AND by the table's CHECK.
 */
const POINT_AT = `INSERT INTO search_settings (id, current_revision) VALUES (1, ?1)
  ON CONFLICT(id) DO UPDATE SET current_revision = ?1`;

interface SettingsRow {
  revision: number;
  mode: string;
  minimum_discount_percent: number | null;
  maximum_price_cents: number | null;
}

export const loadCurrentSettings = async (
  db: D1Database,
): Promise<{ settings: EvaluationSettings | null; usage: D1Usage }> => {
  const read = await db.prepare(LOAD).all<SettingsRow>();
  const usage: D1Usage = { rowsRead: read.meta.rows_read, rowsWritten: read.meta.rows_written };
  const row = read.results[0];
  if (row === undefined) {
    // A database that has never been configured. 3E-b's drain must handle this, rather
    // than assume a seed row that no migration writes.
    return { settings: null, usage };
  }
  return {
    settings: {
      // TEXT from the database, narrowed on the way out. The column's CHECK is what makes
      // this safe: SQLite refuses any other value at write time.
      mode: row.mode as DealMode,
      minimumDiscountPercent: row.minimum_discount_percent,
      maximumPriceCents: row.maximum_price_cents,
      searchRevision: row.revision,
    },
    usage,
  };
};

export interface SearchSettingsInput {
  mode: DealMode;
  minimumDiscountPercent: number | null;
  maximumPriceCents: number | null;
}

/**
 * Apply settings. Returns the revision now in force and whether this call bumped it.
 *
 * Three properties, in the order the body establishes them:
 *
 * 1. VALIDATED BEFORE ANY WRITE. `validateSettings` is 3D's merged function -- the same one
 *    `evaluateBatch` runs -- so a setting that would be rejected at evaluation time is
 *    rejected here, and a rejection leaves the database untouched rather than committing a
 *    revision the evaluator will throw on.
 *
 * 2. COMPARED AS PROJECTIONS, not as raw input. `validateSettings` is what decides what a
 *    setting MEANS: 4.35 and 4.350000000000001 are the same 435 basis points, and
 *    `maximumPriceCents` is inert under DISCOUNT. Comparing raw input would bump the
 *    revision -- and re-open every task in the corpus -- for a change that cannot alter one
 *    verdict.
 *
 * 3. STORED AS THE PROJECTION. The revision log records what was APPLIED, not what was
 *    typed. Note the consequence for a future settings form (docs/phase-3e-scheduling.md
 *    says it too): a value that was inert when it was saved is not in the row, so
 *    repopulating a form from `loadCurrentSettings` and then switching mode starts from an
 *    empty field.
 */
export const updateSearchSettings = async (
  db: D1Database,
  input: SearchSettingsInput & { now: number },
): Promise<{ revision: number; changed: boolean; usage: D1Usage }> => {
  const current = await loadCurrentSettings(db);
  const usage: D1Usage = { ...current.usage };
  const nextRevision = current.settings === null ? 0 : current.settings.searchRevision + 1;

  const next = validateSettings({ ...input, searchRevision: nextRevision });

  if (current.settings !== null) {
    const live = validateSettings(current.settings);
    if (
      live.mode === next.mode &&
      live.basisPoints === next.basisPoints &&
      live.maximumPriceCents === next.maximumPriceCents
    ) {
      return { revision: current.settings.searchRevision, changed: false, usage };
    }
  }

  // basisPoints / 100 is EXACT for all 10,001 legal values (measured through the REAL
  // column itself, not in arithmetic), so the stored percent is the one that was applied.
  const storedPercent = next.basisPoints === null ? null : next.basisPoints / 100;

  // ONE db.batch: the revision row and the pointer move are one transaction, in this order.
  // Reversed, the FK rejects the pointer and the batch rolls back -- loudly, but the order
  // is not an accident.
  const applied = await db.batch([
    db
      .prepare(INSERT_REVISION)
      .bind(nextRevision, next.mode, storedPercent, next.maximumPriceCents, input.now),
    db.prepare(POINT_AT).bind(nextRevision),
  ]);
  for (const statement of applied) {
    usage.rowsRead += statement.meta.rows_read;
    usage.rowsWritten += statement.meta.rows_written;
  }

  return { revision: nextRevision, changed: true, usage };
};
