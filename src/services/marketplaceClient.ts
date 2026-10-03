import { requestJsonWithAuth } from "./apiClient";
/**
 * THE SELECTION RULES LIVE IN `./watchSelection`, not here, so that `worker/api/watch.test.ts` can
 * run the REAL client rule against the REAL handler without dragging `apiClient`'s `import.meta.env`
 * into the Worker's tsc program. See that file's header.
 */
import { verdictsQuery, type StoredTarget, type WatchSaveBody } from "./watchSelection";
import type { ComponentType, DealRule, Listing, PreviewResult, SearchSettings } from "../types";

export type { StoredTarget, WatchSaveBody } from "./watchSelection";

type GetToken = (forceRefresh: boolean) => Promise<string | null>;

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
}

export interface MarketplaceClient {
  preview(settings: SearchSettings, getToken: GetToken): Promise<PreviewResult>;
  getWatch(getToken: GetToken): Promise<WatchWire>;
  saveWatch(body: WatchSaveBody, getToken: GetToken): Promise<WatchWire>;
  getSettings(getToken: GetToken): Promise<WireSettings | null>;
  saveDealRule(rule: DealRule, getToken: GetToken): Promise<void>;
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
};
