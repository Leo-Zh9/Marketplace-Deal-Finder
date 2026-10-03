import type { ComponentType, ModelSelection, SearchSettings } from "../types";

/**
 * THE ONLY DEFINITION OF THE CAP IN THE TypeScript HALVES, imported by `worker/api/watch.ts` as
 * well as by this file and the UI. Two copies would drift, and the drift is silent: the browser
 * would render "9 of 9 searches used" over a save the Worker refuses, or vice versa.
 *
 * THE AUTHORITY IS `collector/runTargets.ts`'s `MAX_TARGETS_PER_RUN`, which REFUSES rather than
 * truncating -- `returned > MAX_TARGETS_PER_RUN` is `EXIT_CONFIG` and NOTHING RUNS. The collector
 * cannot import this module (it runs under Node with `.ts`-extension imports and no DOM types),
 * so that constant is a second literal; `worker/api/watch.test.ts` asserts the two agree.
 */
export const MAX_WATCH_TARGETS = 9;

/**
 * `values: []`, NEVER `[...component.models]`. One helper for all four `mode:"all"` sites because
 * the shipped code wrote the model names at every one of them, and the wire invariant is
 * "non-empty iff mode is selected". MEASURED with the real ModelSelector rendered: the shipped
 * version sends `mode:"all"` with 68 values, and the reachable sequence
 * `tick gpu -> untick "Select all" -> re-tick` is what produces it.
 */
export const allSelection = (): ModelSelection => ({ mode: "all", values: [] });

/** UI-transient only: `src/App.tsx` unticks the component rather than sending this. */
export const noneSelection = (): ModelSelection => ({ mode: "none", values: [] });

/**
 * THE SAME COUNT THE SERVER DERIVES: one target per `mode:"all"` type, one per named model under
 * `mode:"selected"`, none for `none`. The budget the UI renders and the rule this file enforces
 * read it from here, so the number on screen is the number that gets refused.
 */
export const derivedTargetCount = (
  components: readonly ComponentType[],
  models: Partial<Record<ComponentType, ModelSelection>>,
): number => {
  let total = 0;
  for (const component of components) {
    const selection = models[component] ?? allSelection();
    total +=
      selection.mode === "all" ? 1 : selection.mode === "selected" ? selection.values.length : 0;
  }
  return total;
};

export interface ValidationErrors {
  components?: string;
  targets?: string;
  location?: string;
  radius?: string;
  minimumDiscount?: string;
  maximumPrice?: string;
}

export const RADIUS_MESSAGE = "Radius must be a whole number between 1 and 25 km.";

/** The over-budget copy says REMOVE. See the comment on the rule below for why. */
export const targetBudgetMessage = (targets: number): string =>
  targets === 0
    ? `0 of ${MAX_WATCH_TARGETS} searches used — select a component to search.`
    : `${targets} of ${MAX_WATCH_TARGETS} searches used — remove a kept search or narrow fewer models.`;

/**
 * `keptSearchCount` IS REQUIRED AND HAS NO DEFAULT, for the reason `preservedTargetIds` is
 * required on the wire: a default of 0 silently under-counts the budget by exactly the rows the
 * form cannot display, and the refusal then arrives from the server instead of from the form.
 */
export const validateSearchSettings = (
  settings: SearchSettings,
  keptSearchCount: number,
): ValidationErrors => {
  const errors: ValidationErrors = {};

  if (settings.components.length === 0) {
    errors.components = "Select at least one component.";
  }

  /**
   * THE TARGET-COUNT RULE, AND IT COUNTS KEPT SEARCHES. `MAX_TARGETS_PER_RUN` REFUSES rather
   * than truncating, so a 10-target list does not collect 9 of 10 -- it collects NOTHING, on
   * every run, with exit 2. Counting only the derived targets lets production save 6 + 3 = 9
   * derived rows beside 3 kept ones and kill collection outright.
   *
   * IT ALSO BOUNDS THE PREVIEW URL. `?pairs` carries one entry per selected model, so the cap is
   * what keeps that query string at 183 bytes for a 5-model selection instead of the 14,367 an
   * unbounded all-models selection would build.
   */
  const targets = derivedTargetCount(settings.components, settings.models) + keptSearchCount;
  if (targets === 0 || targets > MAX_WATCH_TARGETS) {
    errors.targets = targetBudgetMessage(targets);
  }

  if (!settings.location) {
    errors.location = "Choose a location.";
  }

  // The floor is 1, not 0.1, because `worker/storage/marketKey.ts` buckets the radius with
  // Math.round and THROWS below 1 km -- and it is called once per page, outside every
  // per-listing guard, so a 0.3 km radius does not skip a listing, it kills the whole scan.
  //
  // THE CEILING IS 25 AND THE VALUE MUST BE A WHOLE NUMBER, because that is what
  // `migrations/0005_watch_targets.sql:29` stores: `typeof(radius_km) = 'integer'` is
  // load-bearing there -- SQLite INTEGER is AFFINITY, so a range check alone admits 12.5 -- and
  // a radius this form accepts but the write refuses tells the user the service is broken when
  // their input was simply unstorable. The shipped control reached both 12.5 and 49.9.
  //
  // `!Number.isFinite` FIRST, and it is not redundant. NaN < 1 and NaN > 25 are BOTH false, so a
  // comparison-only condition returns no error for NaN and hands it straight to marketKey, which
  // rejects non-finite input and throws -- the same whole-scan kill, through a different door.
  // `Number.isInteger` would also catch NaN today; the explicit term is kept so the property
  // survives someone relaxing the integer rule.
  if (
    !Number.isFinite(settings.radiusKm) ||
    !Number.isInteger(settings.radiusKm) ||
    settings.radiusKm < 1 ||
    settings.radiusKm > 25
  ) {
    errors.radius = RADIUS_MESSAGE;
  }

  if (
    settings.dealRule.type !== "maximum_price" &&
    (settings.dealRule.minimumDiscountPercent < 1 ||
      settings.dealRule.minimumDiscountPercent > 99)
  ) {
    errors.minimumDiscount = "Discount must be between 1% and 99%.";
  }

  if (settings.dealRule.type !== "discount") {
    const maximumPrice = Number(settings.dealRule.maximumPriceCad);
    if (!settings.dealRule.maximumPriceCad || maximumPrice <= 0) {
      errors.maximumPrice = "Enter a positive maximum price.";
    }
  }

  return errors;
};
