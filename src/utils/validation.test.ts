// CROSS-BOUNDARY IMPORT, DELIBERATE: the whole point of these tests is that the validator and
// the market key agree, and asserting that against a copy of marketKey's rule would assert
// nothing. It has a cost worth knowing before you edit `worker/storage/marketKey.ts`: this
// pulls that file into the FRONTEND `tsc -b` program, which has no `@cloudflare/workers-types`.
// A worker-only change that reaches for a Workers global will fail `npm run build` with a
// confusing frontend error while `typecheck:worker` stays green. Keep marketKey dependency-free.
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
    // grid the UI is BUILT around -- not, strictly, every value a user can produce, since
    // `step` constrains the spinner and not what a keyboard can type. The property is
    // one-directional on purpose -- validation may be STRICTER than marketKey (it is, at the
    // top end) but must never be looser, which is exactly what the defect was.
    //
    // READ THE ANCHOR BELOW, NOT THIS LOOP, AS THE PIN ON THE FLOOR. marketKey's true floor is
    // 0.5, not 1: it rejects on `Math.round(radiusKm) < 1`, and Math.round(0.5) is 1. So a
    // validator floor set anywhere in [0.5, 1] still satisfies "accepts implies marketKey does
    // not throw" and this loop would pass. `toHaveLength(490)` is what actually fixes the
    // floor at 1; the loop proves the direction, the literal proves the value.
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

  it("rejects non-finite input, which the range comparisons alone let through", () => {
    // THE SAME DEFECT AS D2, THROUGH A DIFFERENT DOOR. `NaN < 1` and `NaN > 49.9` are BOTH
    // false, so a comparison-only validator returns NO error and hands NaN to marketKey --
    // which rejects `!Number.isFinite` and throws, outside every per-listing guard, killing
    // the whole scan. That is exactly the shape this PR exists to fix, so leaving a live
    // instance of it behind while the test file above asserts validation is "never looser
    // than marketKey" would make that stated property false in shipping text.
    //
    // No UI path produces NaN today -- both `radiusKm` writers are `Number()` over
    // browser-sanitised input. This pins the property, not a reachable bug.
    for (const radiusKm of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(radiusError(radiusKm), `radiusKm ${radiusKm}`).toBe(RADIUS_MESSAGE);
      expect(() =>
        marketKey({ latitude: 43.4643, longitude: -80.5204, radiusKm }),
      ).toThrow();
    }
  });
});
