/**
 * GET /api/watch-targets -- the watch list the collector reads before it searches: what to hunt
 * (component type + query, one row per target) and where (the singleton market row).
 *
 * It returns a RESULT, never a Response: worker/index.ts owns securityHeaders, `Vary` and the
 * error envelope, exactly as worker/api/settings.ts and worker/api/listings.ts do, so a handler
 * cannot ship a reply that forgot one.
 *
 * THERE IS DELIBERATELY NO worker/search/watchTargets.ts. The worker/search/ <-> worker/api/
 * split exists because `loadCurrentSettings` has a SECOND caller (`runMonitor`); this has one
 * caller and two SELECTs, and a storage module with one caller is a layer that only adds a hop.
 * THE TRIGGER FOR SPLITTING IT IS A SECOND CALLER -- the settings UI reading the watch list, or a
 * scheduled path that needs it -- not file size.
 *
 * THIS FILE MUST NEVER NAME search_revisions, search_settings OR evaluation_tasks. `searchRevision`
 * is `evaluateBatch`'s staleness key and a bump re-opens every task in the corpus; editing what
 * you hunt says nothing about whether an already-judged listing was a deal. The two tables here
 * are separate from the revision log precisely so that isolation is structural. W-1 asserts it.
 */

export interface WatchMarket {
  location: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
}

export interface WatchTarget {
  targetId: string;
  componentType: string;
  query: string;
}

export interface WatchTargetsBody {
  /**
   * `null` when the singleton row is absent -- a REACHABLE state (someone can DELETE it), and an
   * EXPLICIT one. A default market invented here would collect into the wrong `market_key`
   * silently, which is the one failure the aggregate cannot be talked out of. W-5 pins it.
   */
  market: WatchMarket | null;
  targets: WatchTarget[];
}

export type WatchTargetsResult =
  | { ok: true; status: 200; body: WatchTargetsBody }
  | { ok: false; status: number; code: string };

const SELECT_MARKET = `SELECT location, latitude, longitude, radius_km
  FROM watch_market WHERE id = 1`;

/**
 * ORDER BY target_id is not cosmetic: it is what makes the collector's run order deterministic
 * and therefore testable. Without it SQLite is free to return the rows in any order and the
 * e2e's ordered partial-failure block (the failing target must run FIRST) becomes a coin toss.
 */
const SELECT_TARGETS = `SELECT target_id, component_type, query
  FROM watch_targets ORDER BY target_id`;

interface MarketRow {
  location: string;
  latitude: number;
  longitude: number;
  radius_km: number;
}

interface TargetRow {
  target_id: string;
  component_type: string;
  query: string;
}

export const handleGetWatchTargets = async (db: D1Database): Promise<WatchTargetsResult> => {
  try {
    const marketRead = await db.prepare(SELECT_MARKET).all<MarketRow>();
    const targetsRead = await db.prepare(SELECT_TARGETS).all<TargetRow>();

    const marketRow = marketRead.results[0];

    return {
      ok: true,
      status: 200,
      body: {
        market:
          marketRow === undefined
            ? null
            : {
                location: marketRow.location,
                latitude: marketRow.latitude,
                longitude: marketRow.longitude,
                radiusKm: marketRow.radius_km,
              },
        targets: targetsRead.results.map((row) => ({
          targetId: row.target_id,
          componentType: row.component_type,
          query: row.query,
        })),
      },
    };
  } catch {
    // A DISTINCT CODE, not SETTINGS_STORAGE_FAILED or INGEST_STORAGE_FAILED: three different
    // fixes behind one code sends an operator to the wrong one. Swallowing the throw and
    // answering `{market, targets: []}` instead would make a storage outage read to the
    // collector as "there is nothing to hunt" -- a silent stop, not a loud one. W-3 pins it.
    return { ok: false, status: 503, code: "WATCH_TARGETS_STORAGE_FAILED" };
  }
};
