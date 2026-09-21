import { marketKey } from "../../worker/storage/marketKey";
import type { SearchSettings } from "../types";
import { validateSearchSettings } from "./validation";

const RADIUS_MESSAGE = "Radius must be between 1 and 49.9 km.";

// Everything except radiusKm is held valid so `errors.radius` is the only field under test.
const settingsWith = (radiusKm: number): SearchSettings => ({
  components: ["gpu"],
  models: {},
  location: { label: "Waterloo, ON", latitude: 43.4643, longitude: -80.5204 },
  radiusKm,
  filters: {},
  dealRule: { type: "discount", minimumDiscountPercent: 25, maximumPriceCad: "" },
});

const radiusError = (radiusKm: number) => validateSearchSettings(settingsWith(radiusKm)).radius;

describe("search radius validation", () => {
  it("rejects a sub-kilometre radius that would throw in marketKey", () => {
    // The defect, at the value the audit used: the UI accepted 0.3 km, marketKey rounds it to
    // 0 and throws, and recordSightings calls marketKey once per page OUTSIDE every
    // per-listing guard -- so the whole scan dies rather than one listing being skipped.
    expect(radiusError(0.3)).toBe(RADIUS_MESSAGE);
    expect(() =>
      marketKey({ latitude: 43.4643, longitude: -80.5204, radiusKm: 0.3 }),
    ).toThrow(/rounding to >= 1/);
  });

  it("accepts the boundaries and rejects just outside them", () => {
    expect(radiusError(1)).toBeUndefined();
    expect(radiusError(49.9)).toBeUndefined();
    expect(radiusError(0.9)).toBe(RADIUS_MESSAGE);
    expect(radiusError(50)).toBe(RADIUS_MESSAGE);
  });

  it("accepts no radius the market key would reject, across the whole 0.1 km input grid", () => {
    // `App.tsx` renders the custom radius as <input type="number" step="0.1">, so this is the
    // full set of values a user can produce, not a sample of it. The property is
    // one-directional on purpose -- validation may be STRICTER than marketKey (it is, at the
    // top end) but must never be looser, which is exactly what the defect was.
    const accepted: number[] = [];
    for (let step = 1; step <= 500; step += 1) {
      const radiusKm = Math.round(step * 10) / 100;
      if (radiusError(radiusKm) !== undefined) continue;
      accepted.push(radiusKm);
      expect(() =>
        marketKey({ latitude: 43.4643, longitude: -80.5204, radiusKm }),
      ).not.toThrow();
    }
    // Anchored with a literal count: an empty `accepted` would satisfy the loop vacuously.
    // 1.0 to 49.9 on a 0.1 grid is 490 values, and both ends are named.
    expect(accepted).toHaveLength(490);
    expect(accepted[0]).toBe(1);
    expect(accepted[accepted.length - 1]).toBe(49.9);
  });
});
