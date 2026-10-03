// CROSS-BOUNDARY IMPORT, DELIBERATE: the whole point of these tests is that the validator and
// the market key agree, and asserting that against a copy of marketKey's rule would assert
// nothing. It has a cost worth knowing before you edit `worker/storage/marketKey.ts`: this
// pulls that file into the FRONTEND `tsc -b` program, which has no `@cloudflare/workers-types`.
// A worker-only change that reaches for a Workers global will fail `npm run build` with a
// confusing frontend error while `typecheck:worker` stays green. Keep marketKey dependency-free.
import { marketKey } from "../../worker/storage/marketKey";
import type { ComponentType, ModelSelection, SearchSettings } from "../types";
import {
  derivedTargetCount,
  MAX_WATCH_TARGETS,
  RADIUS_MESSAGE,
  validateSearchSettings,
} from "./validation";

// Everything except the field under test is held valid.
const settingsWith = (over: Partial<SearchSettings> = {}): SearchSettings => ({
  components: ["gpu"],
  models: {},
  queries: {},
  location: { label: "Waterloo, ON", slug: "waterloo", latitude: 43.4643, longitude: -80.5204 },
  radiusKm: 25,
  dealRule: { type: "discount", minimumDiscountPercent: 25, maximumPriceCad: "" },
  ...over,
});

const radiusError = (radiusKm: number) =>
  validateSearchSettings(settingsWith({ radiusKm }), 0).radius;

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

  /**
   * THE CEILING IS 25 AND THE VALUE MUST BE WHOLE, because that is what the column stores:
   * `CHECK (typeof(radius_km) = 'integer' AND radius_km >= 1 AND radius_km <= 25)`. The shipped
   * validator admitted `1 <= r <= 49.9` with non-integers included, and the shipped control was
   * `min="0.1" max="49.9" step="0.1"` -- so both 12.5 and 49.9 were reachable and unstorable, and
   * 12.5 reaches that CHECK as a 503 that tells the user the service is broken.
   */
  it("accepts the boundaries, rejects just outside them, and rejects every non-integer", () => {
    expect(radiusError(1)).toBeUndefined();
    expect(radiusError(25)).toBeUndefined();
    expect(radiusError(0.9)).toBe(RADIUS_MESSAGE);
    expect(radiusError(26)).toBe(RADIUS_MESSAGE);
    expect(radiusError(49.9)).toBe(RADIUS_MESSAGE);
    expect(radiusError(12.5)).toBe(RADIUS_MESSAGE);
    expect(radiusError(24.5)).toBe(RADIUS_MESSAGE);
  });

  it("accepts no radius the market key would reject, across the whole 0.1 km input grid", () => {
    // The property is one-directional on purpose -- validation may be STRICTER than marketKey (it
    // is, at the top end and on every non-integer) but must never be LOOSER, which is exactly what
    // the defect was.
    //
    // READ THE ANCHOR BELOW, NOT THIS LOOP, AS THE PIN ON THE FLOOR. marketKey's true floor is
    // 0.5, not 1: it rejects on `Math.round(radiusKm) < 1`, and Math.round(0.5) is 1. So a
    // validator floor set anywhere in [0.5, 1] still satisfies "accepts implies marketKey does
    // not throw" and this loop would pass. `toHaveLength(25)` is what actually fixes the floor at
    // 1 AND the integer rule: on a 0.1 grid from 0.1 to 50.0 there are 25 whole kilometres in
    // [1, 25] and 500 values in total.
    const accepted: number[] = [];
    for (let step = 1; step <= 500; step += 1) {
      const radiusKm = Math.round(step * 10) / 100;
      if (radiusError(radiusKm) !== undefined) continue;
      accepted.push(radiusKm);
      expect(() =>
        marketKey({ latitude: 43.4643, longitude: -80.5204, radiusKm }),
      ).not.toThrow();
    }
    expect(accepted).toHaveLength(25);
    expect(accepted[0]).toBe(1);
    expect(accepted[accepted.length - 1]).toBe(25);
  });

  it("rejects non-finite input, which the range comparisons alone let through", () => {
    // THE SAME DEFECT THROUGH A DIFFERENT DOOR. `NaN < 1` and `NaN > 25` are BOTH false, so a
    // comparison-only validator returns NO error and hands NaN to marketKey -- which rejects
    // `!Number.isFinite` and throws, outside every per-listing guard, killing the whole scan.
    for (const radiusKm of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(radiusError(radiusKm), `radiusKm ${radiusKm}`).toBe(RADIUS_MESSAGE);
      expect(() =>
        marketKey({ latitude: 43.4643, longitude: -80.5204, radiusKm }),
      ).toThrow();
    }
  });
});

/**
 * V-val: THE TARGET-COUNT RULE, WHICH GATES BOTH PREVIEW AND SAVE. `MAX_TARGETS_PER_RUN` REFUSES
 * rather than truncating -- a list over the cap collects NOTHING, on every run, with exit 2 -- so
 * the form has to refuse first. It also bounds the preview's `?pairs` list: MEASURED, 183 bytes
 * url-encoded for a 5-pair selection against 14,367 for the unbounded all-models worst case the
 * cap makes unreachable.
 */
describe("the target-count rule", () => {
  const selected = (count: number): ModelSelection => ({
    mode: "selected",
    values: Array.from({ length: count }, (_, index) => `model-${index}`),
  });

  it("counts one target per mode:all type and one per named model", () => {
    const components: ComponentType[] = ["gpu", "cpu", "ram"];
    expect(
      derivedTargetCount(components, {
        gpu: selected(3),
        cpu: { mode: "all", values: [] },
        // An absent selection is `all`, which is one target and not zero.
      }),
    ).toBe(5);
    expect(derivedTargetCount(components, { gpu: { mode: "none", values: [] } })).toBe(2);
    expect(derivedTargetCount([], {})).toBe(0);
  });

  it("refuses zero targets and names the cap", () => {
    const errors = validateSearchSettings(
      settingsWith({ models: { gpu: { mode: "none", values: [] } } }),
      0,
    );
    expect(errors.targets).toBe("0 of 9 searches used — select a component to search.");
  });

  /**
   * THE KEPT SEARCHES ARE PART OF THE COUNT, and this is the row that says so. Counting only the
   * derived targets lets production's 6 derived rows be saved beside 3 kept ones -- the cap spent
   * twice -- and the refusal then arrives from the collector, as silence.
   */
  it("counts kept searches, and says REMOVE rather than deselect", () => {
    expect(validateSearchSettings(settingsWith(), 8).targets).toBeUndefined();
    const over = validateSearchSettings(settingsWith(), 9).targets;
    expect(over).toBe("10 of 9 searches used — remove a kept search or narrow fewer models.");
    // MEASURED CONSEQUENCE OF THE SYMMETRIC PRESERVATION RULE: deselecting a component converts a
    // derived slot into a KEPT one, so "deselect a component" is advice that does not work.
    expect(over).not.toContain("deselect");
  });

  it("refuses a model selection that exceeds the cap on its own", () => {
    const errors = validateSearchSettings(
      settingsWith({ models: { gpu: selected(MAX_WATCH_TARGETS + 1) } }),
      0,
    );
    expect(errors.targets).toContain(`${MAX_WATCH_TARGETS + 1} of ${MAX_WATCH_TARGETS}`);
  });
});
