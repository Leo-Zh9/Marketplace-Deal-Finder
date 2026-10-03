/**
 * THE BROWSER'S HALF OF THE WATCH-LIST RULES, WITH NO TRANSPORT IN IT. It lives apart from
 * `marketplaceClient.ts` for one measured reason: `worker/api/watch.test.ts` imports these helpers
 * so that the suite runs the REAL client against the REAL handler instead of a copy of the rule, and
 * importing them through the transport module pulled `apiClient`'s `import.meta.env` into the
 * WORKER tsc program, which has no `vite/client` types (`Property 'env' does not exist on type
 * ImportMeta`). The same cost `src/utils/validation.test.ts` records in the other direction.
 *
 * So: nothing here may import `fetch`, `apiClient`, or anything that reads `import.meta`. Its only
 * dependencies are the catalog, the shared types and the validator's pure helpers.
 *
 * THERE ARE EXACTLY TWO IMPLEMENTATIONS OF THE PRESERVATION RULE AND THERE SHOULD BE TWO: the
 * server's `preservableIds` in `worker/api/watch.ts`, which is the authority and refuses any id
 * outside its own set, and this one, which the form needs locally to render the budget and the kept
 * list before it sends anything. A THIRD copy in `scripts/e2e-local.sh` is what let a two-save data
 * loss through review: it had diverged, missing the "is this query a catalog model of its type?"
 * term, so it preserved a row the real client discards. That copy is gone -- the gate echoes the
 * wire's own `keptSearches`, and `W-kept-agree` pins that the two agree.
 */

import { componentById } from "../data/catalog";
import { allSelection } from "../utils/validation";
import type { ComponentType, ModelSelection, SearchSettings } from "../types";

export interface StoredTarget {
  targetId: string;
  componentType: string;
  query: string;
}

/** The body `PUT /api/watch` takes. Catalog vocabulary throughout; storage ids never appear. */
export interface WatchSaveBody {
  components: ComponentType[];
  models: Record<string, { mode: "all" | "selected"; values: string[]; query?: string }>;
  location: { slug: string; latitude: number; longitude: number };
  radiusKm: number;
  preservedTargetIds: string[];
}

/** The query a `mode:"all"` type searches with: the stored one, else the catalog's `searchTerm`. */
export const queryFor = (
  component: ComponentType,
  queries: Partial<Record<ComponentType, string>>,
): string => queries[component] ?? componentById[component].searchTerm;

export const watchModelsFor = (
  components: readonly ComponentType[],
  models: Partial<Record<ComponentType, ModelSelection>>,
  queries: Partial<Record<ComponentType, string>>,
): WatchSaveBody["models"] => {
  const wire: WatchSaveBody["models"] = {};
  for (const component of components) {
    const selection = models[component] ?? allSelection();
    // `values` IS EMPTY UNDER `all` and the query travels instead; `query` is FORBIDDEN under
    // `selected`. Both halves are refused on the wire, not coerced.
    wire[component] =
      selection.mode === "selected"
        ? { mode: "selected", values: selection.values }
        : { mode: "all", values: [], query: queryFor(component, queries) };
  }
  return wire;
};

/**
 * THE CLIENT HALF OF THE SYMMETRIC PRESERVATION RULE, RECOMPUTED LIVE AND NOT READ FROM THE LAST
 * GET. A stored row is preservable when its query is not a catalog model of its own type AND the
 * current selection is not writing it -- so narrowing a type, or deselecting it, MOVES that type's
 * broad row into this set. Rendering the GET's `keptSearches` instead would under-count the budget
 * by exactly those rows: the form would read "9 of 9" and the server would refuse at 10.
 *
 * A STORED ROW WHOSE QUERY IS A CATALOG MODEL OF ITS TYPE IS NOT PRESERVABLE, because the form can
 * re-author that exact search as `mode:"selected"` -- and `worker/api/watch.ts`'s inversion now
 * guarantees it DOES: a type with any model-named row comes back as `mode:"selected"` carrying all
 * of them, so an untouched save rewrites every one. An earlier version of this comment claimed the
 * leftover case was "reachable only from a hand-written row"; it was reachable from the feature
 * itself, cost nine rows two saves in, and `W-twice` is the regression test.
 *
 * WHAT REMAINS, AND IT IS DELIBERATE: deselecting a type drops its MODEL searches while preserving
 * its broad one. That asymmetry is the rule stated forwards -- a model-named search is one click to
 * re-author, a free-text query is unauthorable from this form at all -- and the kept-searches list
 * is where the surviving half is visible.
 */
export const preservableTargets = (
  storedTargets: readonly StoredTarget[],
  components: readonly ComponentType[],
  models: Partial<Record<ComponentType, ModelSelection>>,
  queries: Partial<Record<ComponentType, string>>,
): StoredTarget[] => {
  const written = new Set<string>();
  for (const [component, selection] of Object.entries<WatchSaveBody["models"][string]>(
    watchModelsFor(components, models, queries),
  )) {
    const values = selection.mode === "selected" ? selection.values : [selection.query ?? ""];
    for (const query of values) written.add(JSON.stringify([component, query]));
  }
  return storedTargets.filter((row) => {
    // The wire is catalog vocabulary; `watch_targets.component_type` is storage vocabulary, and
    // `case_fan` is the one id that differs.
    const type = row.componentType === "case_fan" ? "case_fans" : row.componentType;
    const isModel =
      Object.hasOwn(componentById, type) &&
      componentById[type as ComponentType].models.includes(row.query);
    return !isModel && !written.has(JSON.stringify([type, row.query]));
  });
};

/**
 * THE PREVIEW'S SELECTION, AS A QUERY STRING THE SERVER FILTERS ON. `?all` carries the catalog ids
 * whose selection is `mode:"all"` and `?pairs` the `type/model` pairs for `mode:"selected"`; both
 * are always sent, because `?pairs` with `?all` ABSENT is a 400 (measured: the pairs would
 * otherwise be a silent no-op). Built with `URLSearchParams`, never by hand.
 */
export const verdictsQuery = (settings: SearchSettings): string => {
  const all: string[] = [];
  const pairs: string[] = [];
  for (const component of settings.components) {
    const selection = settings.models[component] ?? allSelection();
    if (selection.mode === "all") all.push(component);
    // `none` contributes to neither list: App unticks the component the moment a selection
    // empties, so this is a transient state rather than a selection.
    if (selection.mode === "selected") {
      for (const model of selection.values) pairs.push(`${component}/${model}`);
    }
  }
  const params = new URLSearchParams();
  params.set("all", JSON.stringify(all));
  params.set("pairs", JSON.stringify(pairs));
  return params.toString();
};

