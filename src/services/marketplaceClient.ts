import { ApiRequestError } from "../auth/authTypes";
import { requestJsonWithAuth } from "./apiClient";
/**
 * THE SELECTION RULES LIVE IN `./watchSelection`, not here, so that `worker/api/watch.test.ts` can
 * run the REAL client rule against the REAL handler without dragging `apiClient`'s `import.meta.env`
 * into the Worker's tsc program. See that file's header.
 */
import { verdictsQuery, type StoredTarget, type WatchSaveBody } from "./watchSelection";
import type {
  CollectionStatus,
  ComponentType,
  MonitoringState,
  DealRule,
  Listing,
  NotificationsStatus,
  PreviewResult,
  SearchSettings,
} from "../types";

export type { StoredTarget, WatchSaveBody } from "./watchSelection";

type GetToken = (forceRefresh: boolean) => Promise<string | null>;

/**
 * `stopped` IS HERE BECAUSE THE CHECK IS STRICT, and an old dashboard is exactly what proves it: a
 * page built before Start/Stop rejects the word and shows "could not be read" -- with no Start
 * button to undo it. docs/phase-3e-monitoring.md says to Start before rolling the dashboard back.
 */
const STATUS_WORDS: readonly string[] = ["ok", "stale", "degraded", "unknown", "stopped"];

/**
 * THE STATUS BODY IS CHECKED, NOT CAST, BECAUSE THE PAGE AND THE API DEPLOY SEPARATELY. The
 * pre-alerting Worker answers `{status:"ok", phase:2, authentication}`: a known word, but no
 * `causes` and no `collector`. Cast through, `status.causes.length` threw inside the panel's
 * render, and with no error boundary in `src/` the whole dashboard went blank. That happens on a
 * frontend deployed first, a failed API deploy, or an API rollback. Checked here, a bad body is
 * a failed poll, and the panel says the status could not be read. Only the fields the page
 * renders are checked; extra fields pass through untouched.
 */
const isCollectionStatus = (body: unknown): body is CollectionStatus => {
  if (typeof body !== "object" || body === null) return false;
  const fields = body as Record<string, unknown>;
  if (typeof fields.status !== "string" || !STATUS_WORDS.includes(fields.status)) return false;
  if (!Array.isArray(fields.causes) || !fields.causes.every((cause) => typeof cause === "string")) {
    return false;
  }
  if (typeof fields.reportedAt !== "number" || typeof fields.ageMinutes !== "number") return false;
  if (fields.collector === null) return true;
  if (typeof fields.collector !== "object" || fields.collector === undefined) return false;
  const collector = fields.collector as Record<string, unknown>;
  return typeof collector.canary === "boolean" && typeof collector.targets === "number";
};

const COUNT_FIELDS = ["pending", "sent24h", "deliveryUnknown", "failed"] as const;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * `notifications` IS CHECKED SEPARATELY FROM THE REST OF THE BODY, AND A BAD ONE IS NOT A FAILED
 * POLL. It is one line of the panel, so it must not be able to cost the whole panel -- #20's F1
 * lesson, one level down. `on` and `webhook-rejected` must carry ALL the counts or (for `on`
 * only, the Worker's answer when its table read fails) NONE: a half-present set would render a
 * number the Worker did not send.
 *
 * IT RETURNS A REBUILT VALUE, NEVER THE ONE IT WAS GIVEN, so nothing unchecked reaches the panel.
 * An inert state is `{state}` alone; a counted state is its checked fields only. Review D found
 * why: `{state: "off", sent24h: {toString: null, valueOf: null}}` passed an inert-state check that
 * looked only at `state`, and the panel's string-building threw a TypeError that unmounted the
 * app. `null` means present but malformed.
 */
const checkNotifications = (value: unknown): NotificationsStatus | null => {
  if (typeof value !== "object" || value === null) return null;
  const fields = value as Record<string, unknown>;
  const { state } = fields;
  if (state === "unconfigured" || state === "invalid-url" || state === "off") return { state };
  if (state !== "on" && state !== "webhook-rejected") return null;
  if (![...COUNT_FIELDS, "lastSentAt"].some((field) => field in fields)) {
    return state === "on" ? { state } : null;
  }
  const { pending, sent24h, deliveryUnknown, failed, lastSentAt } = fields;
  if (!isCount(pending) || !isCount(sent24h) || !isCount(deliveryUnknown) || !isCount(failed)) {
    return null;
  }
  if (lastSentAt !== null && !isCount(lastSentAt)) return null;
  return { state, pending, sent24h, deliveryUnknown, failed, lastSentAt };
};

/**
 * ABSENT STAYS ABSENT: an API Worker older than the notifications backend sends no field, and the
 * page renders as it did before it existed. PRESENT AND MALFORMED becomes `{state: "unreadable"}`,
 * which the panel names in words. Valid comes back rebuilt from its checked fields.
 */
const withCheckedNotifications = (status: CollectionStatus): CollectionStatus => {
  if (status.notifications === undefined) return status;
  return { ...status, notifications: checkNotifications(status.notifications) ?? { state: "unreadable" } };
};

/**
 * `monitoring` IS CHECKED APART FROM THE BODY, LIKE `notifications`, and a bad one costs only the
 * button. Absent stays absent (an older Worker); `null` stays null (the Worker's read failed); a
 * valid value comes back REBUILT from its checked fields; anything else becomes absent, so no
 * button renders rather than one whose label was guessed.
 */
const checkMonitoring = (value: unknown): MonitoringState | null | undefined => {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const { state, changedAt } = value as Record<string, unknown>;
  if (state !== "running" && state !== "stopped") return undefined;
  if (!isCount(changedAt)) return undefined;
  return { state, changedAt };
};

const withCheckedMonitoring = (status: CollectionStatus): CollectionStatus => {
  if (!("monitoring" in status)) return status;
  const monitoring = checkMonitoring(status.monitoring);
  if (monitoring !== undefined) return { ...status, monitoring };
  const rest = { ...status };
  delete rest.monitoring;
  return rest;
};

const isMonitoringBody = (body: unknown): body is { monitoring: MonitoringState } => {
  if (typeof body !== "object" || body === null) return false;
  const monitoring = checkMonitoring((body as Record<string, unknown>).monitoring);
  return monitoring !== null && monitoring !== undefined;
};

/** `search_revisions`' three columns, which are exactly `PUT /api/settings`' ACCEPTED_FIELDS. */
export type DealMode = "DISCOUNT" | "MAXIMUM_PRICE" | "BOTH";

export interface WireSettings {
  mode: DealMode;
  minimumDiscountPercent: number | null;
  maximumPriceCents: number | null;
  searchRevision?: number;
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
  /**
   * THE SHARED 9-SEARCH BUDGET (migrations/0009): distinct searches over every user's lists, and how
   * many are this user's. Optional so a Worker older than the field still loads the form.
   */
  budget?: { used: number; maximum: number; yours: number };
}

export interface MarketplaceClient {
  preview(settings: SearchSettings, getToken: GetToken): Promise<PreviewResult>;
  getWatch(getToken: GetToken): Promise<WatchWire>;
  saveWatch(body: WatchSaveBody, getToken: GetToken): Promise<WatchWire>;
  getSettings(getToken: GetToken): Promise<WireSettings | null>;
  saveDealRule(rule: DealRule, getToken: GetToken): Promise<void>;
  /**
   * THE COLLECTOR'S HEALTH. It is a SEPARATE read from `getWatch`/`getSettings` and must stay
   * one: those two gate Save -- a failed read there costs the write, because starting from the
   * form's defaults and saving is how a live watch list of nine rows gets replaced -- whereas a
   * failed status read must cost nothing but the badge. A-2 is the guard.
   */
  getStatus(getToken: GetToken, signal?: AbortSignal): Promise<CollectionStatus>;
  /**
   * START/STOP. No body. A 409 `MONITORING_NOT_READY` from Start surfaces as an `ApiRequestError`
   * carrying that code, which App turns into "Save a deal rule before starting monitoring."
   */
  startMonitoring(getToken: GetToken, signal?: AbortSignal): Promise<MonitoringState>;
  stopMonitoring(getToken: GetToken, signal?: AbortSignal): Promise<MonitoringState>;
  /** The caller's Discord webhook: whether one is stored. The URL itself never comes back. */
  getWebhook(getToken: GetToken): Promise<{ configured: boolean }>;
  /** Store (a URL) or clear (null) the caller's Discord webhook. */
  saveWebhook(url: string | null, getToken: GetToken): Promise<{ configured: boolean }>;
}

interface VerdictsResponse {
  listings: Listing[];
  truncated: boolean;
}

/*
 * THERE IS NO CLIENT-SIDE STATE LEFT TO RESET, and `resetMarketplaceState` is gone with it. It
 * existed to roll back the monitoring lifecycle -- a fiction, since the browser never started
 * collection -- and once Start/Stop and the status read went, its body was a no-op and `AuthGate`
 * was importing the marketplace client to call it. Every request here is a fresh fetch with the
 * caller's current token, so an identity change needs nothing undone; the day something IS cached
 * per identity, a reset hook comes back with a test that can see it.
 */

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

/**
 * `signal` IS FORWARDED FOR THE SAME REASON `getStatus` FORWARDS ONE: App bounds the POST with the
 * status reads' own budget, so a hung request cannot leave the button disabled forever.
 */
const postMonitoring = async (
  path: string,
  getToken: GetToken,
  signal?: AbortSignal,
): Promise<MonitoringState> => {
  const body = await requestJsonWithAuth<unknown>(path, getToken, { method: "POST", signal });
  if (!isMonitoringBody(body)) {
    throw new ApiRequestError("The monitoring state came back in a shape this page cannot read.", "unexpected");
  }
  return { state: body.monitoring.state, changedAt: body.monitoring.changedAt };
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

  /**
   * `signal` IS FORWARDED, AND IT IS THE ONLY REQUEST HERE THAT NEEDS ONE. The caller polls, so
   * an unbounded read is two hazards at once: the age it reports is attributed to a send time
   * that may be minutes stale, and two overlapping polls can land out of order and move the
   * displayed age BACKWARD. `apiClient.ts` forwards `options.signal` and nothing else, so without
   * this parameter there is no way to bound either.
   */
  async getStatus(getToken, signal) {
    const body = await requestJsonWithAuth<unknown>("/api/status", getToken, { signal });
    if (!isCollectionStatus(body)) {
      throw new ApiRequestError("The collector's status came back in a shape this page cannot read.", "unexpected");
    }
    return withCheckedMonitoring(withCheckedNotifications(body));
  },

  startMonitoring(getToken, signal) {
    return postMonitoring("/api/monitoring/start", getToken, signal);
  },

  stopMonitoring(getToken, signal) {
    return postMonitoring("/api/monitoring/stop", getToken, signal);
  },

  getWebhook(getToken) {
    return requestJsonWithAuth<{ configured: boolean }>("/api/webhook", getToken);
  },

  saveWebhook(url, getToken) {
    return requestJsonWithAuth<{ configured: boolean }>("/api/webhook", getToken, {
      method: "PUT",
      body: { url },
    });
  },
};
