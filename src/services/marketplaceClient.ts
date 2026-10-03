import { requestJsonWithAuth } from "./apiClient";
import { allSelection } from "../utils/validation";
import { componentById } from "../data/catalog";
import type {
  ComponentType,
  DealRule,
  Listing,
  ModelSelection,
  MonitoringStatus,
  PreviewResult,
  SearchSettings,
} from "../types";

type GetToken = (forceRefresh: boolean) => Promise<string | null>;

/** `search_revisions`' three columns, which are exactly `PUT /api/settings`' ACCEPTED_FIELDS. */
export type DealMode = "DISCOUNT" | "MAXIMUM_PRICE" | "BOTH";

export interface WireSettings {
  mode: DealMode;
  minimumDiscountPercent: number | null;
  maximumPriceCents: number | null;
  searchRevision?: number;
}

export interface StoredTarget {
  targetId: string;
  componentType: string;
  query: string;
}

export interface WatchWire {
  selection: {
    components: ComponentType[];
    models: Partial<Record<ComponentType, { mode: "all" | "selected"; values: string[]; query?: string }>>;
    location: { slug: string; latitude: number; longitude: number } | null;
    radiusKm: number | null;
  };
  storedTargets: StoredTarget[];
  keptSearches: StoredTarget[];
}

export interface WatchSaveBody {
  components: ComponentType[];
  models: Record<string, { mode: "all" | "selected"; values: string[]; query?: string }>;
  location: { slug: string; latitude: number; longitude: number };
  radiusKm: number;
  preservedTargetIds: string[];
}

export interface MarketplaceClient {
  preview(settings: SearchSettings, getToken: GetToken): Promise<PreviewResult>;
  getWatch(getToken: GetToken): Promise<WatchWire>;
  saveWatch(body: WatchSaveBody, getToken: GetToken): Promise<WatchWire>;
  getSettings(getToken: GetToken): Promise<WireSettings | null>;
  saveDealRule(rule: DealRule, getToken: GetToken): Promise<void>;
  getMonitoringStatus(): Promise<MonitoringStatus>;
}

interface VerdictsResponse {
  listings: Listing[];
  truncated: boolean;
}

const wait = (duration = 450) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, duration));

const getMockScenario = () =>
  new URLSearchParams(window.location.search).get("scenario");

const stoppedStatus = (): MonitoringStatus => ({
  state: "STOPPED",
  provider: "AVAILABLE",
  lastSuccessfulScanAt: null,
  nextScanAt: null,
});

let monitoringStatus: MonitoringStatus = stoppedStatus();

/**
 * Clears client-side state belonging to the previous identity. `AuthGate` calls it on every
 * identity change; the monitoring LIFECYCLE it used to roll back is gone -- the browser never
 * started collection, the Cron does -- and what remains is the read `StatusPanel` renders.
 */
export const resetMarketplaceState = () => {
  monitoringStatus = stoppedStatus();
};

/* ---------- the deal rule, BOTH directions ---------- */

/**
 * `Math.round` IS LOAD-BEARING, AND THE TEST VALUE IS THE WHOLE TEST. MEASURED over 500,000
 * two-decimal prices: 65,628 of them (13.1%) give a non-integer product -- the first at or above
 * $600 is `600.05 -> 60004.99999999999` -- and `Math.round` recovers the exact cents for all
 * 500,000. Without it the wire carries a non-integer, `validateSettings` gates on
 * `Number.isSafeInteger` and `handlePutSettings` answers 400 INVALID_SETTINGS, so Save fails for
 * one price in eight. `749.99 * 100` is EXACTLY 74999, so the obvious test value does not kill
 * the mutation and no `.99` price between $600 and $1000 breaks at all.
 */
export const dealRuleToSettings = (rule: DealRule): WireSettings => ({
  mode:
    rule.type === "discount" ? "DISCOUNT" : rule.type === "maximum_price" ? "MAXIMUM_PRICE" : "BOTH",
  minimumDiscountPercent: rule.type === "maximum_price" ? null : rule.minimumDiscountPercent,
  maximumPriceCents:
    rule.type === "discount" ? null : Math.round(Number(rule.maximumPriceCad) * 100),
});

/**
 * THE INVERSE, AND IT IS THE HIGHEST-CONSEQUENCE MAPPER IN THE SLICE. Without it the form starts
 * at `initialSettings`' 25%, Save PUTs unconditionally, `updateSearchSettings` compares
 * projections, 10 !== 25, and `CLAIM_STALE_REVISION` RE-OPENS EVERY EVALUATION TASK IN THE CORPUS
 * -- 348 of them in production -- while the operator's threshold silently becomes a number they
 * never typed. MEASURED: seeded at 10%, an untouched Save answers `changed:false`, revisions 1->1,
 * 0 tasks re-opened; without the seed it sends 25 and re-opens 3 of 3.
 *
 * `settings === null` KEEPS THE CALLER'S DEFAULT rather than inventing one: a database that was
 * never configured must not read as "DISCOUNT 0%".
 *
 * THE PER-FIELD FALLBACK IS NOT DEFENSIVE PADDING. `worker/search/settings.ts` warns that the
 * field a mode makes INERT is NOT IN THE ROW -- it comes back `null` -- so without the fallback,
 * switching from MAXIMUM_PRICE to BOTH would land on a discount of `null`.
 */
export const settingsToDealRule = (
  settings: WireSettings | null,
  fallback: DealRule,
): DealRule => {
  if (settings === null) return fallback;
  return {
    type:
      settings.mode === "DISCOUNT"
        ? "discount"
        : settings.mode === "MAXIMUM_PRICE"
          ? "maximum_price"
          : "both",
    minimumDiscountPercent: settings.minimumDiscountPercent ?? fallback.minimumDiscountPercent,
    maximumPriceCad:
      settings.maximumPriceCents === null
        ? fallback.maximumPriceCad
        : (settings.maximumPriceCents / 100).toFixed(2),
  };
};

/* ---------- the watch list ---------- */

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
 * THE LIMIT, STATED: a stored row whose query IS a catalog model of its type is NOT preservable,
 * because the form can re-author that exact search as `mode:"selected"`. For a type whose mode the
 * inversion decided as `all` (the first row by `target_id` wins), such a row is therefore dropped
 * by a save until the user narrows that type. Production holds no model-named rows, so this is
 * reachable only from a hand-written one.
 */
export const preservableTargets = (
  storedTargets: readonly StoredTarget[],
  components: readonly ComponentType[],
  models: Partial<Record<ComponentType, ModelSelection>>,
  queries: Partial<Record<ComponentType, string>>,
): StoredTarget[] => {
  const written = new Set<string>();
  for (const [component, selection] of Object.entries(
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

export const marketplaceClient: MarketplaceClient = {
  /**
   * THE FILTER RUNS ON THE SERVER NOW, AND THE CLIENT-SIDE ONE IS DELETED. That deletion is what
   * closes PR #17's defect: the browser filter ran AFTER the server's `LIMIT 50`, so a bounded
   * page of a component the user does not watch filtered down to nothing and the page reported a
   * non-empty database as empty. The `WHERE` is what makes the deletion correct, not what closes
   * the defect.
   */
  async preview(settings, getToken) {
    const body = await requestJsonWithAuth<VerdictsResponse>(
      `/api/verdicts?${verdictsQuery(settings)}`,
      getToken,
    );

    return {
      listings: body.listings,
      truncated: body.truncated,
      searchedAt: new Date().toISOString(),
    };
  },

  getWatch(getToken) {
    return requestJsonWithAuth<WatchWire>("/api/watch", getToken);
  },

  saveWatch(body, getToken) {
    return requestJsonWithAuth<WatchWire>("/api/watch", getToken, { method: "PUT", body });
  },

  async getSettings(getToken) {
    const body = await requestJsonWithAuth<{ settings: WireSettings | null }>(
      "/api/settings",
      getToken,
    );
    return body.settings;
  },

  async saveDealRule(rule, getToken) {
    await requestJsonWithAuth("/api/settings", getToken, {
      method: "PUT",
      body: dealRuleToSettings(rule),
    });
  },

  async getMonitoringStatus() {
    await wait(100);
    if (getMockScenario() === "unavailable") {
      return { ...monitoringStatus, provider: "UNAVAILABLE" };
    }
    return monitoringStatus;
  },
};
