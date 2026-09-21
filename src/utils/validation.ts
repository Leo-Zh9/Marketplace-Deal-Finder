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

  // The floor is 1, not 0.1, because `worker/storage/marketKey.ts` buckets the radius with
  // Math.round and THROWS below 1 km -- and it is called once per page, outside every
  // per-listing guard, so a 0.3 km radius does not skip a listing, it kills the whole scan.
  // Nothing is lost: marketKey already collapses 0.4 km and 1.4 km to the same market key,
  // so sub-kilometre precision has never reached anything downstream.
  if (settings.radiusKm < 1 || settings.radiusKm > 49.9) {
    errors.radius = "Radius must be between 1 and 49.9 km.";
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
