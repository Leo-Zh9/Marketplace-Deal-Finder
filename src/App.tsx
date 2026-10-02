import { useEffect, useMemo, useState } from "react";
import { ComponentFilters } from "./components/ComponentFilters";
import { ComponentSelector } from "./components/ComponentSelector";
import { DealRuleForm } from "./components/DealRuleForm";
import { ListingCard } from "./components/ListingCard";
import { LocationSelector } from "./components/LocationSelector";
import { ModelSelector } from "./components/ModelSelector";
import { StatusPanel } from "./components/StatusPanel";
import type { AuthenticatedIdentity } from "./auth/authTypes";
import { componentById } from "./data/catalog";
import { requestErrorMessage } from "./services/apiClient";
import { marketplaceClient } from "./services/marketplaceClient";
import type {
  ComponentType,
  Listing,
  ModelSelection,
  MonitoringStatus,
  SearchSettings,
} from "./types";
import {
  validateSearchSettings,
  type ValidationErrors,
} from "./utils/validation";

const initialSettings: SearchSettings = {
  components: [],
  models: {},
  location: null,
  radiusKm: 25,
  filters: {},
  dealRule: {
    type: "discount",
    minimumDiscountPercent: 25,
    maximumPriceCad: "",
  },
};

const initialMonitoringStatus: MonitoringStatus = {
  state: "STOPPED",
  provider: "AVAILABLE",
  lastSuccessfulScanAt: null,
  nextScanAt: null,
};

const hasErrors = (errors: ValidationErrors) =>
  Object.keys(errors).length > 0;

type PendingAction = "preview" | "start" | "stop" | null;

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

function App({ identity, onSignOut, getToken }: AppProps) {
  const [settings, setSettings] = useState<SearchSettings>(initialSettings);
  const [radiusMode, setRadiusMode] = useState<"2" | "5" | "10" | "25" | "custom">("25");
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [listings, setListings] = useState<Listing[]>([]);
  const [monitoringStatus, setMonitoringStatus] = useState(initialMonitoringStatus);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [hasPreviewed, setHasPreviewed] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [previewedAt, setPreviewedAt] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    marketplaceClient
      .getMonitoringStatus()
      .then(setMonitoringStatus)
      .catch((error: unknown) => {
        const message = requestErrorMessage(error);
        if (message) setRequestError(message);
      });
  }, []);

  const selectedComponents = useMemo(
    () => settings.components.map((component) => componentById[component]),
    [settings.components],
  );

  const updateSettings = (nextSettings: SearchSettings) => {
    setSettings(nextSettings);
    if (hasErrors(errors)) setErrors(validateSearchSettings(nextSettings));
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
        : {
            ...settings.models,
            [component]: {
              mode: "all",
              values: [...componentById[component].models],
            },
          },
    });
  };

  const updateModelSelection = (
    component: ComponentType,
    selection: ModelSelection,
  ) => {
    updateSettings({
      ...settings,
      models: { ...settings.models, [component]: selection },
    });
  };

  const updateFilter = (
    component: ComponentType,
    key: string,
    value: string,
  ) => {
    updateSettings({
      ...settings,
      filters: {
        ...settings.filters,
        [component]: { ...settings.filters[component], [key]: value },
      },
    });
  };

  const selectRadius = (mode: typeof radiusMode) => {
    setRadiusMode(mode);
    if (mode !== "custom") {
      updateSettings({ ...settings, radiusKm: Number(mode) });
    }
  };

  const validate = () => {
    const nextErrors = validateSearchSettings(settings);
    setErrors(nextErrors);
    return !hasErrors(nextErrors);
  };

  const preview = async () => {
    if (!validate()) return;
    setPendingAction("preview");
    setRequestError(null);
    try {
      /*
       * FOUR OF THIS FORM'S SIX FIELDS GATE A READ THAT IGNORES THEM, and that is worth saying
       * out loud now that half the form is real. `GET /api/verdicts` takes NO parameters: the
       * component and model selections are applied to its response client-side, and the
       * location, the radius, the minimum discount and the maximum price reach nothing. Location
       * and radius are nevertheless REQUIRED to press this button (validate() refuses without
       * them), so a user in Vancouver at 2 km previews Toronto listings with nothing on screen
       * saying so -- the market lives in `watch_market`, which this UI cannot read or edit, and
       * the deal rule lives in `search_settings`, which the frontend never calls. Before this
       * slice the whole form was consistently fictional; it is now half real, with no indication
       * which half. The fix is the settings-and-market UI -- the work that lets this form read
       * and write `search_settings` and `watch_market` instead of starting from
       * `initialSettings` -- not a string here.
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

  const startMonitoring = async () => {
    if (!validate()) return;
    setPendingAction("start");
    setRequestError(null);
    setMonitoringStatus((current) => ({ ...current, state: "STARTING" }));
    try {
      const status = await marketplaceClient.startMonitoring(settings);
      setMonitoringStatus(status);
    } catch (error: unknown) {
      setMonitoringStatus((current) => ({ ...current, state: "ERROR" }));
      setRequestError(
        requestErrorMessage(
          error,
          "Monitoring could not be started. Your settings were not lost.",
        ),
      );
    } finally {
      setPendingAction(null);
    }
  };

  const stopMonitoring = async () => {
    setPendingAction("stop");
    setRequestError(null);
    try {
      setMonitoringStatus(await marketplaceClient.stopMonitoring());
    } catch (error: unknown) {
      setRequestError(
        requestErrorMessage(
          error,
          "Monitoring could not be stopped. Please try again.",
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
            Set what you are looking for and preview the Facebook Marketplace
            listings your collector has already found.
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
                <h2>Create your watchlist</h2>
              </div>
              <span className="required-note">* Required</span>
            </div>

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
                      selection={
                        settings.models[component.id] ?? {
                          mode: "all",
                          values: [...component.models],
                        }
                      }
                      onChange={(selection) => updateModelSelection(component.id, selection)}
                    />
                  ))}
                </div>
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
                  <input
                    aria-invalid={Boolean(errors.radius)}
                    max="49.9"
                    min="0.1"
                    step="0.1"
                    type="number"
                    value={settings.radiusKm}
                    onChange={(event) =>
                      updateSettings({ ...settings, radiusKm: Number(event.target.value) })
                    }
                  />
                </label>
              )}
              {errors.radius && <p className="field-error" role="alert">{errors.radius}</p>}
            </div>

            <DealRuleForm
              value={settings.dealRule}
              errors={errors}
              onChange={(dealRule) => updateSettings({ ...settings, dealRule })}
            />

            <ComponentFilters
              components={settings.components}
              values={settings.filters}
              onChange={updateFilter}
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
              {monitoringStatus.state === "ACTIVE" ? (
                <button
                  className="danger-button action-button"
                  disabled={pendingAction !== null}
                  type="button"
                  onClick={stopMonitoring}
                >
                  {pendingAction === "stop" ? "Stopping…" : "Stop monitoring"}
                </button>
              ) : (
                <button
                  className="primary-button action-button"
                  disabled={pendingAction !== null}
                  type="button"
                  onClick={startMonitoring}
                >
                  {pendingAction === "start" ? "Starting…" : "Start monitoring"}
                </button>
              )}
            </div>
            <p className="action-help">Monitoring checks for new listings every 30 minutes.</p>
          </section>

          <aside className="results-column" id="preview-results">
            <StatusPanel status={monitoringStatus} />

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
              ) : monitoringStatus.provider === "UNAVAILABLE" ? (
                <div className="empty-state empty-state--warning">
                  <div className="empty-icon" aria-hidden="true">!</div>
                  <h3>Facebook Marketplace is unavailable</h3>
                  <p>Your settings are safe. Try previewing again later.</p>
                </div>
              ) : !hasPreviewed ? (
                <div className="empty-state">
                  <div className="empty-icon" aria-hidden="true">⌕</div>
                  <h3>Your preview will appear here</h3>
                  <p>Select components and a location, then preview the latest listings.</p>
                </div>
              ) : listings.length === 0 && truncated ? (
                /*
                 * A NON-EMPTY DATABASE MUST NOT BE REPORTED AS EMPTY, and without this branch it
                 * was. The server bounds the page at 50 rows deal-first and the component/model
                 * filter runs HERE, in the browser, AFTER that bound -- so when the 50 rows it
                 * sent are all of a component the user is not watching, the page said
                 * "0+ results / No matching listings found" and then advised two things that
                 * cannot help: select more components (the user's own component is not on the
                 * page) and wait for the next collection run (the listings are already
                 * collected). `migrations/0005` seeds a cpu target AND a gpu target, so two
                 * component types share one page from the very first collection run; this is not
                 * a large-corpus problem.
                 *
                 * `truncated` is the fact that falsifies the old message and it was already in
                 * state, unused by this branch. THE REAL FIX IS SERVER-SIDE FILTERING -- a
                 * `component_type IN (...)` predicate bound from the request, so the bound
                 * applies to the filtered set instead of ahead of it. Named, not built: it
                 * changes the endpoint's contract and its cost model. Until then this branch is
                 * what keeps the page from lying, and it offers NO next action because there is
                 * no user action that helps.
                 */
                <div className="empty-state empty-state--warning">
                  <div className="empty-icon" aria-hidden="true">!</div>
                  <h3>Nothing on this page matched</h3>
                  <p>
                    The server sent a partial page of listings and none of them matched your
                    selection. There may be matching listings it did not send.
                  </p>
                </div>
              ) : listings.length === 0 ? (
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
