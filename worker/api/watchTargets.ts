/**
 * GET /api/watch-targets -- the watch list the collector reads before it searches: what to hunt
 * (component type + query, one row per target) and where (each target's own `market`), as the union
 * of every ACTIVE user's searches (migrations/0009).
 *
 * It returns a RESULT, never a Response: worker/index.ts owns securityHeaders, `Vary` and the
 * error envelope, exactly as worker/api/settings.ts and worker/api/listings.ts do, so a handler
 * cannot ship a reply that forgot one.
 *
 * THIS FILE MUST NEVER NAME search_revisions, search_settings OR evaluation_tasks. `searchRevision`
 * is `evaluateBatch`'s staleness key and a bump re-opens every task in the corpus; editing what
 * you hunt says nothing about whether an already-judged listing was a deal. The two tables here
 * are separate from the revision log precisely so that isolation is structural. W-1 asserts it.
 */

import { CATALOG_COMPONENT_ID } from "../normalize/catalogIndex";
import {
  areaMarketKey,
  isActive,
  isApproved,
  OWNER_USER_ID,
  readAllowlist,
  userColumns,
  userFromRow,
  type AllowlistEnvironment,
  type UserRow,
} from "../users/users";
import { slug } from "./watch";

export interface WatchMarket {
  location: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
}

export interface WatchTarget {
  /**
   * `${type}-${slug(query)}@${location}-${radius}`: ONE ID PER FACEBOOK REQUEST, so the collector's
   * per-target guard state (the empty-run latch) follows the search it measured, whoever asked for
   * it. Derived here, never stored -- the stored `target_id` is the owning user's own name for it.
   */
  targetId: string;
  componentType: string;
  query: string;
  /** Where THIS search runs: its owning users' shared area (migrations/0009). */
  market: WatchMarket;
}

export interface WatchTargetsBody {
  /**
   * PRESENT ONLY WHEN EVERY TARGET SHARES ONE MARKET, else `null`. A collector that predates the
   * per-target `market` reads only this field: with one market it runs exactly as before, and with
   * several it fails loudly on `null` (EXIT_CONFIG) rather than running every search in one area.
   */
  market: WatchMarket | null;
  /**
   * The DE-DUPLICATED UNION of every ACTIVE user's searches: one entry per (component type, query,
   * area market key), ordered by target id. At most 9 by construction -- the cap guard counts the
   * same distinct triple over every stored target (worker/api/watch.ts CAP_GUARD).
   */
  targets: WatchTarget[];
  /**
   * "stopped" ONLY WHEN NO USER IS ACTIVE, and then `targets` is empty. The collector reads the word
   * first and exits 0. A collector older than this field sees `targets: []` and fails loudly.
   */
  monitoring: "running" | "stopped";
}

export type WatchTargetsResult =
  | { ok: true; status: 200; body: WatchTargetsBody }
  | { ok: false; status: number; code: string };

/**
 * Every enabled user's searches with their area, in one read. The allowlist half of ACTIVE is
 * applied in JS (users.ts): it is a secret, not a column.
 */
const SELECT_ENABLED_TARGETS = `SELECT ${userColumns("u")},
       t.target_id, t.component_type, t.query
  FROM users u
  LEFT JOIN user_watch_targets t ON t.user_id = u.user_id
 WHERE u.monitoring_enabled = 1 OR u.user_id = ${OWNER_USER_ID}
 ORDER BY u.user_id, t.target_id`;

interface Row extends UserRow {
  target_id: string | null;
  component_type: string | null;
  query: string | null;
}

/** The catalog spelling of a stored component type, for the id; unknown types keep their own. */
const idType = (componentType: string): string =>
  Object.hasOwn(CATALOG_COMPONENT_ID, componentType)
    ? CATALOG_COMPONENT_ID[componentType as keyof typeof CATALOG_COMPONENT_ID]
    : componentType;

export const wireTargetId = (componentType: string, query: string, market: WatchMarket): string =>
  `${idType(componentType)}-${slug(query)}@${market.location}-${market.radiusKm}`;

export const handleGetWatchTargets = async (
  db: D1Database,
  environment: AllowlistEnvironment,
): Promise<WatchTargetsResult> => {
  // THROWS on an unusable allowlist, and that is answered as the config 503 it is -- never as
  // "zero users, stopped", which would silently stop everyone's collection.
  let allowlist;
  try {
    allowlist = readAllowlist(environment);
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? String(error.code) : "AUTH_CONFIG_INVALID";
    return { ok: false, status: 503, code };
  }

  let rows: Row[];
  try {
    rows = (await db.prepare(SELECT_ENABLED_TARGETS).all<Row>()).results;
  } catch {
    // A DISTINCT CODE, not SETTINGS_STORAGE_FAILED or INGEST_STORAGE_FAILED: three different
    // fixes behind one code sends an operator to the wrong one. Swallowing the throw and
    // answering `{market, targets: []}` instead would make a storage outage read to the
    // collector as "there is nothing to hunt" -- a silent stop, not a loud one. W-3 pins it.
    return { ok: false, status: 503, code: "WATCH_TARGETS_STORAGE_FAILED" };
  }

  // AN UNCLAIMED OR MIS-CLAIMED OWNER IS A LOUD FAILURE, NEVER "STOPPED". User 1 with no email, or
  // with an email the allowlist does not approve (a typo in the operator's claim), would otherwise
  // read as "nobody is active" -- the collector exits 0 every run and collection stops silently.
  const owner = rows.find((row) => row.user_id === OWNER_USER_ID);
  if (owner === undefined || !isApproved(owner.email, allowlist)) {
    return { ok: false, status: 503, code: "OWNER_UNCLAIMED" };
  }

  let anyActive = false;
  const union = new Map<string, WatchTarget>();
  const ids = new Set<string>();
  for (const row of rows) {
    const user = userFromRow(row);
    if (!isActive(user, allowlist)) continue;
    anyActive = true;
    if (row.target_id === null || user.area === null) continue;
    const market: WatchMarket = { ...user.area };
    const key = JSON.stringify([row.component_type, row.query, areaMarketKey(user.area)]);
    if (union.has(key)) continue;
    // TWO DISTINCT SEARCHES CAN SLUG TO ONE ID ('RTX' and 'rtx'). A suffix keeps both ids unique
    // and deterministic (rows arrive ordered), so the collector's per-target state never merges two
    // Facebook requests.
    const base = wireTargetId(row.component_type!, row.query!, market);
    let targetId = base;
    for (let n = 2; ids.has(targetId); n += 1) targetId = `${base}~${n}`;
    ids.add(targetId);
    union.set(key, {
      targetId,
      componentType: row.component_type!,
      query: row.query!,
      market,
    });
  }

  if (!anyActive) return { ok: true, status: 200, body: { market: null, targets: [], monitoring: "stopped" } };

  // ORDER BY target id is not cosmetic: it is what makes the collector's run order deterministic and
  // therefore testable (the e2e's ordered partial-failure block needs the failing target FIRST).
  const targets = [...union.values()].sort((a, b) =>
    a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0,
  );
  const markets = new Set(targets.map((target) => JSON.stringify(target.market)));
  return {
    ok: true,
    status: 200,
    body: {
      market: markets.size === 1 ? targets[0].market : null,
      targets,
      monitoring: "running",
    },
  };
};
