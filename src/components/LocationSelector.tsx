import { useMemo, useState } from "react";
import { mockLocations } from "../data/catalog";
import type { SearchLocation } from "../types";

interface LocationSelectorProps {
  value: SearchLocation | null;
  error?: string;
  onChange: (location: SearchLocation | null) => void;
}

const normalizeLocationText = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Great-circle distance in kilometres. The mean Earth radius is enough: this picks a NEAREST
 * ENTRY out of 37 cities tens of kilometres apart, so ellipsoidal precision would change no
 * answer.
 */
const distanceKm = (
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number },
): number => {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLatitude = radians(second.latitude - first.latitude);
  const deltaLongitude = radians(second.longitude - first.longitude);
  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(radians(first.latitude)) *
      Math.cos(radians(second.latitude)) *
      Math.sin(deltaLongitude / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(haversine)));
};

/** The nearest committed market to a pair of coordinates. The catalog is never empty. */
const nearestLocation = (coordinates: { latitude: number; longitude: number }) =>
  mockLocations.reduce((nearest, candidate) =>
    distanceKm(coordinates, candidate) < distanceKm(coordinates, nearest) ? candidate : nearest,
  );

export function LocationSelector({ value, error, onChange }: LocationSelectorProps) {
  const [query, setQuery] = useState(value?.label ?? "");
  const [locating, setLocating] = useState(false);
  const [snappedFrom, setSnappedFrom] = useState<string | null>(null);

  const suggestions = useMemo(() => {
    const normalizedQuery = normalizeLocationText(query);
    if (!normalizedQuery || value?.label === query) return [];
    const queryTokens = normalizedQuery.split(" ");
    return mockLocations
      .filter((location) => {
        const searchableText = normalizeLocationText(
          [location.label, ...location.searchTerms].join(" "),
        );
        return queryTokens.every((token) => searchableText.includes(token));
      })
      .sort((first, second) => {
        const firstStarts = normalizeLocationText(first.label).startsWith(normalizedQuery);
        const secondStarts = normalizeLocationText(second.label).startsWith(normalizedQuery);
        return Number(secondStarts) - Number(firstStarts);
      })
      .slice(0, 7);
  }, [query, value]);

  const selectLocation = (location: SearchLocation) => {
    setQuery(location.label);
    setSnappedFrom(null);
    onChange(location);
  };

  /**
   * IT SNAPS TO THE NEAREST COMMITTED MARKET AND NEVER WRITES THE DEVICE'S COORDINATES, and that
   * is two separate guards in one line.
   *
   * 1. PRIVACY. `migrations/0005` seeds a PUBLIC LANDMARK "chosen so that a leaked collector token
   *    does not disclose the operator's home", and says in its own comment that the settings UI
   *    must preserve that property. The shipped button wrote `position.coords.*` straight into the
   *    settings object, so the first use of it put the operator's home in a row a collector
   *    credential can read.
   * 2. THE AGGREGATE. `market_key` buckets coordinates at 4 decimal places (~11 m), so GPS jitter
   *    alone forks the benchmark into a new bucket on every save. A catalog entry is a fixed point.
   *
   * It also has to snap because `SearchLocation` now carries a `slug`: a device fix has no Facebook
   * URL path segment, and inventing one is what §3.2 measured as accepting nonsense.
   */
  const useCurrentLocation = () => {
    setLocating(true);
    if (!navigator.geolocation) {
      setLocating(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nearest = nearestLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
        setQuery(nearest.label);
        onChange(nearest);
        setSnappedFrom(nearest.label);
        setLocating(false);
      },
      () => setLocating(false),
      { timeout: 8_000 },
    );
  };

  return (
    <div className="form-section" id="location">
      <div className="section-heading">
        <div>
          <h2>Location</h2>
          <p>Search by city, postal code, or address.</p>
        </div>
      </div>

      <div className="location-row">
        <div className="autocomplete">
          <label htmlFor="location-search">Search location</label>
          <input
            aria-describedby={error ? "location-error" : undefined}
            aria-invalid={Boolean(error)}
            id="location-search"
            type="search"
            value={query}
            placeholder="City, postal code, or street address"
            onChange={(event) => {
              const nextQuery = event.target.value;
              setQuery(nextQuery);
              if (value && nextQuery !== value.label) onChange(null);
            }}
          />
          {suggestions.length > 0 && (
            <ul className="suggestions" aria-label="Location suggestions">
              {suggestions.map((location) => (
                <li key={location.label}>
                  <button type="button" onClick={() => selectLocation(location)}>
                    {location.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {query.trim().length >= 2 && suggestions.length === 0 && value?.label !== query && (
            <p className="location-hint">
              No prototype match yet. Try a municipality, Ontario postal code, or a fuller address.
            </p>
          )}
        </div>
        <button
          className="secondary-button location-button"
          disabled={locating}
          type="button"
          onClick={useCurrentLocation}
        >
          {locating ? "Locating…" : "Use current location"}
        </button>
      </div>

      {snappedFrom !== null && (
        <p className="location-hint">
          Nearest match: {snappedFrom}. Your exact coordinates are never saved.
        </p>
      )}
      {value && <p className="selected-location">Selected: {value.label}</p>}
      {error && (
        <p className="field-error" id="location-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
