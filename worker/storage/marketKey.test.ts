// @vitest-environment node

import { marketKey } from "./marketKey";

// Test 12 -- marketKey unit.
describe("marketKey", () => {
  it("produces the spec's canonical form", () => {
    expect(marketKey({ latitude: 43.4643, longitude: -80.5204, radiusKm: 25 })).toBe(
      "43.4643,-80.5204|25km",
    );
  });

  it("rounds a tiny negative and a tiny positive to the SAME key", () => {
    // The rounding is what does this. `toFixed` alone keeps the sign --
    // `(-0.00004).toFixed(4)` is "-0.0000" against "0.0000" for the positive -- which is two
    // market keys for one market, forking that aggregate forever. No negative-zero guard is
    // involved: `(-0).toFixed(4)` is already "0.0000".
    const negative = marketKey({ latitude: -0.00004, longitude: -0.00004, radiusKm: 25 });
    const positive = marketKey({ latitude: 0.00004, longitude: 0.00004, radiusKm: 25 });

    expect(negative).toBe(positive);
    expect(negative).toBe("0.0000,0.0000|25km");
    expect(negative).not.toContain("-0.0000");
  });

  it("collapses a negative zero rather than formatting it", () => {
    expect(marketKey({ latitude: -0, longitude: -0, radiusKm: 25 })).toBe("0.0000,0.0000|25km");
    // Just under the rounding boundary on the negative side, from both directions.
    expect(marketKey({ latitude: -0.00001, longitude: -0.00004, radiusKm: 25 })).toBe(
      "0.0000,0.0000|25km",
    );
  });

  it("buckets coordinates at four decimal places so a nudged pin does not fork the market", () => {
    expect(marketKey({ latitude: 43.46431, longitude: -80.52041, radiusKm: 25 })).toBe(
      marketKey({ latitude: 43.46434, longitude: -80.52044, radiusKm: 25 }),
    );
  });

  it("changes the key when the radius changes", () => {
    expect(marketKey({ latitude: 43.4643, longitude: -80.5204, radiusKm: 25 })).not.toBe(
      marketKey({ latitude: 43.4643, longitude: -80.5204, radiusKm: 50 }),
    );
    expect(marketKey({ latitude: 43.4643, longitude: -80.5204, radiusKm: 50 })).toBe(
      "43.4643,-80.5204|50km",
    );
  });

  it("is injective: no two different rounded triples share a key", () => {
    const keys = [
      marketKey({ latitude: 43.46, longitude: -80.4, radiusKm: 25 }),
      marketKey({ latitude: 43.464, longitude: -80.4, radiusKm: 25 }),
      marketKey({ latitude: 43.4, longitude: -80.46, radiusKm: 25 }),
      marketKey({ latitude: 43.4, longitude: -80.4, radiusKm: 4 }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("throws rather than formatting out-of-range or non-finite input", () => {
    // toFixed happily returns "NaN" and "1e+21" for pathological input, which would become
    // a market key nothing could ever match.
    expect(() => marketKey({ latitude: Number.NaN, longitude: 0, radiusKm: 25 })).toThrow();
    expect(() => marketKey({ latitude: Number.POSITIVE_INFINITY, longitude: 0, radiusKm: 25 })).toThrow();
    expect(() => marketKey({ latitude: 90.0001, longitude: 0, radiusKm: 25 })).toThrow();
    expect(() => marketKey({ latitude: -90.0001, longitude: 0, radiusKm: 25 })).toThrow();
    expect(() => marketKey({ latitude: 0, longitude: 180.0001, radiusKm: 25 })).toThrow();
    expect(() => marketKey({ latitude: 0, longitude: -180.0001, radiusKm: 25 })).toThrow();
    expect(() => marketKey({ latitude: 0, longitude: 0, radiusKm: Number.NaN })).toThrow();
    expect(() => marketKey({ latitude: 0, longitude: 0, radiusKm: 0.4 })).toThrow();
    expect(() => marketKey({ latitude: 0, longitude: 0, radiusKm: 0 })).toThrow();
  });

  it("accepts the range boundaries", () => {
    expect(marketKey({ latitude: 90, longitude: 180, radiusKm: 1 })).toBe("90.0000,180.0000|1km");
    expect(marketKey({ latitude: -90, longitude: -180, radiusKm: 1 })).toBe(
      "-90.0000,-180.0000|1km",
    );
  });
});
