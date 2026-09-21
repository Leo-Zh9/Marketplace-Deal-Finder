/**
 * The market an aggregate belongs to: a location and a search radius.
 *
 * Aggregates must not mix unrelated search regions, so this key scopes every
 * model_stats row. Two bucketing decisions define what "the same market" means:
 * coordinates round to 4 decimal places (about 11 m) so a user nudging the map pin
 * does not fork the aggregate, and the radius rounds to whole kilometres.
 */

export interface Market {
  latitude: number;
  longitude: number;
  radiusKm: number;
}

/**
 * THE `Math.round` IS LOAD-BEARING, and not only for precision: it is what stops a tiny
 * negative coordinate forking the aggregate.
 *
 * `toFixed` alone preserves the sign of a small negative -- `(-0.00004).toFixed(4)` is
 * "-0.0000" while `(0.00004).toFixed(4)` is "0.0000", which is two market keys for one
 * market. Rounding first collapses both to a zero before formatting, and `(-0).toFixed(4)`
 * is already "0.0000" in V8, so **no explicit negative-zero guard is needed**.
 *
 * An earlier version of this function carried `const n = r === 0 ? 0 : r` for that purpose.
 * It was dead code: verified over the edge set (+/-0.00004, +/-0.00005, -0, +/-90, +/-180)
 * plus 2,000,000 random coordinates, removing it changes nothing. It was removed rather
 * than kept, because a line whose stated justification is untrue outlives every reviewer
 * who does not re-derive it.
 */
const fixed = (x: number): string => (Math.round(x * 1e4) / 1e4).toFixed(4);

/**
 * Canonical form, e.g. `43.4643,-80.5204|25km`.
 *
 * Each field is a fixed-format decimal with exactly four fraction digits over the
 * alphabet [-0-9.]; the separators `,` and `|` and the terminator `km` are outside
 * that alphabet, so the string parses back to exactly one (lat, lon, radius) triple.
 * The map is therefore injective -- a separator-free concatenation could collide
 * ("43.46" + "4" vs "43.464" + ""), which is what the separators rule out.
 *
 * Validation runs before formatting because `toFixed` happily returns "NaN" and
 * "1e+21" for pathological inputs; those must throw rather than format.
 */
export const marketKey = (market: Market): string => {
  const { latitude, longitude, radiusKm } = market;

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error(`marketKey: latitude must be a finite number in [-90, 90]: ${latitude}`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error(
      `marketKey: longitude must be a finite number in [-180, 180]: ${longitude}`,
    );
  }
  if (!Number.isFinite(radiusKm) || Math.round(radiusKm) < 1) {
    throw new Error(`marketKey: radiusKm must be a finite number rounding to >= 1: ${radiusKm}`);
  }

  return `${fixed(latitude)},${fixed(longitude)}|${Math.round(radiusKm)}km`;
};
