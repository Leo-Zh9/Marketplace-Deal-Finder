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
  // B1: a marker phrase neutralises `desktop` only where it TRAILS the matched model. Punctuation
  // is stripped, so a prebuilt's spec list tokenizes `desktop` and `processor` adjacent and the
  // marker was neutralising the very token that says the listing is a whole machine. MEASURED:
  // the first row was stored VALID / Core i9-14900K at CA$1,500 -- a prebuilt as the CPU
  // benchmark, and pipe-delimited spec lists are the live data's own house style.
  ["B1a (rule 4): a spec list LEADS with the machine", "Dell Desktop | Processor: Core i9-14900K | 32GB | 1TB", 150000, "cpu", "INVALID_REFERENCE", null, "whole-system"],
  ["B1b (rule 4): the same shape on RAM", "Dell Desktop | Memory: Kingston Fury Beast 32GB DDR4 | 1TB", 151000, "ram", "INVALID_REFERENCE", null, "whole-system"],
  // B1c PINS THE SCOPE: the trailing rule is `desktop` only. `pc case` LEADS this title and the
  // model follows it, which is ordinary case phrasing -- the general rule would refuse it.
  ["B1c (rule 4): a leading 'pc case' still neutralises", "PC Case - Fractal North", 17700, "case", "VALID", "Fractal North", "matched"],

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
  // T15 MOVED FROM RULE 10 TO RULE 11, AND IT IS RECORDED RATHER THAN RE-BASELINED. This is the
  // exact card the live sample is selling and the catalog now lists it, so the row that used to
  // pin "a genuine uncatalogued GPU" stopped pinning that. T15n below takes over rule 10's duty
  // with a card that is deliberately still out of catalog (RX 500 / Polaris).
  //
  // THE DANGEROUS HALF, AND IT IS A CLASS OF DEFECT. catalogIndex.ts's tokenizer comment named
  // T15 as the test that goes red if `normalize("NFKD")` moves before `toLowerCase()`. MEASURED:
  // once `Radeon RX 6800 XT` is catalogued that is no longer true -- the mutated tokenizer gives
  // `radeontm`, but `rx 6800 xt` is still an entry point, so the model resolves either way and
  // the mutation kills NOTHING. A guard whose only test asserts an END-TO-END outcome can be
  // disarmed by a pure DATA change, with no code touched and no test going red. T15t in
  // catalogIndex.test.ts is the replacement, and it asserts the token stream itself.
  ["T15r (rule 11): live -- the RX 6800 XT the catalog now lists", "AMD Radeon™ RX 6800 XT Phantom Gaming D 16G OC", 49900, "gpu", "VALID", "Radeon RX 6800 XT", "matched"],
  ["T15n (rule 10): a genuine uncatalogued GPU, one generation older still", "XFX Speedster RX 580 8GB graphics card", 12900, "gpu", "VALID", null, "model-unmatched"],
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
/**
 * ... and SKU_SUFFIX_PHRASINGS below carries seven more, all of the same kind: a variant suffix
 * the list does not hold, pooling into the base model. They live there rather than here because
 * the corpus they were measured from is the thing that keeps them honest.
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
  // B1's own named cost: with no catalog match there is no model span for the marker to trail,
  // so a real CPU the catalog does not list is refused rather than stored with a null key.
  // THE INPUT MOVED, AND BOTH HALVES ARE ASSERTED. `Ryzen 5 5600` is now catalogued, so it no
  // longer exercises this residual; `Ryzen 5 4500` is a real CPU that is deliberately still out
  // of catalog. The half that CLOSED is RESIDUAL_CLOSED below -- swapping the input and saying
  // nothing would keep the suite green while a real improvement went unrecorded.
  ["T36f: retail box wording on an uncatalogued model", "AMD Ryzen 5 4500 Desktop Processor", 22000, "cpu", "INVALID_REFERENCE", null, "whole-system"],
];

/**
 * THE OTHER HALF OF T36f, AND IT IS AN IMPROVEMENT THIS SLICE CAUSED RATHER THAN A COST.
 *
 * PR #14 left the `desktop <component>` retail family as a named residual: with no catalog match
 * there is no model span for the `desktop processor` marker to TRAIL, so `desktop` stays an
 * uncovered whole-unit token and the listing is refused as a whole system. THE RULE DID NOT
 * CHANGE -- the SET it applies to shrank by 160 models. `AMD Ryzen 5 5600 Desktop Processor` is
 * the literal title T36f used to carry, and it is now a match.
 *
 * ASSERTING BOTH HALVES IS THE POINT. T36f pins the residual that REMAINS for a model the
 * catalog does not list; these two pin the part that CLOSED, so the residual can neither close
 * further nor re-open unnoticed. Either fails if `Ryzen 5 5600` leaves the catalog or if
 * COVERED_ONLY_WHEN_TRAILING is emptied.
 *
 * Prices 22100 and 11800 are distinct from every other fixture price, per the file's own
 * fixture-correlation rule at the top.
 */
const RESIDUAL_CLOSED: Case[] = [
  ["T36g: retail box wording on a cpu the catalog NOW lists", "AMD Ryzen 5 5600 Desktop Processor", 22100, "cpu", "VALID", "Ryzen 5 5600", "matched"],
  ["T36h: the ram half of the same residual", "Corsair Vengeance LPX 16GB DDR4 desktop memory", 11800, "ram", "VALID", "Corsair Vengeance LPX 16GB DDR4", "matched"],
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

  it.each(RESIDUAL_CLOSED)("%s", (...testCase) => {
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
   * T23d: THE TWO WAYS index 1 CAN BE THE ITEM, one test each, because the predicate is a
   * disjunction and either half alone passes the other's case. The marker half admits a free
   * component the catalog does not list; the model-span half admits one whose title starts with
   * the brand rather than with a marker word.
   */
  it("T23d: index 1 inside a MARKER phrase counts as the item", () => {
    expect(
      normalizeListing({ title: "Free graphics card - no longer needed", priceCents: 0, componentType: "gpu" }),
    ).toEqual({ modelKey: null, variantKey: null, validity: "VALID", reason: "model-unmatched" });
  });

  it("T23d: index 1 inside a MATCHED MODEL span counts as the item", () => {
    expect(
      normalizeListing({ title: "Free Lian Li Lancool 216", priceCents: 0, componentType: "case" }),
    ).toEqual({ modelKey: "Lian Li Lancool 216", variantKey: null, validity: "VALID", reason: "matched" });
  });

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
  // THREE MORE ON THE FINAL REVIEW, for a family this corpus could not see at all: `desktop` is a
  // whole-unit token on all nine types but the markers that neutralise it exist only on cpu and
  // ram, so ordinary retail phrasing is refused on the other seven. `"desktop graphics card"` is
  // how retail distinguishes a desktop GPU from a laptop one.
  ["gpu", "GeForce RTX 5080 desktop graphics card"],
  ["psu", "Corsair RM850x desktop power supply"],
  ["storage", "Samsung 990 Pro 2TB desktop SSD"],
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
 * board-partner brands at all, so "0 collisions against the 336" says nothing about these. This
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
  // `free` leads AND the next token is the item -- a marker word or the model itself.
  ["Free GeForce RTX 5080", "usable"],
  ["Free RTX 5070 graphics card", "usable"],
  ["Free! GeForce RTX 5080", "usable"],
  ["Free GeForce RTX 5080 no longer needed", "usable"],
  // THE FOUR ROWS THE DENYLIST GOT WRONG AND THE QUALIFIER GETS RIGHT: the item is free and the
  // sentence goes on to say how it travels. A word-list could not tell these from the next four.
  ["FREE GeForce RTX 5080 pick up only", "usable"],
  ["Free GeForce RTX 5080 - will ship", "usable"],
  ["Free GeForce RTX 5080, delivery available", "usable"],
  ["Free GeForce RTX 5080 - collection only", "usable"],
  // `free` leads but is attached to something that is not the item.
  ["Free local pickup - GeForce RTX 5080", "refused"],
  ["Free porch pickup GeForce RTX 5080", "refused"],
  ["Free collection - GeForce RTX 5080", "refused"],
  ["Free ships anywhere GeForce RTX 5080", "refused"],
  ["Free shipping on this GeForce RTX 5080", "refused"],
  // `free` does not lead at all.
  ["GeForce RTX 5080 - free shipping", "refused"],
  ["GeForce RTX 5080 with free item included", "refused"],
  ["GeForce RTX 5080, free to a good home", "refused"],
  // THE NAMED COST: a real free item with anything between `free` and the item.
  ["Free to a good home GeForce RTX 5080", "refused"],
  // THE FREE-ACCESSORY FAMILY, BOUNDED RATHER THAN CODED AROUND. When the free thing is an
  // accessory whose own word is a marker of the declared type, the predicate reads it as the
  // item. Both are VALID with a model key at CA$0 -- no benchmark impact, because
  // `recordSightings` requires `priceCents > 0`; the cost is a spurious DEAL under MAXIMUM_PRICE,
  // which is the square the evaluation table already documents and accepts. Rows, not a fix.
  ["Free graphics card box with GeForce RTX 5080", "usable"],
  ["Free gpu support bracket with GeForce RTX 5080", "usable"],
];

/**
 * REAL SKU-SUFFIX PHRASINGS, WRITTEN FROM THE PRODUCT LINES AND NOT FROM `SUFFIX_WORDS`.
 *
 * A missing entry in that list is a MIS-POOL, not a miss: it silently averages two different
 * products together, which is the one failure this phase exists to prevent. The per-element test
 * for the list (T20) iterates a copy of the list, so it can only ever confirm the members --
 * blind to exactly the entry nobody thought of. This corpus is the independent half.
 *
 * ITS JOB IS TO MAKE THE RESIDUAL KNOWN, NOT TO FINISH AN OPEN-ENDED LIST. Written cold it found
 * TEN mis-pools in twenty titles. Three were closed by adding `ii`, `touch` and `argb`, each
 * measured free against the 176 names AS OF PR #14, the 15 live titles and every title this
 * suite pins as a match. Removing any one of them today turns THIS test (R6) red, together with
 * T20's per-element sweep and, for `argb`, G1x -- not T11 or T12, which stay green even with
 * every guard in catalogIndex.ts deleted. Six remain ACCEPTED EXPOSURE, pinned below with the reason each word was refused, and a
 * seventh -- the year suffix -- was already a standing decision. An unmeasured residual is what
 * `Corsair RM850x 2021` was before anyone looked.
 */
const SKU_SUFFIX_PHRASINGS: [Listing["componentType"], string, "refused" | "pooled"][] = [
  // Closed by the list as it stands.
  ["gpu", "MSI RTX 5070 Ti Super gaming card", "refused"],
  ["gpu", "Radeon RX 9070 GRE graphics card", "refused"],
  ["cpu_cooler", "Noctua NH-U12S redux CPU cooler", "refused"],
  ["cpu_cooler", "Noctua NH-D15 chromax black cpu cooler", "refused"],
  ["case", "NZXT H7 Flow RGB case", "refused"],
  ["ram", "Corsair Vengeance 32GB DDR5 RGB", "refused"],
  ["case_fan", "Noctua NF-A12x25 LS-PWM case fan", "refused"],
  // Closed by a DIFFERENT rule -- the heatsink variants read as a foreign component.
  ["storage", "Samsung 990 Pro 2TB with Heatsink", "refused"],
  ["storage", "WD Black SN850X 2TB Heatsink nvme", "refused"],
  // Closed by the three words this corpus added.
  ["motherboard", "MSI MAG B650 Tomahawk WiFi II motherboard", "refused"],
  ["case", "Hyte Y70 Touch case", "refused"],
  ["cpu_cooler", "Thermalright Peerless Assassin 120 SE ARGB cooler", "refused"],
  // ACCEPTED EXPOSURE. Each pools into the base model; each word was refused for a named reason.
  ["psu", "Corsair RM850x 2021 power supply", "pooled"], // years are unbounded, by decision
  ["psu", "Seasonic Focus GX-850 ATX 3.0 power supply", "pooled"], // `atx` is a form factor
  ["cpu_cooler", "Arctic Liquid Freezer III 360 A-RGB", "pooled"], // splits to `a` + `rgb`
  ["case", "Fractal North XL TG Dark computer case", "pooled"], // `tg` may name the base product
  ["ram", "G.Skill Trident Z5 Neo 32GB DDR5 EXPO memory kit", "pooled"], // kits already carry EXPO
  ["psu", "Corsair SF1000 Platinum power supply", "pooled"], // may be the catalog entry's own name
  ["case", "Corsair 4000D Airflow Core case", "pooled"], // `core` collides with Intel Core
  // NOT A MIS-POOL, and listed so nobody "fixes" it: a Founders Edition is the same die and the
  // same comparison product as the board-partner cards. Refusing it would cost a real reference.
  ["gpu", "GeForce RTX 5080 Founders Edition", "pooled"],
  // The abbreviation IS the decision `fe` was refused over; the spelled-out row above exercises
  // the word `founders` instead. Also correct: the catalog stores generic names, so every
  // board-partner variant already pools into them and an FE is no different.
  ["gpu", "GeForce RTX 5080 FE", "pooled"],
];

/**
 * THE GENERATIONS THIS SLICE ADDED, WRITTEN FROM HOW A SELLER TYPES AN AD.
 *
 * WHY IT EXISTS AT ALL, AND IT IS A MEASUREMENT RATHER THAN AN OPINION. The catalog grew from
 * 176 names to 336. An ablation of 20 guards and vocabulary elements against BOTH catalogs
 * returned BYTE-IDENTICAL killer sets: doubling the data moved test coverage by exactly ZERO,
 * because every pre-existing test in this repo names a current-generation product. With this
 * corpus, G1x is the SOLE NEW KILLER of ten distinct mutations -- W-first-not-deepest,
 * G1-allow-walk-past, B2-ignore-endsRun, G2-ignore-suffix, TOK-no-letterdigit-split, the
 * OPTIONAL_LEADING drops of `geforce`, `radeon`, `intel` and `core`, and the SUFFIX_WORDS drops
 * of `xt` and `argb`. That is the evidence these rows are load-bearing rather than ballast.
 *
 * WRITTEN BEFORE ANY RESULT WAS KNOWN AND NOT DERIVED FROM THE MODEL LIST, which is the only
 * reason the six corpora above are worth anything. It earned that description in the writing:
 * the `Lian Li O11 Dynamic Razer Edition` row was PREDICTED as `refused` and MEASURED as
 * `no-key`, so the corpus corrected the plan rather than the other way round. Rows that MISS and
 * rows that POOL are kept deliberately -- a corpus that agreed with the catalog everywhere would
 * be evidence about the catalog, not about the matcher.
 *
 * HONEST SCOPE, SO NOBODY OVERCLAIMS IT: this pins the 30 titles it names, not all 160 added
 * models. Any deletion is still caught by T11's `toHaveLength(336)`; what the corpus adds is
 * that the CONSEQUENCE is named for what it covers. MEASURED: dropping `GeForce RTX 3060 8GB`
 * turns this red. A 160-row corpus would be ballast and was rejected as such.
 *
 * Shape: `[componentType, title, expected, why]`, where `expected` is the exact model key, or
 * `"no-key"` for VALID with none, or `"refused"` for anything else.
 */
const GENERATION_TITLES: [Listing["componentType"], string, string, string][] = [
  // --- THE FOUR GUARDS AND THE TWO VOCABULARIES, exercised against the NEW generations. Before
  // these rows every killer of each named a current-generation product.
  ["cpu", "AMD Ryzen 5 5600G processor", "no-key", "B2: the APU is a different die from the 5600"],
  ["cpu", "AMD Ryzen 5 3600 XT processor", "no-key", "G2: the XT is a different SKU from the 3600"],
  ["cpu", "Ryzen 7 5700X3D cpu", "Ryzen 7 5700X3D", "B2+W: the X3D is not the 5700X"],
  ["motherboard", "ASUS TUF Gaming B550-Plus WiFi motherboard", "no-key", "G1: the walk passes the base name, so refuse"],
  ["psu", "Corsair RM750x Shift PSU", "Corsair RM750x Shift", "W: the deeper name, not RM750x"],
  ["case", "NZXT H510 Elite tempered glass", "NZXT H510 Elite", "W: the +40% sibling, not the bare H510"],
  ["case_fan", "Arctic P12 PWM case fan", "Arctic P12 PWM", "W: the base, not the PST"],
  ["case", "Lian Li O11 Dynamic EVO ARGB computer case", "no-key", "G2: argb marks a SKU the catalog lacks"],
  ["cpu", "i5 12400F cpu only", "Core i5-12400F", "OPTIONAL_LEADING: sellers never type the word Core"],
  ["gpu", "Arc A750 8GB graphics card", "Intel Arc A750", "OPTIONAL_LEADING: `intel` dropped -- coverage, not a defect closed"],
  // --- THE LIVE PRODUCTION SAMPLE'S OWN CARDS, which is what this slice exists for.
  ["gpu", "XFX Speedster RX 6800 XT Merc 319 16GB", "Radeon RX 6800 XT", "in the 15 live titles"],
  ["gpu", "ASUS ROG Strix GTX 1080 Ti OC 11GB", "GeForce GTX 1080 Ti", "in the 15 live titles"],
  ["gpu", "RTX 2080ti 11gb blower", "GeForce RTX 2080 Ti", "B2+W on a concatenated alias"],
  // --- THE VRAM AXIS, BOTH SIDES AND BOTH OF ITS COSTS. Encoding a capacity split costs every
  // bare-name listing, and the second cost is the larger one.
  ["gpu", "Zotac GTX 1060 6gb mini", "GeForce GTX 1060 6GB", "encoded: ~40% from the 3GB"],
  ["gpu", "GTX 1060 3gb", "GeForce GTX 1060 3GB", "encoded: the other side"],
  ["gpu", "Nvidia GTX 1060", "no-key", "THE COST of encoding it: the bare name matches neither"],
  ["gpu", "RTX 3060 8GB graphics card", "GeForce RTX 3060 8GB", "encoded: ~30% from the 12GB, when the capacity follows the model"],
  ["gpu", "Gigabyte RTX 3060 Gaming OC 8GB", "no-key", "THE OTHER COST: a board-partner word between model and capacity breaks contiguity"],
  // --- ACCEPTED POOLS, each carrying its measured price gap. G2 inspects exactly ONE token past
  // the match, so a differentiator whose first token is benign (`a rgb`, `v 2`, `ac`, `wifi`) is
  // not seen at all. TWO of these sit above the ~20% encode threshold and each has its own named
  // volume argument; neither is precedent for a third.
  ["motherboard", "MSI MAG B550 Tomahawk WiFi motherboard", "MSI MAG B550 Tomahawk", "POOL ~23%: `wifi` is benign and the catalogued sibling is `MAX WiFi`"],
  ["cpu_cooler", "Arctic Liquid Freezer II 240 A-RGB cpu cooler", "Arctic Liquid Freezer II 240", "POOL ~15%: `a rgb` -- G2 sees only `a`"],
  ["cpu_cooler", "Cooler Master Hyper 212 EVO V2 cpu cooler", "Cooler Master Hyper 212 EVO", "POOL ~15%: `v 2` -- G2 sees only `v`"],
  ["motherboard", "ASRock B550M Pro4 AC motherboard", "ASRock B550M Pro4", "POOL ~15%: `ac` is benign"],
  // THE TWO POOLS THIS SLICE ITSELF CREATED, by shipping a bare stem. The plan's own rule is
  // that a bare short name ships with its priced-apart siblings or not at all; these two stems
  // shipped without the sibling, and the differentiator (`lite`, `performance`) is a benign word
  // G2 cannot see. Both are at or above the ~20% encode threshold, so they are named here rather
  // than left to an aggregate -- closing either means shipping the sibling, as X570-E did.
  ["case", "Fractal Meshify 2 Lite ATX case", "Fractal Meshify 2", "POOL ~25-30%: the Lite is a cheaper steel-panel SKU; `lite` is benign to G2"],
  ["case", "Lian Li Lancool II Mesh Performance computer case", "Lian Li Lancool II Mesh", "POOL ~20%: the Performance adds fans; `performance` is benign to G2"],
  ["gpu", "Sapphire Radeon RX 6500 XT 8GB graphics card", "Radeon RX 6500 XT", "POOL ~18-20%: the 4GB/8GB split is NOT encoded"],
  ["gpu", "EVGA GeForce RTX 3080 12GB FTW3 graphics card", "GeForce RTX 3080", "POOL ~12%: below the encode threshold, by decision"],
  ["gpu", "NVIDIA GeForce RTX 2060 12GB graphics card", "GeForce RTX 2060", "POOL ~25%: negligible volume, by decision"],
  // --- POOLS THAT WERE CLOSED, pinned so a later edit cannot silently re-open them. One was
  // closed by SHIPPING the sibling, the other by NOT shipping the bare name.
  ["motherboard", "ASUS ROG Strix X570-E Gaming WiFi II motherboard", "ASUS ROG Strix X570-E Gaming WiFi II", "CLOSED (~25%) by shipping the sibling"],
  ["case", "Lian Li O11 Dynamic Razer Edition pc case", "no-key", "CLOSED (~40%) by NOT shipping the bare O11 Dynamic -- a clean miss, not a refusal"],
  // --- THE e2e FIXTURE'S OWN TITLE. `scripts/e2e-local.sh` depends on this listing being a real
  // standalone GPU the catalog does NOT list; cataloguing Maxwell breaks that gate in seven ways,
  // one of which is an un-seedable INSERT rather than a wrong number. This row says so in 13
  // seconds instead of leaving it to the expensive gate.
  ["gpu", "Nvidia GeForce GTX 980 Ti Graphics Card with MSI Cooler", "no-key", "PINS scripts/e2e-local.sh -- do not catalogue GTX 900"],
];

describe("normalizeListing -- the measured cost and the measured residual", () => {
  /**
   * F5a. THE COST, ABSOLUTE AND RE-DERIVABLE. The declined set is asserted by name, not by
   * count: a count alone would stay green while the eight swapped for eight different ones.
   *
   * IT HAS NOW MOVED THREE TIMES, AND THE THIRD IS THE CLEAREST CASE FOR THE CORPUS EXISTING.
   * The `desktop <component>` retail family was refused on seven component types from the moment
   * `desktop` was admitted, and this corpus held NO instance of it -- so the cost figure could
   * not see it, and nothing went red. An unnamed residual is not a smaller residual.
   *
   * THE NUMBER HAS MOVED TWICE BEFORE THAT AND BOTH MOVES ARE THE POINT. It was reported as 3 when it was
   * 4 -- that count omitted the fan pack, which is ruling 2's deliberate choice. It is now 8 of
   * 28, because four shapes the corpus did not cover were added once the quantity vocabulary
   * grew: age phrasing (`two months old`), compatibility copy (`fits both AM4 and AM5`), a kit
   * written the trailing way round (`32GB 2x16`, which PLAN.md:54 calls ONE kit), and a bare SKU
   * with one word before it (`AMD 9600X processor`), which is what the index<=1 multiplier bound
   * costs. Every one is a LOST reference, never a wrong one -- but a vocabulary whose comment
   * claims no cost at all is the thing this corpus exists to prevent.
   */
  it("F5a: exactly 11 of 31 realistic standalone titles are declined, and these are the eleven", () => {
    expect(STANDALONE_COMPONENTS).toHaveLength(31);
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
      "GeForce RTX 5080 desktop graphics card",
      "Corsair RM850x desktop power supply",
      "Samsung 990 Pro 2TB desktop SSD",
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
   * R1b. THE FREE FAMILY, FROM THE SELLER'S SIDE RATHER THAN THE CODE'S -- written from what a
   * seller writes, not from what the code denies, which is the only way a corpus can find a word
   * nobody thought of. It did: `porch pickup` and `pick up only` were both VALID with a model key
   * at a real CA$0 when it was written, which under MAXIMUM_PRICE is the verdict PR #6 exists to
   * prevent. The denylist that followed then got FOUR of these rows wrong in the other direction
   * -- an item that is free and also collected in person is still free -- which is why the
   * predicate asks what `free` is attached to instead of listing what it must not be.
   */
  it("R1c: every real free phrasing lands on the right side of rule 8", () => {
    expect(FREE_PHRASINGS).toHaveLength(19);
    for (const [title, expected] of FREE_PHRASINGS) {
      const result = normalizeListing({ title, priceCents: 0, componentType: "gpu" });
      const actual = result.validity === "VALID" && result.modelKey !== null ? "usable" : "refused";
      expect(actual, title).toBe(expected);
    }
    // Not satisfiable by refusing everything: ten rows must still come back with a model key.
    expect(FREE_PHRASINGS.filter(([, e]) => e === "usable")).toHaveLength(10);
  });

  /**
   * R6. THE SUFFIX RESIDUAL, MEASURED. Seven of the nine pooling rows are mis-pools and are
   * ACCEPTED EXPOSURE (the other two, the Founders Edition rows, are correct); the assertion is per row, so closing one shows up as a failure asking for the
   * comment to be updated, and a NEW mis-pool shows up as a row that was refused and no longer is.
   */
  it("R6: every real SKU-suffix phrasing lands where the measurement says, pooled ones included", () => {
    expect(SKU_SUFFIX_PHRASINGS).toHaveLength(21);
    for (const [componentType, title, expected] of SKU_SUFFIX_PHRASINGS) {
      const result = normalizeListing({ title, priceCents: 6300, componentType });
      expect(result.modelKey === null ? "refused" : "pooled", title).toBe(expected);
    }
    // Not satisfiable by refusing everything, nor by matching everything. NINE rows pool: seven
    // are mis-pools and accepted exposure, and two -- the Founders Edition spelled out and
    // abbreviated -- are the correct answer, because the catalog stores generic names and every
    // board-partner variant already pools into them.
    expect(SKU_SUFFIX_PHRASINGS.filter(([, , e]) => e === "pooled")).toHaveLength(9);
  });

  /**
   * G1x. THE NEW GENERATIONS, ROW BY ROW, WITH THE `why` IN THE ASSERTION MESSAGE. Asserted per
   * row so that deleting an added model surfaces as the one title that changed rather than as a
   * count. The three totals underneath stop it being satisfiable by refusing everything or by
   * matching everything.
   */
  it("G1x: every new-generation seller title lands exactly where the measurement says", () => {
    expect(GENERATION_TITLES).toHaveLength(30);
    for (const [componentType, title, expected, why] of GENERATION_TITLES) {
      const result = normalizeListing({ title, priceCents: 6300, componentType });
      const actual =
        result.modelKey !== null
          ? result.modelKey
          : result.validity === "VALID"
            ? "no-key"
            : "refused";
      expect(actual, `${title} -- ${why}`).toBe(expected);
    }
    // Not satisfiable by refusing everything, nor by matching everything.
    expect(GENERATION_TITLES.filter(([, , expected]) => expected !== "no-key")).toHaveLength(22);
    expect(GENERATION_TITLES.filter(([, , expected]) => expected === "no-key")).toHaveLength(8);
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
  it("T13: exactly fifteen sub-phrase overlaps exist across the sixteen vocabularies", () => {
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
