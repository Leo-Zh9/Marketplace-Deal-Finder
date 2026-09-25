// @vitest-environment node

/**
 * The twelve classification rules. EVERY case asserts the whole result -- `{modelKey, variantKey,
 * validity, reason}` -- and never `validity` alone: the CA$2,000 "RTX 4070 super gaming pc |
 * Ryzen 5 7600 | ..." is caught by rule 4 AND by rule 5, so a validity-only assertion stays green
 * with either rule deleted. `reason` exists for exactly that and is stored nowhere.
 *
 * FIXTURE CORRELATION. No two parameters that reach the code under test share a value: every
 * title below is distinct, every `priceCents` is distinct EXCEPT the three cases where `0` is
 * the subject, no price is 0, 1 or 100 other than those, and the declared type spans all nine.
 * So no assertion here can pass because the rule is hardwired to one component type or because a
 * price happened to equal a constant.
 */

import type { Listing } from "../storage/types";
import { tokenValues, tokenize } from "./catalogIndex";
import {
  BROKEN,
  MARKERS,
  MULTIPLE,
  MULTI_UNIT,
  SYSTEM_PHRASES,
  TRADE,
  WANTED,
  WHOLE_UNIT,
  normalizeListing,
  type NormalizationReason,
} from "./normalizeListing";
import type { ObservationValidity } from "../storage/types";

type Case = [
  name: string,
  title: string,
  priceCents: number | null,
  componentType: Listing["componentType"],
  validity: ObservationValidity,
  modelKey: string | null,
  reason: NormalizationReason,
];

const CASES: Case[] = [
  // Rules 1-3: the price is not a price for this product at all.
  ["T19 (rule 1): a wanted ad", "WTB RTX 5080 graphics card", 6300, "gpu", "INVALID_REFERENCE", null, "wanted-ad"],
  ["T17 (rule 2): live -- trade-only, naming two cards", "For trade: MSI RTX 3060 Ventus 2X 12GB for an Intel Arc B580 12gb", 0, "gpu", "INVALID_REFERENCE", null, "trade-only"],
  ["T18 (rule 3): live -- for parts", "EVGA GeForce GTX 980 Ti Classified Graphics Card for parts", 2500, "gpu", "INVALID_REFERENCE", null, "not-working"],

  // Rule 4: THE DANGEROUS CASE -- a whole machine whose title names a real GPU.
  ["T9 (rule 4): live -- a PC containing a 4070 Super", "RTX 4070 super gaming pc | Ryzen 5 7600 | 32gb DDR4 RAM | 1tb nvme", 200000, "gpu", "INVALID_REFERENCE", null, "whole-system"],
  ["T9b (rule 4): the same listing with its spec list deleted", "RTX 4070 super pc", 201000, "gpu", "INVALID_REFERENCE", null, "whole-system"],
  ["T9c (rule 4): the whole-unit token 'build'", "Custom Build RTX 5080", 290000, "gpu", "INVALID_REFERENCE", null, "whole-system"],
  ["T9d (rule 4): the whole-unit token 'tower'", "RTX 5070 Tower", 96900, "gpu", "INVALID_REFERENCE", null, "whole-system"],
  ["T9e (rule 4): a system PHRASE the token set alone misses", "Gaming Desktop RTX 5090", 410000, "gpu", "INVALID_REFERENCE", null, "whole-system"],
  ["T9f (rule 4): 'PC case' under a case search is a case", "Lian Li Lancool 216 PC Case", 13900, "case", "VALID", "Lian Li Lancool 216", "matched"],
  ["T9g (rule 4): 'tower case' under a case search is a case", "NZXT H7 Flow tower case white", 15900, "case", "VALID", "NZXT H7 Flow", "matched"],
  ["T9h (rule 4): 'computer case' under a case search is a case", "Fractal North computer case", 16900, "case", "VALID", "Fractal North", "matched"],

  // Rule 5: the majority case in the live data -- the wrong component entirely.
  ["T16 (rule 5): live -- RAM in a GPU search", "Timetec 16GB DDR4 3200MHz SODIMM Laptop RAM", 5000, "gpu", "INVALID_REFERENCE", null, "wrong-component"],

  // Rule 6: two models of the DECLARED type; no way to say which price is which.
  ["T8 (rule 6): two cards in one title", "RTX 5080 graphics card and RX 7800 XT", 380000, "gpu", "INVALID_REFERENCE", null, "multiple-models"],
  ["T24 (rule 6): two drives in one title", "Samsung 990 Pro 2TB and Samsung 870 EVO 2TB SSD", 42000, "storage", "INVALID_REFERENCE", null, "multiple-models"],

  // Rule 7: more than one unit, so the price is not a unit price.
  ["T31 (rule 7): an explicit lot", "Lot of 3 RTX 5060 graphics cards", 120000, "gpu", "NEEDS_REVIEW", null, "unknown-quantity"],
  ["T32 (rule 7): a numbered multi-pack", "Arctic P12 PWM PST 5 Pack", 3900, "case_fan", "NEEDS_REVIEW", null, "unknown-quantity"],
  ["T32b (rule 7): A FAN PACK REALLY IS A PACK", "Arctic P12 Max fan pack", 4900, "case_fan", "NEEDS_REVIEW", null, "unknown-quantity"],
  ["T40 (rule 7): a leading multiplier", "3x Arctic P14 Max case fans", 9900, "case_fan", "NEEDS_REVIEW", null, "unknown-quantity"],
  ["T41 (rule 7): a leading multiplier, storage", "2x Samsung 990 Pro 2TB", 42500, "storage", "NEEDS_REVIEW", null, "unknown-quantity"],
  ["T42 (rule 7): 'Ventus 3X' is a cooler, not a count", "MSI RTX 5080 Ventus 3X OC", 291000, "gpu", "VALID", "GeForce RTX 5080", "matched"],
  ["T43 (rule 7): '9600X processor' is a CPU, not a count", "Ryzen 5 9600X processor, like new", 28900, "cpu", "VALID", "Ryzen 5 9600X", "matched"],
  // T44 AND T45 ARE REGRESSION ONLY FOR THIS PREDICATE, and are labelled so nobody deletes T46
  // believing they cover it. MEASURED: neither moves when the index-0 restriction is dropped OR
  // when the letter test is dropped -- their `2x16GB` and `SN850X 2TB` sit away from index 0 and
  // are followed by digits, so BOTH terms refuse them for two independent reasons. T46 is the
  // SOLE killer of the letter test, and T42/T43 are the sole killers of the index-0 restriction.
  ["T44 (rule 7): a 2x16GB kit is ONE kit -- regression only", "Corsair Vengeance 32GB DDR5 (2x16GB)", 18900, "ram", "VALID", "Corsair Vengeance 32GB DDR5", "matched"],
  ["T45 (rule 7): 'SN850X 2TB' is a model, not a count -- regression only", "WD Black SN850X 2TB nvme ssd", 21900, "storage", "VALID", "WD Black SN850X 2TB", "matched"],
  ["T46 (rule 7): a LEADING kit spec is still one kit -- SOLE killer of the letter test", "2x16GB Corsair Vengeance 32GB DDR5", 19900, "ram", "VALID", "Corsair Vengeance 32GB DDR5", "matched"],

  // Rule 8: a placeholder zero is not a price; an explicit free one is a real zero.
  ["T22 (rule 8): CA$0 with nothing saying free", "ASUS ROG RTX 5070 graphics card", 0, "gpu", "NEEDS_REVIEW", null, "ambiguous-zero-price"],
  ["T23 (rule 8): explicitly free", "Free RTX 5070 graphics card", 0, "gpu", "VALID", "GeForce RTX 5070", "matched"],

  // Rule 9: nothing says this is even the declared component. Do not guess.
  ["T5 (rule 9): live -- no brand, no series word", "Selling My 4070 TI", 100000, "gpu", "NEEDS_REVIEW", null, "component-unconfirmed"],

  // Rule 10: real, standalone, and the catalog does not list it.
  ["T15 (rule 10): live -- a genuine uncatalogued GPU", "AMD Radeon™ RX 6800 XT Phantom Gaming D 16G OC", 49900, "gpu", "VALID", null, "model-unmatched"],
  ["T22b (rule 10): live -- 217 is not 216", "Lian Li lancool 217 White PC Case", 12000, "case", "VALID", null, "model-unmatched"],
  ["T29r (rule 10): a cooler revision the catalog lacks", "Noctua NH-D15 G3 cpu cooler", 14900, "cpu_cooler", "VALID", null, "model-unmatched"],

  // Rule 11.
  ["T2r (rule 11): a motherboard resolves to its catalog name", "MSI MAG B650 Tomahawk WiFi motherboard", 25900, "motherboard", "VALID", "MSI MAG B650 Tomahawk WiFi", "matched"],
];

/**
 * T36. ACCEPTED EXPOSURE, NOT DESIRED BEHAVIOUR. Both rows mis-pool and both are pinned here so
 * the NEXT one is visible rather than discovered in an aggregate:
 *
 * - a year-suffixed revision pools into the base model. Year suffixes are an unbounded class and
 *   enumerating them in SUFFIX_WORDS would prove the list open-ended rather than close it.
 * - a laptop carrying no whole-unit token, no system brand and no foreign-component marker still
 *   reads as a standalone GPU. Its LIVE counterpart (`MINT Alienware x17 ... i9 | RTX 3080 Ti`)
 *   is caught twice over; this one has both detectors deliberately stripped. The measured
 *   residual on whole machines is 1 of 29, not 0 of 29.
 *
 * If either row starts failing, the rule got BETTER; delete the row and say so.
 */
const ACCEPTED_EXPOSURE: Case[] = [
  ["T36a: a year-suffixed revision pools into the base model", "Corsair RM850x 2021 power supply", 17900, "psu", "VALID", "Corsair RM850x", "matched"],
  ["T36b: a laptop with every detector stripped reads as a GPU", "MINT custom x17 R2 Flagship Ecosystem - RTX 5080 (16GB)", 350000, "gpu", "VALID", "GeForce RTX 5080", "matched"],
];

const assertCase = ([, title, priceCents, componentType, validity, modelKey, reason]: Case): void => {
  expect(normalizeListing({ title, priceCents, componentType })).toEqual({
    modelKey,
    variantKey: null,
    validity,
    reason,
  });
};

describe("normalizeListing -- the classification rules", () => {
  it.each(CASES)("%s", (...testCase) => {
    assertCase(testCase);
  });

  it.each(ACCEPTED_EXPOSURE)("%s", (...testCase) => {
    assertCase(testCase);
  });
});

/**
 * PER-ELEMENT VOCABULARY COVERAGE. Each test below carries its OWN literal copy of the
 * vocabulary it pins. That is deliberate and it is the point: a test that iterates the
 * production table cannot detect a deletion FROM that table, because the row vanishes with the
 * element. Measured -- removing one element at a time from all 18 vocabularies, 92 of 119
 * elements changed real classifications while the whole suite stayed green.
 *
 * Every block has a CONTROL, because "every frame is refused" is also what a rule that refuses
 * everything produces.
 *
 * Named limitation: these pin removals and changes, NOT additions. T13's bidirectional audit is
 * what catches the dangerous kind of addition -- one that overlaps an existing phrase.
 */
describe("normalizeListing -- every vocabulary element, one at a time", () => {
  const GPU_FRAME = (phrase: string) => `${phrase} GeForce RTX 5080 graphics card`;

  /** T21: the three refusal vocabularies and the multiplicity phrases, element by element. */
  it.each<[string, NormalizationReason]>([
    ["wtb", "wanted-ad"],
    ["want to buy", "wanted-ad"],
    ["wanted", "wanted-ad"],
    ["looking for", "wanted-ad"],
    ["in search of", "wanted-ad"],
    ["iso", "wanted-ad"],
    ["for trade", "trade-only"],
    ["trade only", "trade-only"],
    ["trade for", "trade-only"],
    ["will trade", "trade-only"],
    ["swap", "trade-only"],
    ["trading", "trade-only"],
    ["for parts", "not-working"],
    ["parts only", "not-working"],
    ["not working", "not-working"],
    ["doesn't work", "not-working"],
    ["broken", "not-working"],
    ["damaged", "not-working"],
    ["faulty", "not-working"],
    ["cracked", "not-working"],
    ["for repair", "not-working"],
    ["as is", "not-working"],
    ["lot of", "unknown-quantity"],
    ["bundle", "unknown-quantity"],
    ["pair of", "unknown-quantity"],
    ["set of", "unknown-quantity"],
    ["pcs", "unknown-quantity"],
    ["pieces", "unknown-quantity"],
  ])("T21: %s refuses the listing as %s", (phrase, reason) => {
    const result = normalizeListing({ title: GPU_FRAME(phrase), priceCents: 299000, componentType: "gpu" });
    expect(result.reason).toBe(reason);
    expect(result.modelKey).toBeNull();
  });

  /** T21b: SYSTEM_PHRASES, element by element, in the frame that also exposes the four whose
   * effect is otherwise indistinguishable from a bare `pc` / `computer` token: here the
   * whole-unit token IS covered by the declared type's own marker, so only the phrase can fire. */
  it.each([
    ["thinkcentre"], ["thinkpad"], ["alienware"], ["optiplex"], ["elitedesk"], ["prodesk"],
    ["macbook"], ["imac"], ["nuc"], ["all in one"], ["workstation"], ["gaming desktop"],
    ["desktop pc"], ["desktop computer"], ["mini pc"], ["gaming laptop"], ["laptop computer"],
  ])("T21b: %s marks the listing a whole system", (phrase) => {
    expect(
      normalizeListing({ title: `NZXT H7 Flow ${phrase} case`, priceCents: 15800, componentType: "case" }),
    ).toEqual({ modelKey: null, variantKey: null, validity: "INVALID_REFERENCE", reason: "whole-system" });
  });

  it("T21b control: the same frame with no system phrase is a case", () => {
    expect(
      normalizeListing({ title: "NZXT H7 Flow case", priceCents: 15700, componentType: "case" }),
    ).toEqual({ modelKey: "NZXT H7 Flow", variantKey: null, validity: "VALID", reason: "matched" });
  });

  /** T21c: WHOLE_UNIT, element by element, uncovered by any gpu marker. */
  it.each([
    ["pc"], ["computer"], ["tower"], ["rig"], ["prebuilt"], ["build"], ["built"], ["setup"],
    ["battlestation"], ["machine"], ["system"],
  ])("T21c: the whole-unit token %s marks the listing a whole system", (token) => {
    expect(
      normalizeListing({ title: `GeForce RTX 5080 ${token}`, priceCents: 289000, componentType: "gpu" }),
    ).toEqual({ modelKey: null, variantKey: null, validity: "INVALID_REFERENCE", reason: "whole-system" });
  });

  it("T21c control: an unlisted trailing word leaves the card a card", () => {
    expect(
      normalizeListing({ title: "GeForce RTX 5080 oc", priceCents: 288000, componentType: "gpu" }),
    ).toEqual({ modelKey: "GeForce RTX 5080", variantKey: null, validity: "VALID", reason: "matched" });
  });

  /**
   * T21d: every MARKERS phrase of the eight non-gpu types, beside a gpu catalog model under a
   * gpu declaration. With the marker its type is evidenced and the bundle is refused; without
   * it, the title reads as a plain 5080.
   *
   * THREE `case` MARKERS ARE DELIBERATELY ABSENT: `pc case`, `computer case` and `tower case`
   * each contain a WHOLE_UNIT token, so under a gpu declaration rule 4 fires first and the frame
   * stops discriminating. They are pinned by T9f, T9h and T9g instead, where the declared type is
   * `case` and the marker's own coverage is what neutralises the token.
   */
  it.each<[string, Listing["componentType"]]>([
    ["processor", "cpu"], ["ryzen", "cpu"], ["threadripper", "cpu"], ["xeon", "cpu"],
    ["i 3", "cpu"], ["i 5", "cpu"], ["i 7", "cpu"], ["i 9", "cpu"], ["core ultra", "cpu"],
    ["pentium", "cpu"], ["athlon", "cpu"],
    ["cpu cooler", "cpu_cooler"], ["heatsink", "cpu_cooler"], ["aio cooler", "cpu_cooler"],
    ["air cooler", "cpu_cooler"], ["liquid cooler", "cpu_cooler"],
    ["motherboard", "motherboard"], ["mobo", "motherboard"], ["mainboard", "motherboard"],
    ["ddr 3", "ram"], ["ddr 4", "ram"], ["ddr 5", "ram"], ["dimm", "ram"], ["sodimm", "ram"],
    ["memory kit", "ram"],
    ["ssd", "storage"], ["hdd", "storage"], ["nvme", "storage"], ["hard drive", "storage"],
    ["m 2 drive", "storage"], ["solid state", "storage"],
    ["psu", "psu"], ["power supply", "psu"],
    ["chassis", "case"],
    ["case fan", "case_fan"], ["case fans", "case_fan"], ["fan pack", "case_fan"],
  ])("T21d: %s evidences a foreign component beside a GPU", (marker) => {
    expect(
      normalizeListing({ title: `GeForce RTX 5080 and a ${marker}`, priceCents: 301000, componentType: "gpu" }),
    ).toEqual({ modelKey: null, variantKey: null, validity: "INVALID_REFERENCE", reason: "mixed-components" });
  });

  it("T21d control: the same frame with no foreign marker is a plain GPU", () => {
    expect(
      normalizeListing({ title: "GeForce RTX 5080 and a warranty", priceCents: 302000, componentType: "gpu" }),
    ).toEqual({ modelKey: "GeForce RTX 5080", variantKey: null, validity: "VALID", reason: "matched" });
  });

  /** T21e: the gpu markers, which the frame above cannot reach -- they ARE the declared type. */
  it.each([["gpu"], ["graphics card"], ["video card"], ["rtx"], ["gtx"], ["geforce"], ["radeon"]])(
    "T21e: %s confirms the listing is a GPU even with no catalog match",
    (marker) => {
      expect(
        normalizeListing({ title: `${marker} for sale`, priceCents: 45900, componentType: "gpu" }),
      ).toEqual({ modelKey: null, variantKey: null, validity: "VALID", reason: "model-unmatched" });
    },
  );

  it("T21e control: with no gpu marker at all the rule declines to guess", () => {
    expect(
      normalizeListing({ title: "widget for sale", priceCents: 45800, componentType: "gpu" }),
    ).toEqual({ modelKey: null, variantKey: null, validity: "NEEDS_REVIEW", reason: "component-unconfirmed" });
  });
});

describe("normalizeListing -- properties of the vocabularies", () => {
  /**
   * T13. BIDIRECTIONAL. A one-directional audit misses the case where a RULE vocabulary entry is
   * a sub-phrase of a MARKER, which is exactly how the `pack` inside `fan pack` interaction was
   * found -- and that one was first "fixed" in the wrong direction, by suppressing a true
   * positive.
   *
   * The exact 8-row set is asserted, so a vocabulary addition that creates a ninth overlap fails
   * here until it is removed, neutralised, or -- as with `pack` -- deliberately allowed to win.
   * The four SYSTEM_PHRASES rows are harmless: both paths give `whole-system`.
   */
  it("T13: exactly eight sub-phrase overlaps exist across the sixteen vocabularies", () => {
    const vocabularies: [string, readonly string[]][] = [
      ...(Object.entries(MARKERS) as [string, readonly string[]][]).map(
        ([type, phrases]) => [`MARKERS.${type}`, phrases] as [string, readonly string[]],
      ),
      ["WANTED", WANTED],
      ["TRADE", TRADE],
      ["BROKEN", BROKEN],
      ["SYSTEM_PHRASES", SYSTEM_PHRASES],
      ["MULTIPLE", MULTIPLE],
      ["WHOLE_UNIT", [...WHOLE_UNIT]],
      ["MULTI_UNIT", [...MULTI_UNIT]],
    ];
    expect(vocabularies).toHaveLength(16);

    const sequence = (phrase: string): string[] => tokenValues(tokenize(phrase));
    const isSubPhrase = (inner: string[], outer: string[]): boolean => {
      if (inner.join(" ") === outer.join(" ")) return false;
      for (let start = 0; start + inner.length <= outer.length; start += 1) {
        if (inner.every((token, offset) => token === outer[start + offset])) return true;
      }
      return false;
    };

    const overlaps: string[] = [];
    for (const [nameA, phrasesA] of vocabularies) {
      for (const [nameB, phrasesB] of vocabularies) {
        if (nameA === nameB) continue;
        for (const a of phrasesA) {
          for (const b of phrasesB) {
            if (isSubPhrase(sequence(a), sequence(b))) {
              overlaps.push(`${nameA}:${a} < ${nameB}:${b}`);
            }
          }
        }
      }
    }

    expect(overlaps.sort()).toEqual(
      [
        "MULTI_UNIT:pack < MARKERS.case_fan:fan pack",
        "WHOLE_UNIT:computer < MARKERS.case:computer case",
        "WHOLE_UNIT:computer < SYSTEM_PHRASES:desktop computer",
        "WHOLE_UNIT:computer < SYSTEM_PHRASES:laptop computer",
        "WHOLE_UNIT:pc < MARKERS.case:pc case",
        "WHOLE_UNIT:pc < SYSTEM_PHRASES:desktop pc",
        "WHOLE_UNIT:pc < SYSTEM_PHRASES:mini pc",
        "WHOLE_UNIT:tower < MARKERS.case:tower case",
      ].sort(),
    );
  });

  /** T37: the spec's 3B acceptance gate -- every component type is exercised, not just gpu. */
  it("T37: all nine component types have at least one case", () => {
    const declared = new Set([...CASES, ...ACCEPTED_EXPOSURE].map((testCase) => testCase[3]));
    expect([...declared].sort()).toEqual((Object.keys(MARKERS) as string[]).sort());
    expect(declared.size).toBe(9);
  });
});
