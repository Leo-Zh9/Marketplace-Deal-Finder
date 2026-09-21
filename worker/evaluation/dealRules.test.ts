// @vitest-environment node

import {
  decide,
  discountBasisPoints,
  referenceAverageCents,
  validateSettings,
  type ValidatedSettings,
} from "./dealRules";
import type { CandidateReference, DealMode, EvaluationSettings } from "./types";

/**
 * Settings always go through validateSettings, so these tests exercise the same object the
 * production path builds -- not a hand-written ValidatedSettings that could drift from it.
 */
const settingsFor = (overrides: Partial<EvaluationSettings> & { mode: DealMode }): ValidatedSettings =>
  validateSettings({
    minimumDiscountPercent: null,
    maximumPriceCents: null,
    searchRevision: 1,
    ...overrides,
  });

const DISCOUNT_20 = settingsFor({ mode: "DISCOUNT", minimumDiscountPercent: 20 });

/**
 * A candidate whose fields are all healthy, so every test below changes exactly the one field
 * it is about and a mutation cannot hide behind a second broken input.
 */
const candidate = (overrides: Partial<CandidateReference>): CandidateReference => ({
  candidatePriceCents: 18_400,
  validity: "VALID",
  referenceCount: 5,
  referenceTotalCents: 115_000,
  ...overrides,
});

describe("dealRules -- the discount comparison", () => {
  // R1. Five comparables totalling 115000 -> average 23000; 20% off is 18400 exactly.
  // The verdict is decided by `<=` AT EQUALITY, which is where every marginal deal lives.
  it("R1: is a deal at exactly the threshold and not one cent above it", () => {
    expect(decide(candidate({ candidatePriceCents: 18_400 }), DISCOUNT_20)).toEqual({
      verdict: "DEAL",
      status: "COMPLETE",
      reason: "within-discount",
    });
    expect(decide(candidate({ candidatePriceCents: 18_401 }), DISCOUNT_20)).toEqual({
      verdict: "NOT_DEAL",
      status: "COMPLETE",
      reason: "above-discount-threshold",
    });
  });

  // R2. Five comparables totalling $107.50 (average $21.50), a 6% minimum discount, a candidate
  // at $20.21. Exactly: 2021 * 5 * 10000 = 101,050,000 and 10750 * 9400 = 101,050,000 -- equal,
  // so `<=` holds and it is a deal.
  //
  // THE FLOAT DRIFT IS IN THE PRODUCT, NOT THE SUBTRACTION. `1 - 0.06` is EXACTLY 0.94 in
  // IEEE-754. The loss is `2150 * 0.94 === 2020.9999999999998`, which makes `2021 <= ...` false
  // and throws this deal away. Any fix aimed at the subtraction is aimed at the wrong line.
  it("R2: catches the marginal deal a float product would lose", () => {
    const settings = settingsFor({ mode: "DISCOUNT", minimumDiscountPercent: 6 });
    expect(2150 * 0.94).toBe(2020.9999999999998); // the drift, pinned where it actually is
    expect(
      decide(
        candidate({ candidatePriceCents: 2021, referenceCount: 5, referenceTotalCents: 10_750 }),
        settings,
      ),
    ).toEqual({ verdict: "DEAL", status: "COMPLETE", reason: "within-discount" });
  });

  // R3. The reported average and the verdict DISAGREE, on purpose. round(100003/5) = 20001,
  // so an implementation that compared against the reported average would call this a deal.
  // Exactly: 20001 * 5 * 10000 = 1,000,050,000 > 100003 * 10000 = 1,000,030,000.
  // referenceAverageCents is a REPORT, never an input.
  it("R3: does not use the reported average as the comparison input", () => {
    const settings = settingsFor({ mode: "DISCOUNT", minimumDiscountPercent: 0 });
    expect(referenceAverageCents(100_003, 5)).toBe(20_001);
    expect(
      decide(
        candidate({ candidatePriceCents: 20_001, referenceCount: 5, referenceTotalCents: 100_003 }),
        settings,
      ),
    ).toEqual({ verdict: "NOT_DEAL", status: "COMPLETE", reason: "above-discount-threshold" });
  });

  // R4. floor(200019/10) = 20001, and 20001 * 0.67 = 13400.67, so flooring the average throws
  // this real deal away. Exactly: 13401 * 10 * 10000 = 1,340,100,000 <= 200019 * 6700 =
  // 1,340,127,300.
  it("R4: catches the deal a floored average would lose", () => {
    const settings = settingsFor({ mode: "DISCOUNT", minimumDiscountPercent: 33 });
    expect(
      decide(
        candidate({ candidatePriceCents: 13_401, referenceCount: 10, referenceTotalCents: 200_019 }),
        settings,
      ),
    ).toEqual({ verdict: "DEAL", status: "COMPLETE", reason: "within-discount" });
  });
});

describe("dealRules -- the evidence gate", () => {
  // R5. Four comparables is not enough; five is.
  it("R5: requires five comparables before a discount verdict", () => {
    expect(
      decide(
        candidate({ referenceCount: 4, referenceTotalCents: 92_000, candidatePriceCents: 1 }),
        DISCOUNT_20,
      ),
    ).toEqual({
      verdict: "NEEDS_REVIEW",
      status: "NEEDS_REVIEW",
      reason: "insufficient-evidence",
    });
    expect(
      decide(
        candidate({ referenceCount: 5, referenceTotalCents: 115_000, candidatePriceCents: 1 }),
        DISCOUNT_20,
      ),
    ).toEqual({ verdict: "DEAL", status: "COMPLETE", reason: "within-discount" });
  });

  // R6. A missing model_stats row reads as NULL / NULL through the LEFT JOIN. Treating that as
  // count = 0 and falling through would divide by a phantom market.
  it("R6: treats a missing aggregate as insufficient evidence, not as an empty one", () => {
    expect(
      decide(
        candidate({ referenceCount: null, referenceTotalCents: null, candidatePriceCents: 1 }),
        DISCOUNT_20,
      ),
    ).toEqual({
      verdict: "NEEDS_REVIEW",
      status: "NEEDS_REVIEW",
      reason: "insufficient-evidence",
    });
  });

  // R12. A drifted aggregate. C = -1 satisfies the raw comparison (1 * -1 * 10000 = -10000 <=
  // 1000 * 8000), so it is the EVIDENCE GATE, not the arithmetic, that stops it becoming a DEAL.
  it("R12: a negative reference count is insufficient evidence, never a deal", () => {
    expect(
      decide(
        candidate({ referenceCount: -1, referenceTotalCents: 1000, candidatePriceCents: 1 }),
        DISCOUNT_20,
      ),
    ).toEqual({
      verdict: "NEEDS_REVIEW",
      status: "NEEDS_REVIEW",
      reason: "insufficient-evidence",
    });
  });
});

describe("dealRules -- the maximum-price leg", () => {
  // R7. Maximum-price mode must work with NO market history at all.
  it("R7: decides in maximum-price mode with no aggregate whatsoever", () => {
    const settings = settingsFor({ mode: "MAXIMUM_PRICE", maximumPriceCents: 20_000 });
    expect(
      decide(
        candidate({
          candidatePriceCents: 19_999,
          referenceCount: null,
          referenceTotalCents: null,
        }),
        settings,
      ),
    ).toEqual({ verdict: "DEAL", status: "COMPLETE", reason: "within-maximum" });
  });

  // R8. `<=` at the maximum, same as the discount leg.
  it("R8: is a deal at exactly the maximum and not one cent above it", () => {
    const settings = settingsFor({ mode: "MAXIMUM_PRICE", maximumPriceCents: 20_000 });
    expect(decide(candidate({ candidatePriceCents: 20_000 }), settings)).toEqual({
      verdict: "DEAL",
      status: "COMPLETE",
      reason: "within-maximum",
    });
    expect(decide(candidate({ candidatePriceCents: 20_001 }), settings)).toEqual({
      verdict: "NOT_DEAL",
      status: "COMPLETE",
      reason: "above-maximum-price",
    });
  });
});

describe("dealRules -- BOTH mode", () => {
  // Average 23000, 20% off -> discount threshold 18400. Maximum 19000.
  const BOTH = settingsFor({
    mode: "BOTH",
    minimumDiscountPercent: 20,
    maximumPriceCents: 19_000,
  });

  // R9. BOTH means AND. Either leg failing is a NOT_DEAL.
  it("R9: requires both legs, not either", () => {
    // discount ok (18400 <= 18400), maximum fails (18400 > 18000)
    const tightMaximum = settingsFor({
      mode: "BOTH",
      minimumDiscountPercent: 20,
      maximumPriceCents: 18_000,
    });
    expect(decide(candidate({ candidatePriceCents: 18_400 }), tightMaximum)).toEqual({
      verdict: "NOT_DEAL",
      status: "COMPLETE",
      reason: "above-maximum-price",
    });
    // discount fails (18401 > 18400), maximum ok (18401 <= 19000)
    expect(decide(candidate({ candidatePriceCents: 18_401 }), BOTH)).toEqual({
      verdict: "NOT_DEAL",
      status: "COMPLETE",
      reason: "above-discount-threshold",
    });
    // both ok
    expect(decide(candidate({ candidatePriceCents: 18_400 }), BOTH)).toEqual({
      verdict: "DEAL",
      status: "COMPLETE",
      reason: "within-both",
    });
  });

  // R10. THE ORDER OF THE LEGS IS THE SPECIFICATION. With the evidence gate above the maximum
  // leg, this returns insufficient-evidence and the task is parked at status NEEDS_REVIEW
  // forever -- waiting for market evidence that cannot change an answer the maximum already
  // decided. The AND is false regardless of what the discount leg would say.
  it("R10: settles above-maximum without consulting the evidence gate", () => {
    expect(
      decide(
        candidate({
          candidatePriceCents: 25_000,
          referenceCount: 4,
          referenceTotalCents: 92_000,
        }),
        BOTH,
      ),
    ).toEqual({ verdict: "NOT_DEAL", status: "COMPLETE", reason: "above-maximum-price" });
  });

  // R11. The mirror of R10: under the maximum, BOTH mode still needs the discount leg, so thin
  // evidence must park the task rather than short-circuit to a verdict.
  it("R11: still needs evidence when the maximum leg passes", () => {
    expect(
      decide(
        candidate({
          candidatePriceCents: 100,
          referenceCount: 4,
          referenceTotalCents: 92_000,
        }),
        BOTH,
      ),
    ).toEqual({
      verdict: "NEEDS_REVIEW",
      status: "NEEDS_REVIEW",
      reason: "insufficient-evidence",
    });
  });
});

describe("dealRules -- validity fails closed", () => {
  // R13. Both terminal, both COMPLETE. Routing either to status NEEDS_REVIEW would put a task
  // that no amount of market evidence can move back into the re-check queue forever.
  it("R13: INVALID_REFERENCE and NEEDS_REVIEW are terminal regardless of market data", () => {
    expect(
      decide(candidate({ validity: "INVALID_REFERENCE", candidatePriceCents: 1 }), DISCOUNT_20),
    ).toEqual({ verdict: "NOT_DEAL", status: "COMPLETE", reason: "invalid-reference" });
    expect(
      decide(candidate({ validity: "NEEDS_REVIEW", candidatePriceCents: 1 }), DISCOUNT_20),
    ).toEqual({ verdict: "NEEDS_REVIEW", status: "COMPLETE", reason: "validity-needs-review" });
  });

  // R14. `validity` is TEXT and 3C stores whatever the caller passed. Two equality checks with a
  // fall-through treats every one of these as VALID -- measured: all four produce DEAL, on a
  // candidate whose price and aggregate are otherwise a textbook deal.
  it("R14: anything that is not exactly VALID is not a deal", () => {
    for (const validity of ["UNKNOWN", "needs_review", "Invalid_Reference", ""]) {
      expect(decide(candidate({ validity, candidatePriceCents: 1 }), DISCOUNT_20)).toEqual({
        verdict: "NEEDS_REVIEW",
        status: "COMPLETE",
        reason: "validity-needs-review",
      });
    }
  });
});

describe("dealRules -- malformed inputs are first-class cases", () => {
  // R15. price_cents is INTEGER *affinity*, not a constraint: 1998.9999999999998 (which is what
  // the canonical `19.99 * 100` parser produces) is stored as a REAL, passes 3C's
  // CHECK (price_cents >= 0), and makes BigInt() throw RangeError. That RangeError would escape
  // AFTER the claim, stranding all 15 tasks in PROCESSING to be re-claimed and re-thrown forever.
  it("R15: a malformed price is no-price and COMPLETE, and never throws", () => {
    for (const price of [null, 1998.9999999999998, -1, NaN]) {
      expect(decide(candidate({ candidatePriceCents: price }), DISCOUNT_20)).toEqual({
        verdict: "NEEDS_REVIEW",
        status: "COMPLETE",
        reason: "no-price",
      });
    }
  });

  // R16. A claimed task with no `listings` row. Retrying cannot create one, so it is COMPLETE.
  it("R16: a missing listing row is listing-missing and COMPLETE, and never throws", () => {
    expect(decide(undefined, DISCOUNT_20)).toEqual({
      verdict: "NEEDS_REVIEW",
      status: "COMPLETE",
      reason: "listing-missing",
    });
  });
});

describe("dealRules -- discountBasisPoints, the only rounding in the path", () => {
  // R17. 4.35 is the case that matters: 4.35 * 100 is 434.99999999999994 in IEEE-754, so
  // truncating turns a 4.35% setting into 4.34%. Math.round(4.35) * 100 would give 400.
  it("R17: converts a percentage to basis points without losing the last hundredth", () => {
    expect(discountBasisPoints(12.5)).toBe(1250);
    expect(discountBasisPoints(4.35)).toBe(435);
    expect(discountBasisPoints(33)).toBe(3300);
    expect(discountBasisPoints(0)).toBe(0);
    expect(discountBasisPoints(100)).toBe(10_000);
  });

  // R18. toFixed-style formatting happily accepts these; the comparison would not.
  it("R18: rejects a percentage that is not a finite number in [0, 100]", () => {
    for (const percent of [NaN, Infinity, -1, 101]) {
      expect(() => discountBasisPoints(percent)).toThrow(/finite number in \[0, 100\]/);
    }
  });
});

describe("dealRules -- validateSettings", () => {
  // R19. A null or undefined revision makes the claim's `evaluated_revision < ?` and `> ?` terms
  // evaluate to NULL, so only IS NULL rows stay eligible and every task ever evaluated is
  // silently frozen forever WHILE THE CALL REPORTS SUCCESS. This guard is the only thing between
  // a missing 3E field and a dead pipeline.
  it("R19: rejects a searchRevision that is not a safe integer >= 0, and accepts 0", () => {
    for (const searchRevision of [null, undefined, 1.5, -1]) {
      expect(() =>
        validateSettings({
          mode: "DISCOUNT",
          minimumDiscountPercent: 20,
          maximumPriceCents: null,
          searchRevision: searchRevision as unknown as number,
        }),
      ).toThrow(/searchRevision must be a safe integer >= 0/);
    }
    expect(
      validateSettings({
        mode: "DISCOUNT",
        minimumDiscountPercent: 20,
        maximumPriceCents: null,
        searchRevision: 0,
      }),
    ).toEqual({ mode: "DISCOUNT", basisPoints: 2000, maximumPriceCents: null, searchRevision: 0 });
  });

  // R20. Each mode's own required field, checked at the boundary rather than asserted deep in
  // `decide` with a `!`.
  it("R20: requires the field each mode actually reads", () => {
    expect(() =>
      validateSettings({
        mode: "DISCOUNT",
        minimumDiscountPercent: null,
        maximumPriceCents: 20_000,
        searchRevision: 1,
      }),
    ).toThrow(/DISCOUNT requires minimumDiscountPercent/);

    for (const maximumPriceCents of [null, 20_000.5]) {
      expect(() =>
        validateSettings({
          mode: "MAXIMUM_PRICE",
          minimumDiscountPercent: null,
          maximumPriceCents,
          searchRevision: 1,
        }),
      ).toThrow(/MAXIMUM_PRICE requires an integer maximumPriceCents >= 0/);
    }
  });
});

describe("dealRules -- referenceAverageCents is a report", () => {
  // R21. A solo contributor gives reference_count = 0 and reference_total_cents = 0, and
  // Math.round(0 / 0) is NaN -- which would flow into the frontend's averagePriceCents field.
  it("R21: reports null rather than NaN when there is nothing to average", () => {
    expect(referenceAverageCents(0, 0)).toBeNull();
    expect(referenceAverageCents(null, 5)).toBeNull();
    expect(referenceAverageCents(115_000, null)).toBeNull();
    expect(referenceAverageCents(115_000, 5)).toBe(23_000);
  });
});
