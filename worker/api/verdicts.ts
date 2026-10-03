/**
 * GET /api/verdicts -- the evaluated listings the page shows: every stored listing with the
 * verdict 3D committed for it, the market average AS IT STANDS NOW, newest-first inside a
 * deal-first ordering, bounded.
 *
 * "AS IT STANDS NOW", NOT "THE AVERAGE THAT VERDICT RESTED ON". The earlier wording claimed
 * more than this read can deliver: the basis of a verdict is never persisted -- 3D commits
 * `verdict` and not `reason`, and nothing stores the aggregate it was computed against -- and
 * `evaluateBatch.ts:98-100` states that NOTHING REQUEUES A TASK WHEN THE MARKET CHANGES. So an
 * older DEAL steady-states beside a comparison drawn from a market that has since moved, and
 * the page can read `Deal / vs. market average 4.0% above`. That is a true statement of two
 * separately-true facts, and it is the cost of serving a verdict and a live aggregate together.
 * Serving the basis instead would need it persisted, which is a 3D change this slice does not
 * make. Do not restore the stronger wording without that column.
 */

import { referenceAverageCents } from "../evaluation/dealRules";
import { MINIMUM_REFERENCE_COUNT } from "../evaluation/types";
import { CATALOG_COMPONENT_ID, STORAGE_COMPONENT_ID } from "../normalize/catalogIndex";
import { componentById } from "../../src/data/catalog";
import type { ComponentType } from "../../src/types";

export const VERDICT_PAGE_SIZE = 50;

export type WireStatus = "DEAL" | "NOT_DEAL" | "NEEDS_REVIEW" | "PENDING";

export interface WireListing {
  source: string;
  listingId: string;
  componentType: ComponentType;
  modelKey: string | null;
  variantKey: string | null;
  title: string;
  priceCents: number | null;
  location: string | null;
  url: string;
  observedAt: string;
  evaluation: {
    status: WireStatus;
    averagePriceCents?: number;
    discountPercent?: number;
  };
}

export interface VerdictsBody {
  listings: WireListing[];
  truncated: boolean;
}

export type VerdictsResult =
  | { ok: true; status: 200; body: VerdictsBody }
  | {
      ok: false;
      status: number;
      /**
       * TWO CODES, NOT ONE, AND THE DISTINCTION IS THE WHOLE REASON THE `try` BELOW IS NARROW.
       * `VERDICTS_STORAGE_FAILED` means the READ failed -- D1, the binding, the migration.
       * `VERDICTS_ROWS_UNUSABLE` means the read SUCCEEDED and every row it returned was
       * unpresentable -- a catalog/collector version skew, or a bad hand-written write. Those
       * are two different fixes, and `worker/index.ts`'s own rule is that three fixes behind
       * one code sends an operator to the wrong one. Returning the storage code here would
       * reintroduce, on the wire, exactly the miscoding narrowing the `try` removed.
       */
      code: "VERDICTS_STORAGE_FAILED" | "VERDICTS_ROWS_UNUSABLE" | "INVALID_VERDICTS_QUERY";
      details?: Record<string, unknown>;
    };

/**
 * THE PLAN, THE GROWTH TERM AND THE LEVER, in the idiom `migrations/0002` already uses for its
 * own three statements. MEASURED on miniflare D1 via `EXPLAIN QUERY PLAN`:
 *
 *   SCAN l USING INDEX sqlite_autoindex_listings_1
 *   SEARCH t USING INDEX sqlite_autoindex_evaluation_tasks_1 (source=? AND listing_id=?) LEFT-JOIN
 *   SEARCH p USING INDEX sqlite_autoindex_price_observations_1 (source=? AND listing_id=?) LEFT-JOIN
 *   SEARCH s USING INDEX sqlite_autoindex_model_stats_1 (market_key=? AND model_key=? AND variant_key=?) LEFT-JOIN
 *   USE TEMP B-TREE FOR ORDER BY
 *
 * A full scan of `listings` plus one primary-key seek per row into each of the three joined
 * tables. `rows_read` is LINEAR IN THE CORPUS and each POPULATED joined table adds exactly one
 * more multiple of it. MEASURED, `rows_read` at corpus 200 and 400 (identical ratios at both,
 * so the term is linear and not a fixture artefact):
 *
 *   listings alone ................... 2x corpus
 *   + evaluation_tasks ............... 3x
 *   + price_observations ............. 4x
 *   + model_stats .................... 5x   <-- production's shape
 *
 * So budget 5 x corpus per page load. `LIMIT 51` BOUNDS THE RESPONSE AND NOT `rows_read`;
 * saying otherwise would be a claim wider than the measurement.
 *
 * NO INDEX FIXES THIS, and the reason is structural rather than a missing index: the leading
 * term of the ORDER BY is a CASE over a JOINED table's column, which no index on `listings` can
 * serve. Four variants were measured on a 2,000-row corpus -- an index on
 * `listings(last_seen_at)`, one on `evaluation_tasks(verdict)`, both together, and
 * `last_seen_at` clustered into heartbeat buckets -- and every one left `rows_read` unchanged
 * with a byte-identical plan. THE LEVER IS A DENORMALISED VERDICT COLUMN ON `listings`, which
 * is a migration AND a second writer, not an index.
 *
 * THE TRIGGER, as a share, the way `runMonitor.ts` phrases its own: revisit when this
 * endpoint's share approaches the 20% of the daily read allowance `runCleanup` already reserves
 * -- i.e. when `corpus x loads-per-day x 5` approaches 1,000,000. At 20 loads/day that is a
 * corpus of 10,000. BUDGET FROM THE CORPUS, and measure it; do not derive it from ~8,300.
 *
 * WHY NOT FROM ~8,300, which this paragraph used to anchor on. `docs/phase-3c-storage.md:125`
 * derives ~8,300 as a WRITE-budget STEADY STATE of TRACKED listings -- 12 rows written per
 * listing per day at 48 scans -- and it is NOT a bound on the size of this table, because
 * NOTHING IN PRODUCTION DELETES FROM `listings`. MEASURED: every `DELETE FROM listings` in the
 * repository is a test truncate (`worker/testing/d1.ts`, `scripts/e2e-local.sh`, one case in
 * this file's own suite). Production prunes `price_observations`
 * (`cleanupStaleObservations` CLEAN_B, `recordSightings` DELETE_OBS), `model_stats`
 * (CLEAN_SWEEP, `WHERE count = 0`) and `monitor_runs` (PRUNE_RUNS) -- and nothing else. So the
 * corpus this statement SCANS is cumulative while 8,300 is a steady state of LIVE listings: a
 * reader budgeting from it under-budgets this read and revisits it too late. The
 * "20 loads/day -> corpus of 10,000" reading is anchor-free and is the one to use.
 *
 * Both readings are one inequality and both are measurable today. The anchor is worth naming
 * because the paragraph above already refuses the adjacent trap -- `LIMIT 51` bounds the
 * RESPONSE and not `rows_read` -- and then took a steady-state WRITE figure as a ceiling on a
 * cumulative SCAN. Two units confused in the same comment that insists on the distinction.
 *
 * WHAT THE SELECTION FILTER ADDS, RE-MEASURED, because the figures above were committed BEFORE
 * the `WHERE` existed. MEASURED on a 63-row corpus (60 `cpu` ahead of 3 `gpu`), `rows_read`
 * against the unfiltered statement's 126:
 *
 *   |all| |pairs|   delta
 *       1      0     -59    the filter EXCLUDES most of the corpus and pays for itself
 *       3      0       0
 *       9      0      +9    all nine types: the no-op selection, and the worst realistic case
 *       8      1      +8
 *       9      9      +9    the `OR` short-circuits; `?3` is never materialised
 *       0      1     -61
 *
 * THE BOUND TO WRITE IN: the `WHERE` adds AT MOST ONE `rows_read` PER ELEMENT OF THE LISTS IT
 * EVALUATES -- <= 18 at the 9-target cap, 9 for the all-nine-types case -- and it REDUCES
 * `rows_read` in proportion to the share of the corpus excluded. V-f7 pins the inequality over a
 * table of list lengths rather than over one fixture's number: an earlier draft said "never more
 * than 3", which was one fixture's `|all|` generalised into a bound and is wrong by 3x at the
 * shipped configuration.
 *
 * THE PLAN SHAPE IS UNCHANGED, which is the good news: each `json_each` becomes a LIST SUBQUERY
 * with a CREATE BLOOM FILTER, materialised ONCE; the three LEFT JOIN primary-key seeks and the
 * USE TEMP B-TREE FOR ORDER BY are untouched; `SCAN l USING INDEX sqlite_autoindex_listings_1`
 * becomes a plain `SCAN l`.
 */
const SELECT_VERDICTS_BODY = `SELECT l.source, l.listing_id, l.component_type, l.model_key,
       l.variant_key, l.title, l.price_cents, l.location_text, l.url, l.last_seen_at,
       t.verdict AS verdict,
       CASE WHEN p.listing_id IS NULL THEN s.count
            ELSE s.count - 1 END                               AS reference_count,
       CASE WHEN p.listing_id IS NULL THEN s.total_price_cents
            ELSE s.total_price_cents - p.price_cents END        AS reference_total_cents
  FROM listings l
  LEFT JOIN evaluation_tasks t
         ON t.source = l.source AND t.listing_id = l.listing_id
  LEFT JOIN price_observations p
         ON p.source = l.source AND p.listing_id = l.listing_id
  LEFT JOIN model_stats s
         ON s.market_key  = COALESCE(p.market_key,  l.market_key)
        AND s.model_key   = COALESCE(p.model_key,   l.model_key)
        AND s.variant_key = COALESCE(p.variant_key, l.variant_key)
`;

/**
 * THE SERVER-SIDE SELECTION FILTER, and it closes PR #17's defect. Before it, the component and
 * model filter ran IN THE BROWSER, AFTER this statement's `LIMIT 51` -- so a page of 50 rows that
 * were all of a component the user is not watching filtered down to nothing and the page reported
 * a non-empty database as empty. MEASURED both ways on 60 newer `cpu` rows ahead of 3 `gpu`:
 * unfiltered, the page holds 50 rows, 0 of them gpu, `truncated: true`; filtered, it holds 3 rows,
 * all gpu, `truncated: false`.
 *
 * `json_each`, NOT BOUND PARAMETERS, and that is not a style choice: D1 caps a statement at 100
 * parameters (MEASURED -- `?101` answers `D1_ERROR: variable number must be between ?1 and ?100`)
 * and a shipped-default `cpu + gpu` selection is 113 model names. The parameter form is BROKEN,
 * not merely ugly.
 *
 * `'/'` IS SAFE AS THE PAIR SEPARATOR: MEASURED, 0 of 336 catalog model names contain one.
 * `COALESCE(model_key, '')` yields `gpu/` for an uncatalogued listing, which preserves the
 * requirement that a model-narrowed selection excludes rows whose model was never resolved --
 * and is exactly why `pairs=["gpu/"]` is refused at the edge rather than bound here: MEASURED, it
 * really does select precisely the `model_key IS NULL` rows.
 *
 * THE BINDINGS ARE STORAGE IDS, NOT CATALOG IDS. This is the fourth site of the
 * `case_fan`/`case_fans` translation; the wire carries catalog vocabulary and the handler
 * translates. Binding the catalog spelling makes case fans never appear.
 */
const WHERE_SELECTION = ` WHERE l.component_type IN (SELECT value FROM json_each(?2))
    OR (l.component_type || '/' || COALESCE(l.model_key, '')) IN (SELECT value FROM json_each(?3))`
;

const ORDER_AND_BOUND = ` ORDER BY CASE WHEN t.verdict IS NULL      THEN 2
               WHEN t.verdict = 'DEAL'     THEN 0
               WHEN t.verdict = 'NOT_DEAL' THEN 3
               ELSE 1 END,
          l.last_seen_at DESC, l.listing_id
 LIMIT ?1`;

/**
 * TWO STATEMENTS, AND THE UNFILTERED ONE IS BYTE-IDENTICAL TO THE STATEMENT THAT SHIPPED. An
 * ABSENT `?all` is NOT the same request as `?all` naming all nine catalog types, and the
 * difference is measurable: binding the nine storage ids would make the SQL drop any row whose
 * `component_type` is outside the catalog, which is precisely the catalog/collector skew
 * `toWireListing` warns about and V-2b/V-16b pin. An absent filter would then silently swallow
 * the one signal an operator has that the two halves disagree -- and it would make that guard
 * unreachable, i.e. dead code. So absent means NO PREDICATE, and `?all=` present-and-empty means
 * the empty list.
 */
export const SELECT_VERDICTS = SELECT_VERDICTS_BODY + ORDER_AND_BOUND;
export const SELECT_VERDICTS_FILTERED = SELECT_VERDICTS_BODY + WHERE_SELECTION + ORDER_AND_BOUND;


interface VerdictRow {
  source: string;
  listing_id: string;
  component_type: string;
  model_key: string | null;
  variant_key: string;
  title: string;
  price_cents: number | null;
  location_text: string | null;
  url: string;
  last_seen_at: number;
  verdict: string | null;
  reference_count: number | null;
  reference_total_cents: number | null;
}

export const statusFor = (verdict: string | null): WireStatus =>
  verdict === null
    ? "PENDING"
    : verdict === "DEAL"
      ? "DEAL"
      : verdict === "NOT_DEAL"
        ? "NOT_DEAL"
        : "NEEDS_REVIEW";

export const discountPercentFrom = (
  priceCents: number | null,
  averageCents: number | null,
): number | null =>
  priceCents === null || averageCents === null || averageCents <= 0
    ? null
    : ((averageCents - priceCents) / averageCents) * 100;

/**
 * THE SAME GATE `decide` APPLIES TO THE SAME TWO VALUES, and it is not defence in depth.
 * `dealRules.ts:190-198` refuses to judge on a `count` or `total` that is negative or not a safe
 * integer, and answers `invalid-reference-aggregate` rather than `insufficient-evidence`
 * precisely because "waiting repairs 4; waiting never repairs -1, a non-integer, or a negative
 * total". This path had no such gate: `referenceAverageCents` gates only on `count <= 0`
 * (dealRules.ts:124-128) and the presentation gate below tests only
 * `count >= MINIMUM_REFERENCE_COUNT`, which BOTH `6` and the non-integer `5.5` pass. So
 * `reference_count: 6, reference_total_cents: -600000` served `averagePriceCents: -100000` and
 * the card rendered "Market average  -$1,000.00".
 *
 * REACHABILITY IS BETTER THAN "SOMEONE WROTE A CORRUPT ROW", AND MEASURED: two of the three
 * corrupt states are manufactured BY THE EXCLUSION ARITHMETIC IN THE STATEMENT ABOVE out of
 * rows that satisfy every `CHECK` on `model_stats` (`count >= 0`, `total_price_cents >= 0`,
 * `count > 0 OR total_price_cents = 0`). `s.total_price_cents - p.price_cents` goes negative as
 * soon as the observation and the aggregate drift apart -- the divergence 3C's own doc keeps a
 * drift-detection section for -- and `s.count - 1` goes negative on a perfectly legal `(0, 0)`
 * aggregate. The third needs no drift at all: `count` is INTEGER *affinity*, so `5.5` passes
 * `count >= 0`, reads back as `5.5`, and then passes `>= MINIMUM_REFERENCE_COUNT`. All three are
 * pinned by V-22.
 *
 * IT WARNS RATHER THAN ONLY WITHHOLDING. Withholding in silence is indistinguishable from thin
 * evidence on the wire and on the page, which is the exact miscoding `decide`'s two separate
 * reasons exist to prevent -- it "sends an operator looking for more observations when
 * observations were never the problem".
 */
const corruptAggregate = (value: number | null): boolean =>
  value !== null && (!Number.isSafeInteger(value) || value < 0);

const catalogComponent = (value: string): ComponentType | null =>
  Object.hasOwn(CATALOG_COMPONENT_ID, value)
    ? CATALOG_COMPONENT_ID[value as keyof typeof CATALOG_COMPONENT_ID]
    : null;

export const toWireListing = (row: VerdictRow): WireListing | null => {
  const componentType = catalogComponent(row.component_type);
  if (componentType === null) {
    console.warn(`verdicts: unknown component_type ${JSON.stringify(row.component_type)}`);
    return null;
  }

  const count = row.reference_count;
  const total = row.reference_total_cents;
  let averageCents: number | null = null;
  if (corruptAggregate(count) || corruptAggregate(total)) {
    console.warn(
      `verdicts: listing ${row.listing_id} has a corrupt reference aggregate ` +
        `(count ${String(count)}, total ${String(total)}); withholding the market average`,
    );
  } else if (count !== null && count >= MINIMUM_REFERENCE_COUNT) {
    averageCents = referenceAverageCents(total, count);
  }
  const discountPercent = discountPercentFrom(row.price_cents, averageCents);

  return {
    source: row.source,
    listingId: row.listing_id,
    componentType,
    modelKey: row.model_key,
    variantKey: row.variant_key === "" ? null : row.variant_key,
    title: row.title,
    priceCents: row.price_cents,
    location: row.location_text,
    url: row.url,
    observedAt: new Date(row.last_seen_at * 1000).toISOString(),
    evaluation: {
      status: statusFor(row.verdict),
      ...(averageCents === null ? {} : { averagePriceCents: averageCents }),
      ...(discountPercent === null ? {} : { discountPercent }),
    },
  };
};

/**
 * ABSENT, EMPTY AND INVALID ARE THREE DIFFERENT THINGS, and each of the three is a measured row of
 * the contract:
 *
 *   `?all` absent ............................ the unfiltered page (and `?pairs` is then a 400)
 *   `?all=` present-and-empty, `?pairs` set .. only the paired rows -- the selection a
 *                                              model-narrowed form sends, and the one an earlier
 *                                              draft made a 400
 *   `?all=` and `?pairs=` both empty ......... zero rows, which is the empty list and not an error
 *   a value outside the catalog .............. 400, because ignoring it returns an empty page that
 *                                              reads as "nothing collected yet"
 *   `?pairs` with `?all` absent .............. 400: MEASURED, the page comes back byte-identical
 *                                              to the unfiltered one, i.e. the pairs are a SILENT
 *                                              NO-OP, and one validation line removes it
 */
export interface VerdictsSelection {
  /** Storage component ids, for the types whose selection is `mode:"all"`. */
  all: string[];
  /** `"<storage type>/<model>"`, for the types whose selection is `mode:"selected"`. */
  pairs: string[];
}

const parseList = (raw: string): string[] | null => {
  if (raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) return null;
  return parsed as string[];
};

export const parseVerdictsQuery = (
  params: URLSearchParams,
): { ok: true; selection: VerdictsSelection | null } | { ok: false; detail: string } => {
  const rawAll = params.get("all");
  const rawPairs = params.get("pairs");

  if (rawAll === null) {
    if (rawPairs !== null) return { ok: false, detail: "pairs requires all" };
    return { ok: true, selection: null };
  }

  const all = parseList(rawAll);
  if (all === null) return { ok: false, detail: "all" };
  const pairs = parseList(rawPairs ?? "");
  if (pairs === null) return { ok: false, detail: "pairs" };

  const storageIds: string[] = [];
  for (const id of all) {
    if (!Object.hasOwn(componentById, id)) return { ok: false, detail: id };
    storageIds.push(STORAGE_COMPONENT_ID[id as ComponentType]);
  }

  const storagePairs: string[] = [];
  for (const pair of pairs) {
    // THE FIRST '/' ONLY: a model name cannot contain one (MEASURED over all 336), so the split is
    // unambiguous, and a second '/' therefore lands in the model half where the catalog lookup
    // refuses it.
    const mark = pair.indexOf("/");
    if (mark === -1) return { ok: false, detail: pair };
    const type = pair.slice(0, mark);
    const model = pair.slice(mark + 1);
    if (!Object.hasOwn(componentById, type)) return { ok: false, detail: pair };
    // THE EMPTY MODEL HALF IS REFUSED HERE AND NOWHERE ELSE. `gpu/` is not a pair the UI can
    // build, but it IS a pair the wire can carry, and MEASURED it selects exactly the 17
    // `model_key IS NULL` rows -- the opposite of what a model-narrowed selection means.
    if (model === "" || !componentById[type as ComponentType].models.includes(model)) {
      return { ok: false, detail: pair };
    }
    storagePairs.push(`${STORAGE_COMPONENT_ID[type as ComponentType]}/${model}`);
  }

  return { ok: true, selection: { all: storageIds, pairs: storagePairs } };
};

export const handleGetVerdicts = async (
  db: D1Database,
  params: URLSearchParams,
): Promise<VerdictsResult> => {
  // THE try COVERS THE DATABASE CALL AND NOTHING ELSE. With the mapping inside it, a mapper
  // throw was reported as a storage failure -- the wrong subsystem, and the reason the
  // RangeError above was a 503 rather than one missing card.
  // THE QUERY IS VALIDATED BEFORE THE READ, so a bad parameter costs no `rows_read` and cannot be
  // reported as a storage failure.
  const query = parseVerdictsQuery(params);
  if (!query.ok) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_VERDICTS_QUERY",
      details: { detail: query.detail },
    };
  }
  const selection = query.selection;

  let rows: VerdictRow[];
  try {
    const read =
      selection === null
        ? await db.prepare(SELECT_VERDICTS).bind(VERDICT_PAGE_SIZE + 1).all<VerdictRow>()
        : await db
            .prepare(SELECT_VERDICTS_FILTERED)
            .bind(
              VERDICT_PAGE_SIZE + 1,
              JSON.stringify(selection.all),
              JSON.stringify(selection.pairs),
            )
            .all<VerdictRow>();
    rows = read.results;
  } catch {
    return { ok: false, status: 503, code: "VERDICTS_STORAGE_FAILED" };
  }

  // MAP AND DROP FIRST, BOUND SECOND. Dropping after the slice let a page of 49 report
  // `truncated: false`, which is the silent claim `truncated` exists to prevent.
  //
  // THE PER-ROW try IS THE MECHANISM, NOT A BACKSTOP, and it is why there is no explicit
  // `Number.isFinite` check on `last_seen_at`. `last_seen_at` is INTEGER *affinity*, so a
  // hand-written `wrangler d1 execute` -- the writer this route's unknown-verdict rule already
  // assumes -- can store 'not-a-time' or 1e18, and `toISOString()` throws RangeError on both.
  // MEASURED: an explicit guard for exactly that case had NO killing mutation, because this
  // catch already produces the same outcome (one card lost, page intact, one warning naming the
  // listing). A line no mutation can kill is the dead code worker/storage/marketKey.ts:25-29
  // removed for the same reason. The shape is `evaluateBatch`'s per-task try: "a `decide` that
  // throws for one candidate must not abort the other fourteen".
  const served: WireListing[] = [];
  for (const row of rows) {
    try {
      const listing = toWireListing(row);
      if (listing !== null) served.push(listing);
    } catch (error) {
      console.warn(`verdicts: listing ${row.listing_id} could not be served: ${String(error)}`);
    }
  }

  // A TOTAL MAPPING FAILURE IS A FAILURE, NOT AN EMPTY PAGE. The rule, and the measured
  // defect behind it, are worker/api/listings.ts:421-438 on the write path: an outage that
  // reads clean at every layer an operator can see. An empty page is also the one state the
  // orchestrator's show-everything ruling exists to prevent.
  //
  // `rows.length > 0 &&` IS LOAD-BEARING AND IS THE WHOLE GUARD ON THE COMMONEST STATE THERE
  // IS. Without it an EMPTY DATABASE answers 503 -- and an empty database is what every fresh
  // deployment holds until the first collection run lands. MEASURED: deleting that conjunct
  // turns V-17 red and nothing else, so V-17 is the only test standing between "nothing
  // collected yet" and "the service is broken". Do not delete V-17 as a decorative control.
  if (rows.length > 0 && served.length === 0) {
    return { ok: false, status: 503, code: "VERDICTS_ROWS_UNUSABLE" };
  }

  return {
    ok: true,
    status: 200,
    body: {
      listings: served.slice(0, VERDICT_PAGE_SIZE),
      // "YOU ARE NOT SEEING EVERYTHING", not "the statement hit its bound". Either cause
      // makes the page partial, so either cause sets the flag; `console.warn` above is what
      // tells an operator which.
      truncated: served.length > VERDICT_PAGE_SIZE || served.length < rows.length,
    },
  };
};
