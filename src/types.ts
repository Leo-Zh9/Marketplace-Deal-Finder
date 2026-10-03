export type ComponentType =
  | "cpu"
  | "cpu_cooler"
  | "motherboard"
  | "ram"
  | "storage"
  | "gpu"
  | "psu"
  | "case"
  | "case_fans";

export type DealRuleType = "discount" | "maximum_price" | "both";

export type EvaluationStatus =
  | "DEAL"
  | "NOT_DEAL"
  | "NEEDS_REVIEW"
  | "PENDING";

export type MonitoringState =
  | "STOPPED"
  | "STARTING"
  | "ACTIVE"
  | "DEGRADED"
  | "ERROR";

export interface SearchLocation {
  label: string;
  /**
   * REQUIRED, not optional, and that is the whole guard. `slug` is the Facebook URL path segment
   * `PUT /api/watch` stores in `watch_market.location`; an optional field would let a caller
   * build a location object the write refuses at runtime. Required makes it a `tsc` error
   * instead -- the argument `src/App.tsx`'s `getToken` prop already makes for itself.
   */
  slug: string;
  latitude: number;
  longitude: number;
}

/**
 * `none` IS UI-TRANSIENT AND NEVER CROSSES THE WIRE. A `none` type contributes no watch_targets
 * row, so it cannot survive the round trip -- accepting it on the wire would silently untick the
 * component on the next load. `src/App.tsx` unticks the component the moment a selection empties,
 * which is why this mode exists only between the ModelSelector's onChange and that handler.
 *
 * `values` IS EMPTY UNDER `all`. The wire invariant is "non-empty iff mode is selected", and the
 * shipped code broke it at four separate sites by writing `[...component.models]` here.
 */
export interface ModelSelection {
  mode: "all" | "none" | "selected";
  values: string[];
}

export interface DealRule {
  type: DealRuleType;
  minimumDiscountPercent: number;
  maximumPriceCad: string;
}

export interface SearchSettings {
  components: ComponentType[];
  models: Partial<Record<ComponentType, ModelSelection>>;
  /**
   * The query a `mode:"all"` type searches with -- THE STORED ONE, echoed back from
   * `GET /api/watch`, falling back to the catalog's `searchTerm` for a type with no stored row.
   * It is held here rather than inside `ModelSelection` so that re-ticking "Select all models"
   * cannot drop it: production's nine rows ARE free-text queries, and rewriting `ryzen` to `cpu`
   * on a save is the defect the echo exists to prevent.
   */
  queries: Partial<Record<ComponentType, string>>;
  location: SearchLocation | null;
  radiusKm: number;
  dealRule: DealRule;
}

export interface Listing {
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
    status: EvaluationStatus;
    averagePriceCents?: number;
    discountPercent?: number;
  };
}

export interface MonitoringStatus {
  state: MonitoringState;
  provider: "AVAILABLE" | "DEGRADED" | "UNAVAILABLE";
  lastSuccessfulScanAt: string | null;
  nextScanAt: string | null;
}

export interface PreviewResult {
  listings: Listing[];
  truncated: boolean;
  searchedAt: string;
}
