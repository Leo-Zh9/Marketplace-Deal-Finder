import { componentById } from "../data/catalog";
import type { ComponentType } from "../types";

interface ComponentFiltersProps {
  components: ComponentType[];
  values: Partial<Record<ComponentType, Record<string, string>>>;
  onChange: (component: ComponentType, key: string, value: string) => void;
}

export function ComponentFilters({
  components,
  values,
  onChange,
}: ComponentFiltersProps) {
  return (
    <details className="more-filters">
      <summary>
        <span>
          <strong>More filters</strong>
          <small>Optional compatibility and specification filters</small>
        </span>
        <span aria-hidden="true" className="summary-caret">⌄</span>
      </summary>

      <div className="filter-groups">
        {components.length === 0 ? (
          <p className="muted-copy">Select a component to see its filters.</p>
        ) : (
          components.map((componentType) => {
            const component = componentById[componentType];
            return (
              <fieldset className="filter-group" key={componentType}>
                <legend>{component.label}</legend>
                <div className="filter-grid">
                  {component.filters.map((filter) => (
                    <label key={filter.key}>
                      <span>{filter.label}</span>
                      {filter.kind === "select" ? (
                        <select
                          value={values[componentType]?.[filter.key] ?? "Any"}
                          onChange={(event) =>
                            onChange(componentType, filter.key, event.target.value)
                          }
                        >
                          {filter.options?.map((option) => (
                            <option key={option}>{option}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          min={filter.kind === "number" ? "0" : undefined}
                          placeholder={filter.placeholder}
                          type={filter.kind}
                          value={values[componentType]?.[filter.key] ?? ""}
                          onChange={(event) =>
                            onChange(componentType, filter.key, event.target.value)
                          }
                        />
                      )}
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          })
        )}
      </div>
    </details>
  );
}
