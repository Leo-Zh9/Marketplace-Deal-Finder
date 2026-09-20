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

export function LocationSelector({ value, error, onChange }: LocationSelectorProps) {
  const [query, setQuery] = useState(value?.label ?? "");
  const [locating, setLocating] = useState(false);

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
    onChange(location);
  };

  const useCurrentLocation = () => {
    setLocating(true);
    if (!navigator.geolocation) {
      setLocating(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        selectLocation({
          label: "Current location",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
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

      {value && <p className="selected-location">Selected: {value.label}</p>}
      {error && (
        <p className="field-error" id="location-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
