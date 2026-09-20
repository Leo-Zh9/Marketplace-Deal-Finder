import { componentCatalog } from "../data/catalog";
import type { ComponentType } from "../types";

interface ComponentSelectorProps {
  selected: ComponentType[];
  error?: string;
  onToggle: (component: ComponentType) => void;
}

export function ComponentSelector({
  selected,
  error,
  onToggle,
}: ComponentSelectorProps) {
  return (
    <fieldset
      className="form-section"
      id="components"
      aria-describedby={error ? "components-error" : undefined}
    >
      <div className="section-heading">
        <div>
          <legend>Components</legend>
          <p>Choose one or more parts to watch.</p>
        </div>
        <span className="selection-count">{selected.length} selected</span>
      </div>

      <div className="component-grid">
        {componentCatalog.map((component) => {
          const isSelected = selected.includes(component.id);
          return (
            <label
              className={`component-option${isSelected ? " component-option--selected" : ""}`}
              key={component.id}
            >
              <input
                aria-label={`${component.label}: ${component.description}`}
                checked={isSelected}
                type="checkbox"
                onChange={() => onToggle(component.id)}
              />
              <span>
                <strong>{component.label}</strong>
                <small>{component.description}</small>
              </span>
            </label>
          );
        })}
      </div>

      {error && (
        <p className="field-error" id="components-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
