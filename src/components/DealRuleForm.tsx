import type { DealRule } from "../types";
import type { ValidationErrors } from "../utils/validation";

interface DealRuleFormProps {
  value: DealRule;
  errors: ValidationErrors;
  onChange: (dealRule: DealRule) => void;
}

export function DealRuleForm({ value, errors, onChange }: DealRuleFormProps) {
  const showDiscount = value.type !== "maximum_price";
  const showMaximum = value.type !== "discount";

  const setCriteria = (discount: boolean, maximum: boolean) => {
    if (!discount && !maximum) return;
    onChange({
      ...value,
      type: discount && maximum ? "both" : discount ? "discount" : "maximum_price",
    });
  };

  return (
    <div className="form-section" id="deal-rule">
      <div className="section-heading">
        <div>
          <h2>Deal rule</h2>
          <p>Choose what makes a listing worth showing.</p>
        </div>
      </div>

      <div className="criteria-options" aria-label="Deal criteria">
        <label className={showDiscount ? "criteria-option criteria-option--selected" : "criteria-option"}>
          <input
            checked={showDiscount}
            type="checkbox"
            onChange={(event) => setCriteria(event.target.checked, showMaximum)}
          />
          <span>
            <strong>Minimum discount</strong>
            <small>Compare with the market average</small>
          </span>
        </label>
        <label className={showMaximum ? "criteria-option criteria-option--selected" : "criteria-option"}>
          <input
            checked={showMaximum}
            type="checkbox"
            onChange={(event) => setCriteria(showDiscount, event.target.checked)}
          />
          <span>
            <strong>Maximum price</strong>
            <small>Set an absolute spending limit</small>
          </span>
        </label>
      </div>

      <div className="deal-fields">
        {showDiscount && (
          <label>
            <span>Minimum discount (%)</span>
            <input
              aria-invalid={Boolean(errors.minimumDiscount)}
              max="99"
              min="1"
              type="number"
              value={value.minimumDiscountPercent}
              onChange={(event) =>
                onChange({
                  ...value,
                  minimumDiscountPercent: Number(event.target.value),
                })
              }
            />
            {errors.minimumDiscount && (
              <small className="field-error" role="alert">{errors.minimumDiscount}</small>
            )}
          </label>
        )}

        {showMaximum && (
          <label>
            <span>Maximum price (CAD)</span>
            <div className="money-input">
              <span aria-hidden="true">$</span>
              <input
                aria-invalid={Boolean(errors.maximumPrice)}
                inputMode="decimal"
                min="0.01"
                placeholder="0.00"
                step="0.01"
                type="number"
                value={value.maximumPriceCad}
                onChange={(event) =>
                  onChange({ ...value, maximumPriceCad: event.target.value })
                }
              />
            </div>
            {errors.maximumPrice && (
              <small className="field-error" role="alert">{errors.maximumPrice}</small>
            )}
          </label>
        )}
      </div>
    </div>
  );
}
