import { useMemo, useState } from "react";
import { componentById } from "../data/catalog";
import { allSelection, noneSelection } from "../utils/validation";
import type { ComponentType, ModelSelection } from "../types";

interface ModelSelectorProps {
  componentType: ComponentType;
  selection: ModelSelection;
  /** The query this type searches with under `mode:"all"` -- the STORED one where there is one. */
  query: string;
  onChange: (selection: ModelSelection) => void;
}

export function ModelSelector({
  componentType,
  selection,
  query,
  onChange,
}: ModelSelectorProps) {
  const [search, setSearch] = useState("");
  const component = componentById[componentType];
  const filteredModels = useMemo(
    () =>
      component.models.filter((model) =>
        model.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [component.models, search],
  );

  const toggleModel = (model: string) => {
    // FROM `all`, THE FIRST CLICK SELECTS THAT MODEL -- it does not deselect the other 67.
    // MEASURED with the real component rendered: expanding `component.models` first made the first
    // click produce 67 values -> 67 targets -> "67 of 9 searches used" and a disabled Save, so the
    // budget was unreachable in one click. It is also what the user means by ticking one model.
    if (selection.mode === "all") {
      onChange({ mode: "selected", values: [model] });
      return;
    }
    const values = selection.mode === "selected" ? selection.values : [];
    const nextValues = values.includes(model)
      ? values.filter((value) => value !== model)
      : [...values, model];

    onChange(
      // `values` IS EMPTY UNDER `all`: one of the four sites the shipped code broke the wire
      // invariant at by writing `[...component.models]` here.
      nextValues.length === component.models.length
        ? allSelection()
        : nextValues.length > 0
          ? { mode: "selected", values: nextValues }
          : noneSelection(),
    );
  };

  const summary =
    selection.mode === "all"
      ? `All ${component.models.length} models`
      : selection.mode === "none"
        ? "No models"
        : `${selection.values.length} of ${component.models.length} models`;

  return (
    <details className="model-selector">
      <summary>
        <span>
          <strong>{component.label} models</strong>
          <small>{summary}</small>
        </span>
        <span aria-hidden="true" className="summary-caret">⌄</span>
      </summary>

      <div className="model-selector__body">
        {/*
         * THE QUERY IS SHOWN, NOT HIDDEN. The operator's live rows are free-text queries this form
         * cannot author -- `ryzen`, `ddr4 ram` -- and a form that saves a query it never displayed
         * is how one gets rewritten. Under `all` this is the one search the type spends; under
         * `selected` it is one search per model, which is what builds a price benchmark.
         */}
        {selection.mode === "all" ? (
          <p className="muted-copy">
            Searches Facebook for “{query}” — one search for all {component.models.length} models.
          </p>
        ) : selection.mode === "selected" ? (
          <p className="muted-copy">
            One search per model. A model-named search returns that model&rsquo;s listings instead
            of a page of assorted {component.label} cards, which is what builds a price benchmark.
          </p>
        ) : null}

        <label className="search-field">
          <span className="sr-only">Search {component.label} models</span>
          <input
            type="search"
            value={search}
            placeholder={`Search ${component.label} models`}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>

        <label className="select-all-models">
          <input
            checked={selection.mode === "all"}
            type="checkbox"
            onChange={(event) => onChange(event.target.checked ? allSelection() : noneSelection())}
          />
          <span>Select all {component.models.length} models</span>
        </label>

        <div className="model-options">
          {filteredModels.map((model) => (
            <label key={model}>
              <input
                checked={
                  selection.mode === "all" ||
                  (selection.mode === "selected" && selection.values.includes(model))
                }
                type="checkbox"
                onChange={() => toggleModel(model)}
              />
              <span>{model}</span>
            </label>
          ))}
          {filteredModels.length === 0 && (
            <p className="muted-copy">No matching models.</p>
          )}
        </div>
      </div>
    </details>
  );
}
