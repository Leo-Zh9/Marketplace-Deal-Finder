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
  FREE_IS_NOT_THE_ITEM,
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
  // F1: a whole machine whose title names no `pc`, `rig` or `build`. Before this vocabulary,
  // "ASUS TUF Gaming A15 laptop RTX 4060" wrote the laptop's whole price into the 4060's
  // benchmark. Each row below is refused by exactly ONE of the four new words.
  ["F1a (rule 4): the whole-unit token 'laptop'", "ASUS TUF Gaming A15 laptop RTX 4060", 121000, "gpu", "INVALID_REFERENCE", null, "whole-system"],
  ["F1b (rule 4): the whole-unit token 'notebook'", "Dell G15 notebook RTX 4060", 125000, "gpu", "INVALID_REFERENCE", null, "whole-system"],
  ["F1c (rule 4): a brand line with NO whole-unit word at all", "Razer Blade 16 RTX 5080", 351000, "gpu", "INVALID_REFERENCE", null, "whole-system"],
  ["F1d (rule 4): a second brand line, same shape", "HP Omen 16 with RTX 4060", 130000, "gpu", "INVALID_REFERENCE", null, "whole-system"],
  // R2: `desktop` was excluded because the bare token fired on the catalog's own product
  // wording. Two marker phrases dissolve that collision, and the prebuilt it was letting
  // through was writing a CA$1,100 whole desktop into the 4060 benchmark.
  ["R2a (rule 4): the whole-unit token 'desktop'", "Dell Desktop GeForce RTX 4060", 110000, "gpu", "INVALID_REFERENCE", null, "whole-system"],
  ["R2b (rule 4): 'desktop processor' covers it for a CPU", "AMD Ryzen 7 9800X3D Desktop Processor", 79000, "cpu", "VALID", "Ryzen 7 9800X3D", "matched"],
  ["R2c (rule 4): 'desktop memory' covers it for RAM", "Kingston Fury Beast 32GB DDR4 desktop memory", 11900, "ram", "VALID", "Kingston Fury Beast 32GB DDR4", "matched"],
  // R3: `katana` was admitted as a laptop line and had to come out -- Scythe Katana is a
  // mainstream tower cooler.
  ["R3a (rule 4): a cooler line that is not a laptop", "Scythe Katana 5 CPU cooler", 4500, "cpu_cooler", "VALID", null, "model-unmatched"],

  // Rule 5: the majority case in the live data -- the wrong component entirely.
  //
  // T16 MOVED FROM rule 5 TO rule 4 WHEN `laptop` BECAME A WHOLE-UNIT TOKEN, and it is recorded
  // here rather than hidden: the stored result is identical (INVALID_REFERENCE, null key), only
  // the rule that refused it changed, because rule 4 runs first. T16b is therefore the case that
  // actually kills rule 5 -- it is live RAM in a gpu search with no whole-unit word in it.
  ["T16 (rule 4): live -- laptop RAM in a GPU search", "Timetec 16GB DDR4 3200MHz SODIMM Laptop RAM", 5000, "gpu", "INVALID_REFERENCE", null, "whole-system"],
  ["T16b (rule 5): live -- a desktop RAM kit in a GPU search", "XPG Gammix D10 32GB (2x16GB) DDR4 3200MHz RAM", 15000, "gpu", "INVALID_REFERENCE", null, "wrong-component"],

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
  // F2: the INFLATING direction -- N units at one price makes a genuine listing look like a deal.
  ["F2a (rule 7): the count word 'two'", "Two GeForce RTX 5080 cards", 403000, "gpu", "NEEDS_REVIEW", null, "unknown-quantity"],
  ["F2b (rule 7): a TRAILING multiplier", "GeForce RTX 5080 x2", 401000, "gpu", "NEEDS_REVIEW", null, "unknown-quantity"],
  ["F2c (rule 7): a multiplier one word in -- the marketplace's house style", "Selling 2x GeForce RTX 5080", 400000, "gpu", "NEEDS_REVIEW", null, "unknown-quantity"],

  // Rule 8: a placeholder zero is not a price; an explicit free one is a real zero.
  ["T22 (rule 8): CA$0 with nothing saying free", "ASUS ROG RTX 5070 graphics card", 0, "gpu", "NEEDS_REVIEW", null, "ambiguous-zero-price"],
  ["T23 (rule 8): explicitly free", "Free RTX 5070 graphics card", 0, "gpu", "VALID", "GeForce RTX 5070", "matched"],
  // F3: `free` anywhere in the title used to re-admit a CA$0 listing as VALID WITH a model key,
  // which `dealRules.decide` reads as DEAL / within-maximum under MAXIMUM_PRICE. Four cases in
  // this table now carry priceCents 0; in every one of them the zero IS the subject.
  ["F3a (rule 8): free SHIPPING is not a free item", "GeForce RTX 5080 - free shipping", 0, "gpu", "NEEDS_REVIEW", null, "ambiguous-zero-price"],
  ["F3b (rule 8): nor is it when it leads the title", "Free shipping on this GeForce RTX 5080", 0, "gpu", "NEEDS_REVIEW", null, "ambiguous-zero-price"],
  // R1: the first guard tested three words at exactly the SECOND token, so one adjective walked
  // through -- and "free local pickup" is the commonest form of the phrase here. The position is
  // now on the qualifier and the "anywhere" on the disqualifier.
  ["R1a (rule 8): an adjective between 'free' and 'pickup'", "Free local pickup - GeForce RTX 5080", 0, "gpu", "NEEDS_REVIEW", null, "ambiguous-zero-price"],
  ["R1b (rule 8): a free-item phrase that does not lead the title", "GeForce RTX 5080 with free item included", 0, "gpu", "NEEDS_REVIEW", null, "ambiguous-zero-price"],

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
  // F2's remainder, pinned rather than left to be discovered. Both are the INFLATING direction.
  //
  // The multiplier predicate reaches index 0 and index 1, which covers one verb before the count
  // -- this marketplace's house style, as the live `"Selling My 4070 TI"` shows. TWO words before
  // it is still uncaught, and widening further is not free: every collision that rejected an
  // `Nx`-anywhere form sits at index 2 or beyond. `Dual ...` is a PERMANENT residual, not an
  // oversight -- `dual` collides with the real `ASUS Dual` board-partner line, which T1 and T3
  // pin as matches, so it can never be a count word here.
  ["T36c: a multiplier two words into the title", "Selling my 2x RTX 5080", 404000, "gpu", "VALID", "GeForce RTX 5080", "matched"],
  ["T36d: the count word 'dual', which collides with a real product line", "Dual GeForce RTX 5080", 402000, "gpu", "VALID", "GeForce RTX 5080", "matched"],
  // The trailing multiplier's own residual, in the SAFE direction: a model name truncated to
  // exactly `<letters> x <digits>` reads as a count. A lost reference, never a wrong one.
  ["T36e: a truncated model name reads as a count", "G.Skill Flare X5", 17500, "ram", "NEEDS_REVIEW", null, "unknown-quantity"],
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
    ["two", "unknown-quantity"],
    ["three", "unknown-quantity"],
    ["both", "unknown-quantity"],
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
    ["razer blade"], ["legion"], ["omen"], ["victus"], ["zephyrus"], ["xps"], ["ideapad"],
    ["pavilion"],
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
    ["battlestation"], ["machine"], ["system"], ["laptop"], ["notebook"], ["desktop"],
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

  /**
   * T23c: each disqualifier word, placed at the END of the title rather than beside the `free`.
   * The frame is deliberately the one the FIRST version of this guard passed and the defect
   * walked through: a leading `free`, the word far away from it, and a real CA$0 price.
   *
   * WHAT THIS TEST CANNOT DO, SAID PLAINLY: it iterates the same words the production set holds,
   * so it proves each listed word works and is blind to every word NOT listed -- which is
   * exactly how `pickup` was missed. `FREE_PHRASINGS` below is the independent corpus that
   * covers that gap; this test covers only the members.
   */
  it.each([["shipping"], ["ship"], ["ships"], ["delivery"], ["delivered"], ["pickup"], ["postage"]])(
    "T23c: a title whose free-ness is about %s does not make the item free",
    (word) => {
      expect(
        normalizeListing({ title: `Free GeForce RTX 5080 - ${word} included`, priceCents: 0, componentType: "gpu" }),
      ).toEqual({ modelKey: null, variantKey: null, validity: "NEEDS_REVIEW", reason: "ambiguous-zero-price" });
    },
  );

  it("T23c control: a leading 'free' followed by the item itself still counts", () => {
    expect(
      normalizeListing({ title: "Free GeForce RTX 5080", priceCents: 0, componentType: "gpu" }),
    ).toEqual({ modelKey: "GeForce RTX 5080", variantKey: null, validity: "VALID", reason: "matched" });
  });

  it("T21e control: with no gpu marker at all the rule declines to guess", () => {
    expect(
      normalizeListing({ title: "widget for sale", priceCents: 45800, componentType: "gpu" }),
    ).toEqual({ modelKey: null, variantKey: null, validity: "NEEDS_REVIEW", reason: "component-unconfirmed" });
  });
});

/**
 * THE THREE CORPORA THE COST AND RESIDUAL FIGURES ARE MEASURED FROM.
 *
 * They are committed because the previous versions of those figures were quoted from corpora
 * that lived only in a scratch directory -- "3 of 24" and "1 of 29" could not be re-derived by
 * anyone reading the repo, and the 29-title set turned out not to cover machines whose titles
 * carry no whole-unit word at all, which is how a laptop reached a GPU benchmark. A number
 * nobody can re-measure is not a measurement.
 */
const STANDALONE_COMPONENTS: [Listing["componentType"], string][] = [
  ["gpu", "ASUS ROG Astral GeForce RTX 5080 OC 16GB"],
  ["gpu", "MSI Ventus 3X GeForce RTX 5070 Ti"],
  ["gpu", "Radeon RX 9070 XT, boxed, receipt"],
  ["gpu", "GeForce RTX 5060 - pulled from my build"],
  ["gpu", "RTX 5080 graphics card for gaming PC"],
  ["cpu", "AMD Ryzen 7 9800X3D Desktop Processor"],
  ["cpu", "Core i9-14900K CPU boxed"],
  ["cpu", "Ryzen 5 9600X processor, like new"],
  ["case", "Lian Li Lancool 216 PC Case"],
  ["case", "Fractal North XL computer case"],
  ["case", "NZXT H7 Flow tower case white"],
  ["case", "Corsair 4000D Airflow chassis"],
  ["psu", "Corsair RM850x power supply 850W"],
  ["psu", "Seasonic Focus GX-850 PSU for desktop build"],
  ["ram", "Corsair Vengeance 32GB DDR5 6000 CL30"],
  ["ram", "Kingston Fury Beast 32GB DDR4 desktop memory"],
  ["storage", "Samsung 990 Pro 2TB NVMe SSD"],
  ["storage", "WD Black SN850X 2TB m.2 drive"],
  ["motherboard", "MSI MAG B650 Tomahawk WiFi motherboard"],
  ["motherboard", "ASUS ROG Maximus Z890 Hero mobo"],
  ["cpu_cooler", "Noctua NH-D15 G2 air cooler"],
  ["cpu_cooler", "Arctic Liquid Freezer III 360 liquid cooler"],
  ["case_fan", "Noctua NF-A12x25 PWM case fan"],
  ["case_fan", "Arctic P12 Max fan pack"],
  // FOUR SHAPES ADDED ON RE-REVIEW, because the quantity vocabulary costs real references and
  // the comment on it used to claim no cost at all. Age phrasing, compatibility copy, a kit
  // written the trailing way round -- which PLAN.md:54 calls ONE kit -- and a bare SKU with one
  // word in front of it, which is what the index<=1 bound costs.
  ["gpu", "GeForce RTX 5080, two months old"],
  ["cpu_cooler", "Noctua NH-D15 fits both AM4 and AM5"],
  ["ram", "Corsair Vengeance 32GB 2x16"],
  ["cpu", "AMD 9600X processor"],
];

/**
 * Whole machines. The first eight are the shapes the original corpus covered; the rest are the
 * ones it did not -- machines named only by a laptop word or only by a product line, which is
 * the class that was contributing whole-machine prices to component benchmarks.
 */
const WHOLE_MACHINES: string[] = [
  "RTX 4070 super gaming pc | Ryzen 5 7600 | 32gb DDR4 RAM | 1tb nvme",
  "Gaming+PC+",
  "Custom Build RTX 5080",
  "RTX 5070 Tower",
  "Gaming Desktop RTX 5090",
  "RTX 4070 super pc",
  "Lenovo ThinkCentre M70q Gen 6 U5235T 16GB/256GB W11 Pro",
  "MINT Alienware x17 R2 Flagship Ecosystem - i9 | RTX 3080 Ti (16GB)",
  "Dell OptiPlex 7090 desktop pc i7 RTX 3060",
  "HP EliteDesk 800 G6 with RTX 4060",
  "Apple iMac 27 inch",
  "Intel NUC 13 Extreme RTX 4070",
  "Dell Precision workstation RTX 4000",
  "All in one PC with RTX 3060",
  "Prebuilt gaming rig RTX 5070 Ti",
  "My whole battlestation - RTX 5080, 9800X3D, 64GB",
  "ASUS TUF Gaming A15 laptop RTX 4060",
  "Dell G15 notebook RTX 4060",
  "Razer Blade 16 RTX 5080",
  "HP Omen 16 with RTX 4060",
  "Lenovo Legion 5 Pro RTX 4070",
  "HP Victus 15 RTX 4050",
  "ASUS ROG Zephyrus G14 RTX 4060",
  "Dell XPS 15 with RTX 4070",
  "Lenovo IdeaPad Gaming 3 RTX 3050",
  "HP Pavilion Gaming RTX 3060",
  "MSI Katana 15 RTX 4070",
  "MacBook Pro 16 M3 Max",
  "Gaming laptop RTX 4080 16GB",
  "MINT custom x17 R2 Flagship Ecosystem - RTX 5080 (16GB)",
];

/**
 * Real board-partner component titles. The catalog stores GENERIC model names and holds no
 * board-partner brands at all, so "0 collisions against the 176" says nothing about these. This
 * corpus is what says something about them, and it is why `nitro`, `aorus` and `predator` were
 * refused as SYSTEM_PHRASES.
 */
const BOARD_PARTNER_TITLES: [Listing["componentType"], string][] = [
  ["gpu", "Sapphire Nitro+ RX 7800 XT graphics card"],
  ["gpu", "Gigabyte Aorus GeForce RTX 5080 Master graphics card"],
  ["ram", "Acer Predator Apollo 32GB DDR5 memory kit"],
  ["cpu_cooler", "Scythe Katana 5 CPU cooler"],
  ["gpu", "PowerColor Red Devil Radeon RX 9070 XT"],
  ["gpu", "ASUS ROG Strix GeForce RTX 5080 OC"],
];

/**
 * ONE ROW PER *ACCEPTED* BRAND WORD, WHICH IS THE HALF THAT WAS MISSING.
 *
 * `BOARD_PARTNER_TITLES` above holds a title for every word that was REFUSED, so it can only
 * ever confirm a refusal -- it could never catch a bad ADMISSION, and that is exactly how
 * `katana` shipped for a round while Scythe sells a tower cooler under that name.
 *
 * For each of the eight words that DO ship, this is the closest thing to a real component
 * listing containing it: a part pulled from a machine of that line. Every one is refused, and
 * that refusal IS the cost of admitting the word -- correct for a laptop part, which is a
 * different product from its desktop namesake, and a lost reference for a desktop part. If any
 * of these eight ever gains a component line of its own, this is the row that has to change.
 */
const ACCEPTED_BRAND_WORD_TITLES: [Listing["componentType"], string][] = [
  ["gpu", "RTX 4070 pulled from a Razer Blade 16"],
  ["gpu", "RTX 4060 removed from my Legion 5 Pro"],
  ["psu", "Corsair RM850x from an HP Omen 45L"],
  ["ram", "Kingston Fury Beast 32GB DDR4 from a Victus 15"],
  ["storage", "Samsung 990 Pro 2TB out of a Zephyrus G14"],
  ["psu", "Corsair SF850 from a Dell XPS 8960"],
  ["ram", "Corsair Vengeance 32GB DDR5 from an IdeaPad"],
  ["storage", "WD Black SN850X 2TB from an HP Pavilion"],
];

/**
 * REAL `free` PHRASINGS AT A REAL CA$0, AND THE ANSWER TO A CLASS RATHER THAN A WORD.
 *
 * The per-element test for the disqualifier set iterates the same words the production set
 * holds, so it is blind to every word NOT in it -- which is how `pickup` was missed the first
 * time and `pick up`, two tokens, the second. THIS corpus is written from the phrasings a seller
 * actually uses, independently of what the code denies, so a hole shows up as a row with the
 * wrong answer rather than as a word nobody thought of.
 */
const FREE_PHRASINGS: [string, "usable" | "refused"][] = [
  ["Free GeForce RTX 5080", "usable"],
  ["Free RTX 5070 graphics card", "usable"],
  ["Free! GeForce RTX 5080", "usable"],
  ["Free to a good home GeForce RTX 5080", "usable"],
  ["Free GeForce RTX 5080 no longer needed", "usable"],
  ["GeForce RTX 5080 - free shipping", "refused"],
  ["Free local pickup - GeForce RTX 5080", "refused"],
  ["FREE GeForce RTX 5080 pick up only", "refused"],
  ["Free porch pickup GeForce RTX 5080", "refused"],
  ["Free collection - GeForce RTX 5080", "refused"],
  ["Free GeForce RTX 5080 - will ship", "refused"],
  ["Free GeForce RTX 5080, delivery available", "refused"],
  ["Free ships anywhere GeForce RTX 5080", "refused"],
  ["GeForce RTX 5080 with free item included", "refused"],
  ["GeForce RTX 5080, free to a good home", "refused"],
];

describe("normalizeListing -- the measured cost and the measured residual", () => {
  /**
   * F5a. THE COST, ABSOLUTE AND RE-DERIVABLE. The declined set is asserted by name, not by
   * count: a count alone would stay green while the eight swapped for eight different ones.
   *
   * THE NUMBER HAS MOVED TWICE AND BOTH MOVES ARE THE POINT. It was reported as 3 when it was
   * 4 -- that count omitted the fan pack, which is ruling 2's deliberate choice. It is now 8 of
   * 28, because four shapes the corpus did not cover were added once the quantity vocabulary
   * grew: age phrasing (`two months old`), compatibility copy (`fits both AM4 and AM5`), a kit
   * written the trailing way round (`32GB 2x16`, which PLAN.md:54 calls ONE kit), and a bare SKU
   * with one word before it (`AMD 9600X processor`), which is what the index<=1 multiplier bound
   * costs. Every one is a LOST reference, never a wrong one -- but a vocabulary whose comment
   * claims no cost at all is the thing this corpus exists to prevent.
   */
  it("F5a: exactly 8 of 28 realistic standalone titles are declined, and these are the eight", () => {
    expect(STANDALONE_COMPONENTS).toHaveLength(28);
    const declined = STANDALONE_COMPONENTS.filter(([componentType, title]) => {
      const result = normalizeListing({ title, priceCents: 6300, componentType });
      return !(result.validity === "VALID" && result.modelKey !== null);
    }).map(([, title]) => title);

    expect(declined).toEqual([
      "GeForce RTX 5060 - pulled from my build",
      "RTX 5080 graphics card for gaming PC",
      "Seasonic Focus GX-850 PSU for desktop build",
      "Arctic P12 Max fan pack",
      "GeForce RTX 5080, two months old",
      "Noctua NH-D15 fits both AM4 and AM5",
      "Corsair Vengeance 32GB 2x16",
      "AMD 9600X processor",
    ]);
  });

  /**
   * F5b. THE RESIDUAL, RESTATED AGAINST THE CORRECTED VOCABULARY. One machine in thirty still
   * reads as a standalone GPU, and it is the same constructed title T36b pins: a laptop with the
   * whole-unit word, the system brand AND the foreign-component marker all stripped out. Its
   * live counterpart three rows above is caught.
   */
  it("F5b: 29 of 30 whole machines are refused, and the one that is not is named", () => {
    expect(WHOLE_MACHINES).toHaveLength(30);
    const missed = WHOLE_MACHINES.filter(
      (title) => normalizeListing({ title, priceCents: 200000, componentType: "gpu" }).modelKey !== null,
    );
    expect(missed).toEqual(["MINT custom x17 R2 Flagship Ecosystem - RTX 5080 (16GB)"]);
  });

  /**
   * F5c. THE GUARD ON THE THREE REJECTED BRAND WORDS. Adding `nitro`, `aorus` or `predator` to
   * SYSTEM_PHRASES turns one of these real component listings into a whole system, and this test
   * is what says so out loud.
   */
  /**
   * R3b. THE OTHER HALF OF THE BRAND-WORD GUARD. Each accepted word's closest real component
   * listing, and the refusal that is the cost of admitting it. A word that later turns out to
   * name a component line shows up here as a row that should not be refused.
   */
  it("R3b: every accepted brand word has a real component title, and each is refused", () => {
    expect(ACCEPTED_BRAND_WORD_TITLES).toHaveLength(8);
    for (const [componentType, title] of ACCEPTED_BRAND_WORD_TITLES) {
      expect(
        normalizeListing({ title, priceCents: 12345, componentType }),
        title,
      ).toMatchObject({ validity: "INVALID_REFERENCE", reason: "whole-system", modelKey: null });
    }
  });

  /**
   * R1b. THE FREE FAMILY, FROM THE SELLER'S SIDE RATHER THAN THE CODE'S. Two of these rows --
   * `pick up only` and `porch pickup` -- were VALID with a model key when this corpus was
   * written, at a real CA$0, which under MAXIMUM_PRICE is the exact verdict PR #6 exists to
   * prevent.
   */
  it("R1c: every real free phrasing lands on the right side of rule 8", () => {
    expect(FREE_PHRASINGS).toHaveLength(15);
    for (const [title, expected] of FREE_PHRASINGS) {
      const result = normalizeListing({ title, priceCents: 0, componentType: "gpu" });
      const actual = result.validity === "VALID" && result.modelKey !== null ? "usable" : "refused";
      expect(actual, title).toBe(expected);
    }
    // Not satisfiable by refusing everything: five rows must still come back with a model key.
    expect(FREE_PHRASINGS.filter(([, e]) => e === "usable")).toHaveLength(5);
  });

  it("F5c: no board-partner brand word refuses a real component listing", () => {
    expect(BOARD_PARTNER_TITLES).toHaveLength(6);
    for (const [componentType, title] of BOARD_PARTNER_TITLES) {
      const result = normalizeListing({ title, priceCents: 49900, componentType });
      expect(result.validity, title).toBe("VALID");
      expect(result.reason, title).not.toBe("whole-system");
    }
    // The two that carry a catalog model resolve to it, so this cannot pass by refusing nothing.
    expect(normalizeListing({ title: BOARD_PARTNER_TITLES[0][1], priceCents: 49900, componentType: "gpu" }).modelKey).toBe("Radeon RX 7800 XT");
    expect(normalizeListing({ title: BOARD_PARTNER_TITLES[1][1], priceCents: 49900, componentType: "gpu" }).modelKey).toBe("GeForce RTX 5080");
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
  it("T13: exactly fifteen sub-phrase overlaps exist across the seventeen vocabularies", () => {
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
      ["FREE_IS_NOT_THE_ITEM", [...FREE_IS_NOT_THE_ITEM]],
    ];
    expect(vocabularies).toHaveLength(17);

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
        // The `laptop` and `desktop` rows against SYSTEM_PHRASES are harmless in the same way the
        // four original ones are: both paths give `whole-system`.
        "WHOLE_UNIT:laptop < SYSTEM_PHRASES:gaming laptop",
        "WHOLE_UNIT:laptop < SYSTEM_PHRASES:laptop computer",
        "WHOLE_UNIT:desktop < SYSTEM_PHRASES:desktop computer",
        "WHOLE_UNIT:desktop < SYSTEM_PHRASES:desktop pc",
        "WHOLE_UNIT:desktop < SYSTEM_PHRASES:gaming desktop",
        // THESE TWO ARE LOAD-BEARING, NOT INCIDENTAL: they are the marker phrases that COVER the
        // whole-unit token `desktop` for a cpu or ram listing, exactly as `pc case` covers `pc`.
        // Deleting either one re-opens the collision that used to keep `desktop` out entirely.
        "WHOLE_UNIT:desktop < MARKERS.cpu:desktop processor",
        "WHOLE_UNIT:desktop < MARKERS.ram:desktop memory",
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
