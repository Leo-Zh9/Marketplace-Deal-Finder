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

export interface PreviewResult {
  listings: Listing[];
  truncated: boolean;
  searchedAt: string;
}

/**
 * WHAT `GET /api/status` REPORTS ABOUT COLLECTION, and it is the user's ONLY notification
 * channel: no email, no push -- the web page IS the alert.
 *
 * THE HISTORY THIS TYPE HAS TO SURVIVE. A monitoring panel was deleted from this app wholesale
 * because NOTHING WROTE THE VALUE IT DISPLAYED: it read "Not running / Stopped" forever, beside a
 * sentence promising a 30-minute collector. So the rule for every field here is that a real
 * writer puts it there -- `collector/runTargets.ts` posts one report per run line -- and the panel
 * renders NO field the writer does not write.
 *
 * `collector` IS `null` WHEN NOTHING HAS EVER REPORTED, which is a state the panel names in
 * words ("No collector run has reported yet") rather than rendering as "Stopped". That string is
 * exactly what the old panel was deleted for.
 */
export interface CollectionStatus {
  /** `stopped` is the operator's own Stop, and it outranks every health word. */
  status: "ok" | "stale" | "degraded" | "unknown" | "stopped";
  /** Whichever `degraded` clauses fired, as a set. Empty on `ok`, `stale` and `unknown`. */
  causes: string[];
  /** Unix SECONDS, the SERVER's clock. 0 when nothing has reported. */
  reportedAt: number;
  ageMinutes: number;
  collector: {
    exitCode: number;
    complete: boolean;
    /** The volume cut is engaged: strictly fewer searches ran than the watch list holds. */
    canary: boolean;
    dryRun: boolean;
    fixture: boolean;
    /** The count the SERVER returned, never the count that ran. The panel's "of N". */
    targets: number;
    alarms: string[];
  } | null;
  /**
   * DISCORD ALERTS, from `worker/notify/status.ts`. ABSENT on an API Worker older than the
   * notifications backend, and the page then renders no alert line at all. `unreadable` is NOT a
   * wire state: the client substitutes it for a field that is present but malformed, so a bad
   * field costs the alert line and never the panel. See `marketplaceClient.getStatus`.
   */
  notifications?: NotificationsStatus | { state: "unreadable" };
  /**
   * START/STOP, migrations/0008. ABSENT on an API Worker older than the controls, and the page
   * then renders no Start/Stop button at all -- it cannot know which one to show. `null` is the
   * Worker saying its read failed, which renders no button either. The button's label comes from
   * this field and nothing else, never from what the user last clicked.
   */
  monitoring?: MonitoringState | null;
}

export interface MonitoringState {
  state: "running" | "stopped";
  /** Unix SECONDS of the last real change; 0 means never changed. */
  changedAt: number;
}

/** The counts `/api/status` carries for `on` and `webhook-rejected` only. */
export interface NotificationCounts {
  /** PENDING plus SENDING (in flight). */
  pending: number;
  /** SENT in the last 24 hours -- a rolling window, not a calendar day. */
  sent24h: number;
  deliveryUnknown: number;
  failed: number;
  /** Epoch seconds, or null when nothing was ever sent. */
  lastSentAt: number | null;
}

/**
 * `notifications` exactly as the Worker sends it. `{state: "on"}` with no counts is real: it is
 * what the Worker answers when the notifications table could not be read.
 */
export type NotificationsStatus =
  | { state: "unconfigured" | "invalid-url" | "off" }
  | { state: "on" }
  | ({ state: "on" | "webhook-rejected" } & NotificationCounts);
