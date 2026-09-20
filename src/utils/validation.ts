import type { SearchSettings } from "../types";

export interface ValidationErrors {
  components?: string;
  location?: string;
  radius?: string;
  minimumDiscount?: string;
  maximumPrice?: string;
}

export const validateSearchSettings = (
  settings: SearchSettings,
): ValidationErrors => {
  const errors: ValidationErrors = {};

  if (settings.components.length === 0) {
    errors.components = "Select at least one component.";
  }

  if (!settings.location) {
    errors.location = "Choose a location.";
  }

  if (settings.radiusKm < 0.1 || settings.radiusKm > 49.9) {
    errors.radius = "Radius must be between 0.1 and 49.9 km.";
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
