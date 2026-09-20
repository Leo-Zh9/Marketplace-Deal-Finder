import { useMemo, useState } from "react";
import { componentById } from "../data/catalog";
import type { ComponentType, ModelSelection } from "../types";

interface ModelSelectorProps {
  componentType: ComponentType;
  selection: ModelSelection;
  onChange: (selection: ModelSelection) => void;
}

export function ModelSelector({
  componentType,
  selection,
  onChange,
}: ModelSelectorProps) {
  const [query, setQuery] = useState("");
  const component = componentById[componentType];
  const filteredModels = useMemo(
    () =>
      component.models.filter((model) =>
        model.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [component.models, query],
  );

  const toggleModel = (model: string) => {
    const values =
      selection.mode === "all"
        ? [...component.models]
        : selection.mode === "selected"
          ? selection.values
          : [];
    const nextValues = values.includes(model)
      ? values.filter((value) => value !== model)
      : [...values, model];

    onChange(
      nextValues.length === component.models.length
        ? { mode: "all", values: [...component.models] }
        : nextValues.length > 0
          ? { mode: "selected", values: nextValues }
          : { mode: "none", values: [] },
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
        <label className="search-field">
          <span className="sr-only">Search {component.label} models</span>
          <input
            type="search"
            value={query}
            placeholder={`Search ${component.label} models`}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <label className="select-all-models">
          <input
            checked={selection.mode === "all"}
            type="checkbox"
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? { mode: "all", values: [...component.models] }
                  : { mode: "none", values: [] },
              )
            }
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
