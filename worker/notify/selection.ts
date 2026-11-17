/**
 * WHAT THE USER IS WATCHING, DERIVED THE SAME WAY THE DASHBOARD DERIVES IT.
 *
 * The user's stored `user_watch_targets` rows go through the server's own `invert` (worker/api/watch.ts) --
 * the function `GET /api/watch` uses to rebuild the form -- and come out as the `{all, pairs}`
 * pair `GET /api/verdicts` filters on. So "selected" means exactly what the dashboard means:
 *
 *   - a type with no catalog-model query (`mode: "all"`) selects EVERY model of that type;
 *   - otherwise only the selected (type, model_key) pairs.
 *
 * THE OUTPUT IS STORAGE VOCABULARY. `invert` speaks catalog ids (`case_fans`); `listings` stores
 * worker ids (`case_fan`). Binding the catalog spelling would make case fans never alert -- the
 * same trap verdicts.ts records as its fourth site. `STORAGE_COMPONENT_ID` is the one bridge.
 *
 * Rows `invert` puts in `residue` (a component type the catalog does not know) select nothing,
 * as they do on the dashboard. An empty watch list selects nothing.
 */

import { invert, type StoredTarget } from "../api/watch";
import { STORAGE_COMPONENT_ID } from "../normalize/catalogIndex";

export interface NotifySelection {
  /** Storage component ids watched in full. Bound as `?2`. */
  all: string[];
  /** `<storage id>/<model_key>` pairs. Bound as `?3`. */
  pairs: string[];
}

/** ONE USER'S searches (migrations/0009), ordered as `GET /api/watch` orders them. ?1 user_id. */
export const SELECT_WATCH_TARGETS = `SELECT target_id, component_type, query
  FROM user_watch_targets WHERE user_id = ?1 ORDER BY target_id`;

export const selectionFromTargets = (rows: readonly StoredTarget[]): NotifySelection => {
  const inverted = invert(rows);
  const all: string[] = [];
  const pairs: string[] = [];
  for (const type of inverted.components) {
    const storage = STORAGE_COMPONENT_ID[type];
    const choice = inverted.models[type];
    if (choice.mode === "all") {
      all.push(storage);
    } else {
      for (const model of choice.values) pairs.push(`${storage}/${model}`);
    }
  }
  return { all, pairs };
};

export const readSelection = async (db: D1Database, userId: number): Promise<NotifySelection> => {
  const read = await db
    .prepare(SELECT_WATCH_TARGETS)
    .bind(userId)
    .all<{ target_id: string; component_type: string; query: string }>();
  return selectionFromTargets(
    read.results.map((row) => ({
      targetId: row.target_id,
      componentType: row.component_type,
      query: row.query,
    })),
  );
};
