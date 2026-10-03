import { useEffect, useMemo, useState } from "react";
import { ComponentSelector } from "./components/ComponentSelector";
import { DealRuleForm } from "./components/DealRuleForm";
import { ListingCard } from "./components/ListingCard";
import { LocationSelector } from "./components/LocationSelector";
import { ModelSelector } from "./components/ModelSelector";
import type { AuthenticatedIdentity } from "./auth/authTypes";
import { componentById, mockLocations } from "./data/catalog";
import { requestErrorMessage } from "./services/apiClient";
import { marketplaceClient, settingsToDealRule } from "./services/marketplaceClient";
import {
  preservableTargets,
  queryFor,
  watchModelsFor,
  type StoredTarget,
} from "./services/watchSelection";
import type {
  ComponentType,
  Listing,
  ModelSelection,
  SearchLocation,
  SearchSettings,
} from "./types";
import {
  allSelection,
  derivedTargetCount,
  MAX_WATCH_TARGETS,
  validateSearchSettings,
  type ValidationErrors,
} from "./utils/validation";

/**
 * THE FORM'S DEFAULTS, AND THEY ARE NOW ONLY A FALLBACK. Every field below is replaced on mount by
 * what `GET /api/watch` and `GET /api/settings` report, and Save is DISABLED until both succeed --
 * because starting from these values and saving is how a live watch list of nine rows and a
 * `DISCOUNT 10%` rule get replaced by a 25% rule nobody typed.
 */
const initialSettings: SearchSettings = {
  components: [],
  models: {},
  queries: {},
  location: null,
  radiusKm: 25,
  dealRule: {
    type: "discount",
    minimumDiscountPercent: 25,
    maximumPriceCad: "",
  },
};

const hasErrors = (errors: ValidationErrors) =>
  Object.keys(errors).length > 0;

type PendingAction = "preview" | "save" | null;

type GetToken = (forceRefresh: boolean) => Promise<string | null>;

/**
 * `getToken` IS REQUIRED AND HAS NO DEFAULT, and that is the whole guard on it. With a
 * `= noToken` default, `main.tsx` silently dropping the prop left the entire frontend suite
 * green -- and nothing imports `main.tsx`, so no test can ever cover that link. Required makes
 * it a `tsc` error instead. `AuthGate` always supplies one (the adapter's, or the tokenless
 * provider in local development), so no caller ever needed the default.
 */
interface AppProps {
  identity?: AuthenticatedIdentity | null;
  onSignOut?: () => void;
  getToken: GetToken;
}

/**
 * The stored market as a form value. THE STORED COORDINATES ARE KEPT AND ONLY THE LABEL IS LOOKED
 * UP, and that is the whole point of this function.
 *
 * MEASURED DEFECT IT FIXES: returning the catalog entry WHOLE on a slug match discarded the stored
 * coordinates, so a market row at `('toronto', 43.6459, -79.3816, 25)` -- the coordinates of the
 * "100 Front Street W, Toronto" entry this slice deleted, and exactly what a hand-written
 * `wrangler d1 execute` bootstrap could hold -- was rewritten to `43.6532,-79.3832` BY AN UNTOUCHED
 * SAVE. `market_key` is built from those coordinates and `model_stats` is keyed by it, so every
 * price benchmark in that market was orphaned while the form's own warning said that happens only
 * if you CHANGE the location or radius. The server cannot catch it: the coordinates it received
 * agreed with the slug.
 *
 * What happens now is loud instead: the save carries the stored coordinates, the server refuses them
 * by name (`INVALID_WATCH {field:"location", detail:"coordinates"}`, pinned by W-loc), and the
 * operator picks a location deliberately -- with the benchmark-reset line on screen beside it.
 */
const locationFromWire = (
  wire: { slug: string; latitude: number; longitude: number } | null,
): SearchLocation | null => {
  if (wire === null) return null;
  const known = mockLocations.find((entry) => entry.slug === wire.slug);
  return { ...wire, label: known?.label ?? wire.slug };
};

function App({ identity, onSignOut, getToken }: AppProps) {
  const [settings, setSettings] = useState<SearchSettings>(initialSettings);
  const [storedTargets, setStoredTargets] = useState<StoredTarget[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [radiusMode, setRadiusMode] = useState<"2" | "5" | "10" | "25" | "custom">("25");
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [listings, setListings] = useState<Listing[]>([]);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [hasPreviewed, setHasPreviewed] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [previewedAt, setPreviewedAt] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  /**
   * BOTH READS, AND SAVE STAYS DISABLED UNTIL BOTH SUCCEED. MEASURED: a 503 on load plus one click
   * on a Save that seeded from `initialSettings` wipes the live watch list and appends a search
   * revision that re-opens the whole evaluation corpus. The read is what makes the write safe, so
   * a failed read must cost the write, not just a banner.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [watch, stored] = await Promise.all([
          marketplaceClient.getWatch(getToken),
          marketplaceClient.getSettings(getToken),
        ]);
        if (cancelled) return;
        const queries: Partial<Record<ComponentType, string>> = {};
        const models: Partial<Record<ComponentType, ModelSelection>> = {};
        for (const [type, selection] of Object.entries(watch.selection.models)) {
          if (selection === undefined) continue;
          models[type as ComponentType] =
            selection.mode === "selected"
              ? { mode: "selected", values: selection.values }
              : allSelection();
          // THE ECHO, KEPT OUT OF `ModelSelection` ON PURPOSE: re-ticking "Select all models"
          // rebuilds the selection and would drop a query held inside it, and rewriting `ryzen` to
          // `cpu` on save is the defect the echo exists to prevent.
          if (selection.mode === "all" && selection.query !== undefined) {
            queries[type as ComponentType] = selection.query;
          }
        }
        const radiusKm = watch.selection.radiusKm;
        setSettings({
          components: watch.selection.components,
          models,
          queries,
          location: locationFromWire(watch.selection.location),
          // `null` means THERE IS NO MARKET ROW, and the FORM supplies the default -- never the
          // wire, which would be answering 0 for a radius no layer accepts.
          radiusKm: radiusKm ?? initialSettings.radiusKm,
          dealRule: settingsToDealRule(stored, initialSettings.dealRule),
        });
        setRadiusMode(
          radiusKm === null || ![2, 5, 10, 25].includes(radiusKm)
            ? "custom"
            : (String(radiusKm) as typeof radiusMode),
        );
        setStoredTargets(watch.storedTargets);
        setLoaded(true);
      } catch (error: unknown) {
        if (cancelled) return;
        setRequestError(
          requestErrorMessage(
            error,
            "Could not read your saved searches. Saving is disabled until it loads.",
          ),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  const selectedComponents = useMemo(
    () => settings.components.map((component) => componentById[component]),
    [settings.components],
  );

  /**
   * THE KEPT SEARCHES, RECOMPUTED FROM THE CURRENT SELECTION rather than read from the load. Under
   * the symmetric preservation rule, narrowing a type or deselecting it MOVES that type's broad
   * query into this list -- so a list taken from the load would under-count the budget by exactly
   * those rows and the server would refuse a save the form called fine.
   */
  const keptTargets = useMemo(
    () =>
      preservableTargets(
        storedTargets,
        settings.components,
        settings.models,
        settings.queries,
      ),
    [storedTargets, settings.components, settings.models, settings.queries],
  );

  const targetCount = derivedTargetCount(settings.components, settings.models) + keptTargets.length;

  const updateSettings = (nextSettings: SearchSettings) => {
    setSettings(nextSettings);
    setSavedAt(null);
    // THE KEPT COUNT IS RECOMPUTED FROM `nextSettings`, not read from this render's memo: the memo
    // was computed from the settings being replaced, and under the symmetric preservation rule the
    // very change being applied is what moves rows into or out of that set. Using the stale count
    // would show a number one interaction behind the form.
    if (hasErrors(errors)) {
      setErrors(
        validateSearchSettings(
          nextSettings,
          preservableTargets(
            storedTargets,
            nextSettings.components,
            nextSettings.models,
            nextSettings.queries,
          ).length,
        ),
      );
    }
  };

  const toggleComponent = (component: ComponentType) => {
    const selected = settings.components.includes(component);
    const components = selected
      ? settings.components.filter((value) => value !== component)
      : [...settings.components, component];

    updateSettings({
      ...settings,
      components,
      models: selected
        ? settings.models
        : // ONE of the `mode:"all"` sites, and `values` is EMPTY. The shipped code wrote
          // `[...componentById[component].models]` here, which the wire refuses.
          { ...settings.models, [component]: allSelection() },
    });
  };

  /**
   * WHEN A TYPE'S MODEL LIST EMPTIES, THE COMPONENT IS UNTICKED. `mode:"none"` has no backend
   * representation -- a `none` type contributes no `watch_targets` row -- so sending it would make
   * the component come back unticked on the next load with nothing having said so. Unticking it
   * here says so on the screen, immediately, which is the only honest version of the same fact.
   */
  const updateModelSelection = (
    component: ComponentType,
    selection: ModelSelection,
  ) => {
    if (selection.mode === "none") {
      updateSettings({
        ...settings,
        components: settings.components.filter((value) => value !== component),
      });
      return;
    }
    updateSettings({
      ...settings,
      models: { ...settings.models, [component]: selection },
    });
  };

  /**
   * Omitting an id from `preservedTargetIds` is what removes that row; this is that omission.
   *
   * IT RE-VALIDATES, and that is not symmetry for its own sake: Remove is the ONE action the
   * over-budget message tells the operator to take, so leaving `11 of 9 searches used — remove a
   * kept search` on screen after they removed one says the only route out did not work.
   */
  const removeKeptSearch = (targetId: string) => {
    const remaining = storedTargets.filter((row) => row.targetId !== targetId);
    setStoredTargets(remaining);
    setSavedAt(null);
    if (hasErrors(errors)) {
      setErrors(
        validateSearchSettings(
          settings,
          preservableTargets(remaining, settings.components, settings.models, settings.queries)
            .length,
        ),
      );
    }
  };

  const selectRadius = (mode: typeof radiusMode) => {
    setRadiusMode(mode);
    if (mode !== "custom") {
      updateSettings({ ...settings, radiusKm: Number(mode) });
    }
  };

  const validate = () => {
    const nextErrors = validateSearchSettings(settings, keptTargets.length);
    setErrors(nextErrors);
    return !hasErrors(nextErrors);
  };

  const preview = async () => {
    if (!validate()) return;
    setPendingAction("preview");
    setRequestError(null);
    try {
      /*
       * THE SELECTION TRAVELS WITH THE READ NOW. `GET /api/verdicts` filters on it in SQL, before
       * its own `LIMIT 50`, so a page of a component the user is not watching can no longer arrive
       * and be filtered to nothing in the browser.
       *
       * WHAT THIS BUTTON STILL IGNORES, because the comment that said so was replaced and the fact
       * was only PARTLY fixed. `components` and `models` are now real. `location` and `radiusKm`
       * are still REQUIRED to press it (validate() refuses without them) and still reach nothing
       * here -- the market lives in `watch_market` and the read has no market parameter -- so a
       * preview after changing the location shows listings from the market the collector last ran
       * in. And the DEAL RULE reaches nothing either: a verdict is committed by `evaluateBatch`
       * against the STORED revision, so an UNSAVED rule edit previews against the saved rule. The
       * action-help line under the buttons says so on screen; the honest fix for the market half is
       * for this read to take the market, which is a slice, not a line.
       */
      const result = await marketplaceClient.preview(settings, getToken);
      setListings(result.listings);
      setTruncated(result.truncated);
      setPreviewedAt(result.searchedAt);
      setHasPreviewed(true);
    } catch (error: unknown) {
      setRequestError(
        requestErrorMessage(
          error,
          "Could not load Facebook Marketplace results. Please try again.",
        ),
      );
    } finally {
      setPendingAction(null);
    }
  };

  const save = async () => {
    if (!validate()) return;
    const location = settings.location;
    if (location === null) return;
    setPendingAction("save");
    setRequestError(null);
    try {
      const written = await marketplaceClient.saveWatch(
        {
          components: settings.components,
          models: watchModelsFor(settings.components, settings.models, settings.queries),
          location: {
            slug: location.slug,
            latitude: location.latitude,
            longitude: location.longitude,
          },
          radiusKm: settings.radiusKm,
          // REQUIRED, AND ECHOED EXPLICITLY. The server recomputes the preservable set and refuses
          // any id outside it, so this can neither invent a row nor silently drop one -- and an
          // absent field is a 400 rather than a delete of everything the form cannot display.
          preservedTargetIds: keptTargets.map((row) => row.targetId),
        },
        getToken,
      );
      // THE RE-SEED HAPPENS BEFORE THE SECOND WRITE, AND THE ORDER IS THE FIX. The watch list and
      // the market are already COMMITTED at this point; if the deal-rule PUT then rejects and these
      // setters have been skipped, the form goes on describing the world before the save -- the
      // operator sees Toronto when D1 holds Waterloo, with the price benchmarks already reset and
      // the page looking untouched. Applying what is stored first means a failure past this point
      // costs an error banner and nothing else.
      //
      // RE-SEEDED FROM THE RESPONSE, which is re-read from D1 rather than echoed. A broad query
      // that was preserved for a type the form deselected comes back as a SELECTED TYPE, because
      // that row is still being collected -- showing it unticked would be the lie.
      setStoredTargets(written.storedTargets);
      setSettings((current) => ({
        ...current,
        components: written.selection.components,
        models: Object.fromEntries(
          Object.entries(written.selection.models).map(([type, selection]) => [
            type,
            selection !== undefined && selection.mode === "selected"
              ? { mode: "selected", values: selection.values }
              : allSelection(),
          ]),
        ),
        queries: Object.fromEntries(
          Object.entries(written.selection.models)
            .filter(([, selection]) => selection?.mode === "all" && selection.query !== undefined)
            .map(([type, selection]) => [type, selection?.query]),
        ),
      }));
      // THE DEAL RULE GOES THROUGH ITS OWN ROUTE, which bumps the search revision ON PURPOSE when it
      // changes. It is sent SECOND so that the watch write is never skipped because the rule failed.
      await marketplaceClient.saveDealRule(settings.dealRule, getToken);
      setSavedAt(new Date().toISOString());
    } catch (error: unknown) {
      setRequestError(
        requestErrorMessage(
          error,
          "Your searches could not be saved. Nothing was changed.",
        ),
      );
    } finally {
      setPendingAction(null);
    }
  };

  const formattedPreviewTime = previewedAt
    ? new Intl.DateTimeFormat("en-CA", {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(previewedAt))
    : null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-content">
          <a className="brand" href="/" aria-label="Marketplace Deal Finder home">
            <span>
              <strong>Marketplace Deal Finder</strong>
              <small>PC component monitor</small>
            </span>
          </a>
          <div className="source-pill">
            <span aria-hidden="true" />
            Facebook Marketplace
          </div>
          {identity && (
            <div className="account-block">
              <span className="account-email">{identity.email}</span>
              {onSignOut && (
                <button
                  type="button"
                  className="secondary-button account-signout"
                  onClick={onSignOut}
                >
                  Sign out
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <main>
        <section className="page-intro">
          <p className="eyebrow">Deal monitoring</p>
          <h1>Find better PC component deals.</h1>
          <p>
            Set what your collector searches for, then preview the Facebook Marketplace listings it
            has already found.
          </p>
        </section>

        <nav className="setup-nav" aria-label="Search setup steps">
          <a href="#components">
            <span className="setup-nav__number">1</span>
            <span>
              <strong>Choose parts</strong>
              <small>Components and models</small>
            </span>
          </a>
          <a href="#location">
            <span className="setup-nav__number">2</span>
            <span>
              <strong>Set location</strong>
              <small>Area and search radius</small>
            </span>
          </a>
          <a href="#deal-rule">
            <span className="setup-nav__number">3</span>
            <span>
              <strong>Define a deal</strong>
              <small>Discount or price limit</small>
            </span>
          </a>
          <a href="#preview-results">
            <span className="setup-nav__number">4</span>
            <span>
              <strong>Preview results</strong>
              <small>Review before monitoring</small>
            </span>
          </a>
        </nav>

        <div className="dashboard-layout">
          <section className="configuration-panel" aria-label="Search configuration">
            <div className="panel-heading">
              <div>
                <p className="step-label">Search setup</p>
                <h2>Your watch list</h2>
              </div>
              <span className="required-note">* Required</span>
            </div>

            {/*
             * THE BUDGET, RENDERED BEFORE THE REFUSAL AND FROM THE SAME COUNT THE VALIDATOR USES.
             * The collector REFUSES a list over the cap rather than truncating it -- nothing runs,
             * on every run -- so the number has to be on screen before Save, not only in the error.
             */}
            <p className="budget-line" data-testid="budget">
              {targetCount} of {MAX_WATCH_TARGETS} searches used
            </p>
            {errors.targets && (
              <p className="field-error" role="alert">
                {errors.targets}
              </p>
            )}

            <ComponentSelector
              selected={settings.components}
              error={errors.components}
              onToggle={toggleComponent}
            />

            {selectedComponents.length > 0 && (
              <div className="form-section">
                <div className="section-heading">
                  <div>
                    <h2>Models</h2>
                    <p>All models are included unless you narrow the list.</p>
                  </div>
                </div>
                <div className="model-list">
                  {selectedComponents.map((component) => (
                    <ModelSelector
                      componentType={component.id}
                      key={component.id}
                      query={queryFor(component.id, settings.queries)}
                      // The second `mode:"all"` site: the default when a type has no selection yet.
                      selection={settings.models[component.id] ?? allSelection()}
                      onChange={(selection) => updateModelSelection(component.id, selection)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/*
             * THE KEPT SEARCHES, VERBATIM, WITH A PER-ROW REMOVE AND NO ACKNOWLEDGEMENT CHECKBOX.
             * Nothing is destroyed by a save -- that is the point of the preservation rule -- so
             * there is nothing to consent to; a consent gate here collected consent for rows that
             * SURVIVE while saying nothing about any that do not. Remove is the only control that
             * frees a budget slot, which is why the over-budget copy says "remove".
             */}
            {keptTargets.length > 0 && (
              <div className="form-section" data-testid="kept-searches">
                <div className="section-heading">
                  <div>
                    <h2>Kept searches</h2>
                    <p>
                      {keptTargets.length === 1 ? "This search is" : "These searches are"} kept
                      as-is and {keptTargets.length === 1 ? "is" : "are"} not editable here. Each
                      one spends a search.
                    </p>
                  </div>
                </div>
                <ul className="kept-list">
                  {keptTargets.map((row) => (
                    <li key={row.targetId}>
                      <span>
                        {row.targetId} · {row.componentType} · &ldquo;{row.query}&rdquo;
                      </span>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => removeKeptSearch(row.targetId)}
                      >
                        Remove {row.targetId}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <LocationSelector
              value={settings.location}
              error={errors.location}
              onChange={(location) => updateSettings({ ...settings, location })}
            />

            <div className="form-section" id="radius">
              <div className="section-heading">
                <div>
                  <h2>Search radius</h2>
                  <p>Distance from your selected location.</p>
                </div>
              </div>
              <div className="segmented-control radius-control" aria-label="Search radius">
                {(["2", "5", "10", "25", "custom"] as const).map((radius) => (
                  <button
                    aria-pressed={radiusMode === radius}
                    className={radiusMode === radius ? "is-selected" : ""}
                    key={radius}
                    type="button"
                    onClick={() => selectRadius(radius)}
                  >
                    {radius === "custom" ? "Custom" : `${radius} km`}
                  </button>
                ))}
              </div>
              {radiusMode === "custom" && (
                <label className="custom-radius">
                  <span>Custom radius (km)</span>
                  {/*
                   * 1 TO 25, WHOLE KILOMETRES. `migrations/0005` stores `radius_km` under
                   * `CHECK (typeof(radius_km) = 'integer' AND radius_km BETWEEN 1 AND 25)`, so the
                   * shipped `min="0.1" max="49.9" step="0.1"` control offered two whole classes of
                   * value the write cannot store.
                   */}
                  <input
                    aria-invalid={Boolean(errors.radius)}
                    max="25"
                    min="1"
                    step="1"
                    type="number"
                    value={settings.radiusKm}
                    onChange={(event) =>
                      updateSettings({ ...settings, radiusKm: Number(event.target.value) })
                    }
                  />
                </label>
              )}
              {errors.radius && <p className="field-error" role="alert">{errors.radius}</p>}
              {/*
               * DISCLOSED, NOT PREVENTED, and it is the one destructive thing this form can do.
               * `market_key` is `lat,lon|Nkm`, `model_stats` is keyed by it, and nothing migrates
               * an aggregate between keys -- so every location or radius change starts the price
               * benchmarks from zero. Preventing it would mean refusing the control the slice
               * exists to build; without this line the reset is invisible until the benchmarks
               * read zero.
               */}
              <p className="muted-copy" data-testid="radius-warning">
                Changing the location or radius starts your price benchmarks over.
              </p>
            </div>

            <DealRuleForm
              value={settings.dealRule}
              errors={errors}
              onChange={(dealRule) => updateSettings({ ...settings, dealRule })}
            />

            {requestError && (
              <div className="error-banner" role="alert">{requestError}</div>
            )}

            <div className="form-actions">
              <button
                className="secondary-button action-button"
                disabled={pendingAction !== null}
                type="button"
                onClick={preview}
              >
                {pendingAction === "preview" ? "Searching…" : "Preview listings"}
              </button>
              <button
                className="primary-button action-button"
                disabled={pendingAction !== null || !loaded}
                type="button"
                onClick={save}
              >
                {pendingAction === "save" ? "Saving…" : "Save searches"}
              </button>
            </div>
            <p className="action-help">
              {loaded
                ? "Your collector reads this list every 30 minutes."
                : "Reading your saved searches…"}
            </p>
            {/*
              * ON SCREEN, because the surprise is reachable in one click: Preview reads verdicts
              * that were judged against the SAVED deal rule, so editing the rule and previewing
              * without saving shows the old judgements.
              */}
            <p className="action-help" data-testid="preview-scope">
              Preview shows listings your collector has already judged, using your saved deal rule —
              not unsaved edits.
            </p>
            {savedAt && (
              <p className="action-help" role="status">
                Saved. Your collector picks this up on its next run.
              </p>
            )}
          </section>

          {/*
            * THE MONITORING PANEL IS GONE, AND DELETING IT IS THE HONEST END OF DELETING THE
            * Start/Stop BUTTONS. Those buttons were a fiction -- the browser never started
            * collection, a launchd cron does -- but they were also the ONLY writers of the status
            * the panel rendered. With them gone the panel could answer exactly one thing, forever:
            * "Not running / Stopped / Next scan —", beside a line saying the collector reads this
            * list every 30 minutes. A widget that can only say "no" to "is anything collecting?"
            * is a worse lie than the buttons were.
            *
            * THE REAL THING NEEDS A READER FOR `monitor_runs`, which no browser route exposes:
            * `GET /api/status` answers liveness, not runs. That is a slice, not a line, and it is
            * the one to write before this panel comes back.
            */}
          <aside className="results-column" id="preview-results">
            <section className="results-panel" aria-live="polite" aria-busy={pendingAction === "preview"}>
              <div className="results-heading">
                <div>
                  <p className="eyebrow">Preview</p>
                  <h2>Matching listings</h2>
                </div>
                {hasPreviewed && (
                  <p>
                    {listings.length}
                    {truncated && listings.length > 0 ? "+" : ""} result
                    {listings.length === 1 ? "" : "s"}
                  </p>
                )}
              </div>

              {pendingAction === "preview" ? (
                <div className="loading-state">
                  <span className="spinner" aria-hidden="true" />
                  <strong>Reading your collected listings…</strong>
                  <p>Fetching the latest verdicts from your database.</p>
                </div>
              ) : !hasPreviewed ? (
                <div className="empty-state">
                  <div className="empty-icon" aria-hidden="true">⌕</div>
                  <h3>Your preview will appear here</h3>
                  <p>Select components and a location, then preview the latest listings.</p>
                </div>
              ) : listings.length === 0 ? (
                /*
                 * THERE IS NO "the page was partial and nothing matched" BRANCH ANY MORE, AND
                 * DELETING THE CLIENT-SIDE FILTER IS WHAT MADE IT UNSATISFIABLE -- not the `WHERE`.
                 * The server's own invariants already held: in a 200, `served.length === 0` implies
                 * `rows.length === 0` (a non-empty read serving nothing is a 503), so `truncated`
                 * is false. The branch was reachable ONLY because `listings` here was the
                 * CLIENT-FILTERED array while `truncated` came from the server. With the filter
                 * gone, `listings` is the server's own page and the two agree again. The `WHERE` is
                 * what makes the deletion CORRECT: without it the bound would still apply ahead of
                 * the selection. Stating it the other way round would leave a reviewer checking the
                 * server invariant, finding it unchanged, and concluding the deletion was
                 * unjustified.
                 */
                <div className="empty-state">
                  <div className="empty-icon" aria-hidden="true">0</div>
                  <h3>No matching listings found</h3>
                  <p>Try selecting more components or models, or wait for the next collection run.</p>
                </div>
              ) : (
                <>
                  {formattedPreviewTime && (
                    <p className="results-timestamp">Preview updated at {formattedPreviewTime}</p>
                  )}
                  <div className="listing-list">
                    {listings.map((listing) => (
                      <ListingCard key={`${listing.source}:${listing.listingId}`} listing={listing} />
                    ))}
                  </div>
                </>
              )}
            </section>
          </aside>
        </div>
      </main>

      <footer className="app-footer">
        <p>Marketplace Deal Finder · Private prototype</p>
        <p>Listings and verdicts are read from your own collection database.</p>
      </footer>
    </div>
  );
}

export default App;
