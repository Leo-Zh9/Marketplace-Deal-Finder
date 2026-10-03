/**
 * GET/PUT /api/watch -- the BROWSER's view of the watch list and the market: what the form reads
 * on load and what Save writes. It is the settings-and-market UI's route, and it is the second
 * caller `worker/api/watchTargets.ts` names as the trigger for splitting storage out; it is not
 * split, because the two still have two SELECTs between them and a storage module with one
 * statement each is a layer that only adds a hop.
 *
 * IT RETURNS A RESULT, NEVER A Response: `worker/index.ts` owns `securityHeaders`, `Vary`, the
 * CORS header and the error envelope, so a handler cannot ship a reply that forgot one.
 *
 * THIS FILE MUST NEVER NAME search_revisions, search_settings OR evaluation_tasks. `searchRevision`
 * is `evaluateBatch`'s staleness key and a bump re-opens every task in the corpus -- 348 of them in
 * production. Editing WHAT you hunt says nothing about whether an already-judged listing was a
 * deal. The deal rule is changed through `PUT /api/settings`, which bumps the revision on purpose.
 * W-1w asserts the isolation over three PUTs and a GET.
 *
 * THE WIRE IS CATALOG VOCABULARY EVERYWHERE -- `components`, the keys of `models`, the slugs --
 * and STORAGE VOCABULARY EXISTS ONLY INSIDE THE SQL STATEMENTS. The single bridge is
 * `STORAGE_COMPONENT_ID`. MEASURED: validating `components` against `CATALOG_COMPONENT_ID`'s keys
 * (they are STORAGE ids) makes `case_fans` a 400 and the `case_fan` spelling an uncaught
 * TypeError -- a bare 500 with none of `securityHeaders`.
 */

import { componentById, mockLocations } from "../../src/data/catalog";
import { MAX_WATCH_TARGETS } from "../../src/utils/validation";
import type { ComponentType } from "../../src/types";
import { CATALOG_COMPONENT_ID, STORAGE_COMPONENT_ID } from "../normalize/catalogIndex";

export { MAX_WATCH_TARGETS };

/**
 * The legitimate payload is ~400 bytes at the 9-target cap. The bound and its two-step are
 * `worker/api/settings.ts`'s, including what it does NOT bound: a body sent as a ReadableStream
 * carries no Content-Length, so the declared check is skipped and `request.text()` buffers the
 * whole thing before the measured check can fire.
 */
export const MAX_WATCH_BODY_BYTES = 4096;

/**
 * THE CLOSED SET OF MARKETS, derived from the one committed list. The duplicate check is not
 * decoration: two entries sharing a slug at different coordinates would make one Facebook search
 * write into two `market_key` buckets, which splits every price benchmark in that market, and
 * `Map` would silently keep the last one.
 */
export const LOCATION_SLUGS: ReadonlyMap<string, { latitude: number; longitude: number }> = (() => {
  const slugs = new Map<string, { latitude: number; longitude: number }>();
  for (const entry of mockLocations) {
    if (slugs.has(entry.slug)) {
      throw new Error(`watch: duplicate location slug "${entry.slug}"`);
    }
    slugs.set(entry.slug, { latitude: entry.latitude, longitude: entry.longitude });
  }
  return slugs;
})();

const catalogIdOf = (storage: string): ComponentType | null =>
  Object.hasOwn(CATALOG_COMPONENT_ID, storage)
    ? CATALOG_COMPONENT_ID[storage as keyof typeof CATALOG_COMPONENT_ID]
    : null;

const isCatalogModel = (type: ComponentType, query: string): boolean =>
  componentById[type].models.includes(query);

export interface StoredTarget {
  targetId: string;
  componentType: string;
  query: string;
}

export type WireSelection =
  | { mode: "all"; values: []; query: string }
  | { mode: "selected"; values: string[] };

export interface WatchSelection {
  components: ComponentType[];
  models: Record<string, WireSelection>;
  location: { slug: string; latitude: number; longitude: number };
  radiusKm: number;
  preservedTargetIds: string[];
}

export interface WatchBody {
  selection: {
    components: ComponentType[];
    models: Record<string, WireSelection>;
    location: { slug: string; latitude: number; longitude: number } | null;
    radiusKm: number | null;
  };
  storedTargets: StoredTarget[];
  keptSearches: StoredTarget[];
}

export type WatchResult =
  | { ok: true; status: 200; body: WatchBody }
  | { ok: false; status: number; code: string; details?: Record<string, unknown> };

const fail = (status: number, code: string, details?: Record<string, unknown>): WatchResult =>
  details === undefined ? { ok: false, status, code } : { ok: false, status, code, details };

export const slug = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * THE IDENTITY OF A SEARCH: same component type, same query = the same request to Facebook.
 * `target_id` is a NAME, not an identity -- nothing in the repository parses it -- so dedupe and
 * preservation are both decided on this pair and never on the id.
 */
const searchKey = (row: StoredTarget): string => JSON.stringify([row.componentType, row.query]);

/**
 * `mode:"all"` USES THE ECHOED QUERY AND NOTHING IS RE-DERIVED FROM THE CATALOG HERE. MEASURED
 * against production's nine rows with the query dropped: `cpu:'ryzen'` read back as `mode:"all"`
 * and was rewritten to `cpu:'cpu'` on save -- 9 rows went to 6 with
 * `QUERIES LOST: ["ddr4 ram","radeon","rtx","ryzen"]`, returned as 200.
 */
export const deriveTargets = (selection: WatchSelection): StoredTarget[] => {
  const derived: StoredTarget[] = [];
  for (const type of selection.components) {
    const choice = selection.models[type];
    const queries = choice.mode === "all" ? [choice.query] : choice.values;
    for (const query of queries) {
      derived.push({
        targetId: `${type}-${slug(query)}`,
        componentType: STORAGE_COMPONENT_ID[type],
        query,
      });
    }
  }
  return derived;
};

/**
 * THE INVERSION (THE COMPLEMENT RULE): a target whose `query` is NOT a catalog model name OF ITS
 * OWN TYPE is a broad target, and it carries that STORED query back on the wire. There is no
 * `searchTerm` comparison anywhere, which is what stops those nine strings becoming the persisted
 * format's discriminator -- changing one then costs one string and no data migration.
 *
 * Rows arrive `ORDER BY target_id` and THE FIRST ROW OF A TYPE DECIDES THAT TYPE'S MODE; a later
 * row of the other kind goes to the residue. MEASURED: 0 of 336 single-model selections and 0 of
 * 9 broad terms mis-invert.
 */
export const invert = (
  rows: readonly StoredTarget[],
): { components: ComponentType[]; models: Record<string, WireSelection>; residue: StoredTarget[] } => {
  const models: Record<string, WireSelection> = {};
  const components: ComponentType[] = [];
  const residue: StoredTarget[] = [];
  for (const row of rows) {
    const type = catalogIdOf(row.componentType);
    if (type === null) {
      residue.push(row);
      continue;
    }
    const model = isCatalogModel(type, row.query);
    const current = models[type];
    if (current === undefined) {
      models[type] = model
        ? { mode: "selected", values: [row.query] }
        : { mode: "all", values: [], query: row.query };
      components.push(type);
      continue;
    }
    if (model && current.mode === "selected") {
      current.values.push(row.query);
      continue;
    }
    residue.push(row);
  }
  return { components, models, residue };
};

/**
 * THE SYMMETRIC PRESERVATION RULE. A stored row is preservable when its `query` is NOT a catalog
 * model of its own type -- a broad or hand-written query -- AND the new derivation is not writing
 * it. So a type that moves to `selected`, or is deselected entirely, sends its broad row to the
 * KEPT list instead of having it deleted. Narrowing a type to specific models is the action this
 * whole slice exists to enable; it must not destroy the broad query that type was collecting on.
 *
 * A row whose `component_type` is outside the catalog has no model list, so it is preservable too.
 *
 * THE SERVER RECOMPUTES THIS SET AND REFUSES ANY ID OUTSIDE IT, so a client can neither invent a
 * row nor silently drop one.
 */
export const preservableIds = (
  stored: readonly StoredTarget[],
  derived: readonly StoredTarget[],
): Set<string> => {
  const written = new Set(derived.map(searchKey));
  const preservable = new Set<string>();
  for (const row of stored) {
    const type = catalogIdOf(row.componentType);
    if (type !== null && isCatalogModel(type, row.query)) continue;
    if (written.has(searchKey(row))) continue;
    preservable.add(row.targetId);
  }
  return preservable;
};

/**
 * TWO SLOTS ISSUING THE IDENTICAL REQUEST WHILE THE BUDGET READS "9 of 9" IS A LIE ABOUT THE
 * THING THE BUDGET EXISTS TO PREVENT. Derived wins the slot: it is the row the form can still
 * edit. The budget is counted on the output of this function, not on its input.
 */
export const dedupe = (rows: readonly StoredTarget[]): StoredTarget[] => {
  const seen = new Set<string>();
  const deduped: StoredTarget[] = [];
  for (const row of rows) {
    const key = searchKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
};

/** EXACTLY the five fields the write needs. Anything else is REFUSED, never dropped. */
const TOP_LEVEL_FIELDS = new Set([
  "components",
  "models",
  "location",
  "radiusKm",
  "preservedTargetIds",
]);
const SELECTION_FIELDS = new Set(["mode", "values", "query"]);

type Refusal = { bad: { code: string; details: Record<string, unknown> } };

export const validateSelection = (
  body: Record<string, unknown>,
): WatchSelection | Refusal => {
  const unsupported = Object.keys(body).filter((key) => !TOP_LEVEL_FIELDS.has(key)).sort();
  if (unsupported.length > 0) {
    return { bad: { code: "WATCH_FIELD_UNSUPPORTED", details: { fields: unsupported } } };
  }
  const bad = (field: string, detail?: string): Refusal => ({
    bad: {
      code: "INVALID_WATCH",
      details: { field, ...(detail === undefined ? {} : { detail }) },
    },
  });

  const components = body.components;
  if (!Array.isArray(components) || components.length === 0) return bad("components", "empty");
  const selected = new Set<string>();
  for (const component of components) {
    if (typeof component !== "string" || !Object.hasOwn(componentById, component)) {
      return bad("components", String(component));
    }
    if (selected.has(component)) return bad("components", `duplicate ${component}`);
    selected.add(component);
  }

  const models = body.models;
  if (typeof models !== "object" || models === null || Array.isArray(models)) return bad("models");
  const modelKeys = Object.keys(models);
  if (modelKeys.length !== components.length || modelKeys.some((key) => !selected.has(key))) {
    return bad("models", "keys");
  }
  const selections: Record<string, WireSelection> = {};
  for (const [type, raw] of Object.entries(models as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad(`models.${type}`);

    // AN UNKNOWN KEY INSIDE models[t] IS REFUSED, NOT DROPPED. Dropped-not-refused makes the wire
    // unable to tell "the client echoed a query" from "the client sent nothing", which is the
    // defect SETTINGS_FIELD_UNSUPPORTED exists to prevent, one level down.
    const extra = Object.keys(raw).filter((key) => !SELECTION_FIELDS.has(key)).sort();
    if (extra.length > 0) {
      return {
        bad: {
          code: "WATCH_FIELD_UNSUPPORTED",
          details: { fields: extra.map((key) => `models.${type}.${key}`) },
        },
      };
    }

    const { mode, values, query } = raw as {
      mode?: unknown;
      values?: unknown;
      query?: unknown;
    };
    // `none` IS REFUSED. A `none` type contributes no row, so it cannot survive the round trip --
    // accepting it would silently untick the component on the next load.
    if (mode !== "all" && mode !== "selected") return bad(`models.${type}.mode`, String(mode));
    if (!Array.isArray(values)) return bad(`models.${type}.values`);
    if ((mode === "selected") !== (values.length > 0)) {
      return bad(`models.${type}.values`, "mode-mismatch");
    }

    if (mode === "all") {
      // REQUIRED under `all`: it is the echo, and it is what stops the stored query being
      // rewritten on a save the user did not intend to be an edit.
      if (typeof query !== "string" || query.trim() === "") {
        return bad(`models.${type}.query`, String(query));
      }
      if (isCatalogModel(type as ComponentType, query)) {
        return bad(`models.${type}.query`, "a catalog model name must be sent as mode:selected");
      }
      selections[type] = { mode: "all", values: [], query };
      continue;
    }

    // FORBIDDEN under `selected`: a field with no source in the derivation.
    if (query !== undefined) return bad(`models.${type}.query`, "forbidden under mode:selected");
    for (const value of values) {
      if (typeof value !== "string" || !isCatalogModel(type as ComponentType, value)) {
        return bad(`models.${type}.values`, String(value));
      }
    }
    if (new Set(values as string[]).size !== values.length) {
      return bad(`models.${type}.values`, "duplicate");
    }
    selections[type] = { mode: "selected", values: values as string[] };
  }

  const location = body.location;
  if (typeof location !== "object" || location === null || Array.isArray(location)) {
    return bad("location");
  }
  const { slug: locationSlug, latitude, longitude } = location as Record<string, unknown>;
  if (typeof locationSlug !== "string") return bad("location.slug");
  const known = LOCATION_SLUGS.get(locationSlug);
  // A CLOSED SET, NOT A PATTERN. MEASURED: slugifying the original 42 labels produced 42 strings
  // that ALL pass both LOCATION_PATTERN and the schema GLOB, including
  // `100-front-street-w-toronto-on-m5j-1e3` -- a URL Facebook will never serve.
  if (known === undefined) return bad("location.slug", locationSlug);
  // The coordinates must AGREE with the slug: `market_key` is built from the coordinates and the
  // Facebook search from the slug, so a disagreement collects one market into another's bucket.
  if (latitude !== known.latitude || longitude !== known.longitude) {
    return bad("location", "coordinates");
  }

  const radiusKm = body.radiusKm;
  if (
    typeof radiusKm !== "number" ||
    !Number.isInteger(radiusKm) ||
    radiusKm < 1 ||
    radiusKm > 25
  ) {
    // `Number.isInteger` is load-bearing: `migrations/0005`'s own CHECK is
    // `typeof(radius_km) = 'integer'`, because SQLite INTEGER is affinity. Without it 12.5
    // reaches that CHECK and surfaces as a 503 -- "the service is broken" for an unstorable input.
    return bad("radiusKm", String(radiusKm));
  }

  // REQUIRED. ABSENT IS A 400 AND IS NEVER DEFAULTED TO []. Defaulting it turns any save from a
  // client that does not know about the field into a silent delete of every kept search -- rows
  // the form cannot display and the user never consented to lose.
  const preserved = body.preservedTargetIds;
  if (!Array.isArray(preserved)) return bad("preservedTargetIds", "required");
  for (const id of preserved) {
    if (typeof id !== "string") return bad("preservedTargetIds", String(id));
  }
  if (new Set(preserved as string[]).size !== preserved.length) {
    return bad("preservedTargetIds", "duplicate");
  }

  return {
    components: components as ComponentType[],
    models: selections,
    location: { slug: locationSlug, latitude: known.latitude, longitude: known.longitude },
    radiusKm,
    preservedTargetIds: preserved as string[],
  };
};

const SELECT_MARKET = `SELECT location, latitude, longitude, radius_km
  FROM watch_market WHERE id = 1`;

/** `ORDER BY target_id` is what makes the inversion's first-row-wins rule deterministic. */
const SELECT_TARGETS = `SELECT target_id, component_type, query
  FROM watch_targets ORDER BY target_id`;

/**
 * THE DELETE KEEPS THE KEPT ROWS AND THE INSERT WRITES ONLY THE DERIVED ONES. Deleting everything
 * outside the final set and then re-inserting all of it looks tidier and is WRONG: a kept row
 * survives the DELETE and then collides with its own re-INSERT on the PRIMARY KEY, landing in the
 * catch as WATCH_STORAGE_FAILED on every save that keeps anything.
 */
const DELETE_SCOPED = `DELETE FROM watch_targets
  WHERE target_id NOT IN (SELECT value FROM json_each(?1))`;
const INSERT_TARGET = `INSERT INTO watch_targets (target_id, component_type, query)
  VALUES (?1, ?2, ?3)`;
/**
 * PINNED TO THE LITERAL 1 (the POINT_AT idiom), so `watch_market`'s singleton invariant holds in
 * the statement as well as in the `CHECK (id = 1)`.
 */
const UPSERT_MARKET = `INSERT INTO watch_market (id, location, latitude, longitude, radius_km)
       VALUES (1, ?1, ?2, ?3, ?4)
  ON CONFLICT(id) DO UPDATE SET location = ?1, latitude = ?2, longitude = ?3, radius_km = ?4`;

interface TargetRow {
  target_id: string;
  component_type: string;
  query: string;
}

interface MarketRow {
  location: string;
  latitude: number;
  longitude: number;
  radius_km: number;
}

const readStoredTargets = async (db: D1Database): Promise<StoredTarget[]> => {
  const read = await db.prepare(SELECT_TARGETS).all<TargetRow>();
  return read.results.map((row) => ({
    targetId: row.target_id,
    componentType: row.component_type,
    query: row.query,
  }));
};

const readState = async (db: D1Database): Promise<WatchBody> => {
  const market = await db.prepare(SELECT_MARKET).all<MarketRow>();
  const stored = await readStoredTargets(db);
  const inverted = invert(stored);
  const row = market.results[0];
  return {
    selection: {
      components: inverted.components,
      models: inverted.models,
      // `null` when the singleton row is absent -- a reachable state (someone can DELETE it) and
      // an explicit one.
      location:
        row === undefined
          ? null
          : { slug: row.location, latitude: row.latitude, longitude: row.longitude },
      // `null`, NEVER 0: no layer accepts a radius of 0, so a 0 here would load the form already
      // invalid with no user action.
      radiusKm: row === undefined ? null : row.radius_km,
    },
    // EVERY stored row verbatim, so the client knows each row's id and can decide what to keep.
    storedTargets: stored,
    // The rows the inversion could not place -- the residue the form shows as kept searches.
    keptSearches: inverted.residue,
  };
};

export const handleGetWatch = async (db: D1Database): Promise<WatchResult> => {
  // WITHOUT THIS READ THE FORM STARTS FROM `initialSettings` AND THE FIRST SAVE REPLACES LIVE
  // CONFIGURATION. The read is what makes the write safe.
  try {
    return { ok: true, status: 200, body: await readState(db) };
  } catch {
    return fail(503, "WATCH_TARGETS_STORAGE_FAILED");
  }
};

export const handlePutWatch = async (request: Request, db: D1Database): Promise<WatchResult> => {
  const mediaType = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") return fail(415, "UNSUPPORTED_MEDIA_TYPE");

  // The DECLARED size, refused before the body is pulled into the isolate.
  const declared = Number.parseInt(request.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_WATCH_BODY_BYTES) {
    return fail(413, "PAYLOAD_TOO_LARGE");
  }

  // The MEASURED size. Content-Length is a claim: absent on a chunked body, and a lie is free.
  // The try/catch is what keeps the comment above true -- a client that disconnects mid-PUT
  // rejects here, and unwrapped it would throw out of handleRequest as a bare 500 carrying none
  // of securityHeaders.
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return fail(400, "INVALID_JSON");
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_WATCH_BODY_BYTES) {
    return fail(413, "PAYLOAD_TOO_LARGE");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail(400, "INVALID_JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail(400, "INVALID_JSON");
  }

  return applyWatchSelection(parsed as Record<string, unknown>, db);
};

/**
 * The validate-derive-preserve-budget-write pipeline, separated from the body read so that the
 * tests which are ABOUT the pipeline do not have to build a Request -- and so that the ones about
 * the body read exercise `handlePutWatch` itself.
 */
export const applyWatchSelection = async (
  body: Record<string, unknown>,
  db: D1Database,
): Promise<WatchResult> => {
  const selection = validateSelection(body);
  if ("bad" in selection) return fail(400, selection.bad.code, selection.bad.details);

  // THERE IS NO "ZERO TARGETS DERIVE" BRANCH. `components` is non-empty and every accepted mode
  // yields at least one query, so `derived.length >= 1` always; a branch no body can reach cannot
  // have a test written for it.
  const derived = deriveTargets(selection);

  let stored: StoredTarget[];
  try {
    stored = await readStoredTargets(db);
  } catch {
    // DISTINCT FROM THE WRITE CODE BELOW: this one means the READ failed, and its message says
    // "could not be read". Two different fixes behind one code sends an operator to the wrong one.
    return fail(503, "WATCH_TARGETS_STORAGE_FAILED");
  }

  const preservable = preservableIds(stored, derived);
  const offending = selection.preservedTargetIds.find((id) => !preservable.has(id));
  if (offending !== undefined) {
    return fail(400, "INVALID_WATCH", { field: "preservedTargetIds", detail: offending });
  }
  const kept = stored.filter((row) => selection.preservedTargetIds.includes(row.targetId));

  // THE COLLISION IS REFUSED BEFORE THE BATCH, NAMING THE FIELD AND THE ID. An unguarded
  // `UNIQUE constraint failed` surfaces as WATCH_STORAGE_FAILED -- "the write failed" for a save
  // that was simply impossible, with two different fixes behind one code.
  const keptIds = new Set(kept.map((row) => row.targetId));
  for (const row of derived) {
    if (!keptIds.has(row.targetId)) continue;
    const type = catalogIdOf(row.componentType) ?? row.componentType;
    const choice = selection.models[type];
    const field =
      choice !== undefined && choice.mode === "selected"
        ? `models.${type}.values`
        : `models.${type}.query`;
    return fail(400, "INVALID_WATCH", {
      field,
      detail: `${row.targetId} collides with a kept search`,
    });
  }

  const final = dedupe([...derived, ...kept]);
  if (final.length > MAX_WATCH_TARGETS) {
    // THE SPLIT IS PART OF THE ANSWER, not decoration: under the symmetric preservation rule
    // DESELECTING A COMPONENT DOES NOT FREE A SLOT -- it converts a derived slot into a kept one.
    // `derived`/`kept` is what tells the UI to say "remove a kept search", which is the only
    // action that does free budget.
    return fail(400, "WATCH_TARGETS_EXCEEDED", {
      targets: final.length,
      maximum: MAX_WATCH_TARGETS,
      derived: derived.length,
      kept: kept.length,
    });
  }

  // ONE BATCH, so a failing statement rolls the DELETE back and a half-written watch list is
  // unreachable. Bounds: <= 11 statements, <= 4 bound parameters each, against the MEASURED D1
  // ceiling of 100 parameters.
  const keptFinalIds = final.filter((row) => keptIds.has(row.targetId)).map((row) => row.targetId);
  const toInsert = final.filter((row) => !keptIds.has(row.targetId));
  try {
    await db.batch([
      db.prepare(DELETE_SCOPED).bind(JSON.stringify(keptFinalIds)),
      ...toInsert.map((row) =>
        db.prepare(INSERT_TARGET).bind(row.targetId, row.componentType, row.query),
      ),
      db
        .prepare(UPSERT_MARKET)
        .bind(
          selection.location.slug,
          selection.location.latitude,
          selection.location.longitude,
          selection.radiusKm,
        ),
    ]);
  } catch {
    return fail(503, "WATCH_STORAGE_FAILED");
  }

  // RE-READ FROM D1, NEVER ECHOED: the response then reports what IS STORED. No `changed` flag --
  // there is no revision to protect here, so computing one would cost a read-before for a
  // cosmetic field.
  try {
    return { ok: true, status: 200, body: await readState(db) };
  } catch {
    return fail(503, "WATCH_TARGETS_STORAGE_FAILED");
  }
};
