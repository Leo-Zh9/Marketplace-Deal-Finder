// @vitest-environment node

/**
 * The index and its three guards, plus the three EXHAUSTIVE properties of the whole rule that
 * are properties of the catalog rather than of any one title. The exhaustive ones run through
 * `normalizeListing` deliberately: asserting them at the matcher alone would pass while a
 * classification rule threw every match away.
 *
 * READ THE GUARD-ABLATION TABLE BEFORE DELETING ANYTHING HERE. SCOPED, BECAUSE IT COULD NOT BE
 * RE-DERIVED: the per-guard figures below were measured over 5,808 generated titles against THE
 * 176-NAME CATALOG AS OF PR #14 (176 names x (1 + 16 suffixes x 2 concatenation forms)) --
 * removing one guard and keeping the rest changed W 84 results, G1 5, B2 518, G2 1,580. The
 * catalog now holds 336 names, so the title count is 11,088 and those four numbers no longer
 * describe this repo. A faithful reconstruction of the generator gave W 44, G1 0, B2 171,
 * G2 2,284 against the same 176 names, so the construction that produced them is not recoverable
 * and the post-change figures were NOT invented to replace them.
 *
 * WHAT SURVIVES THE RESCOPING IS THE PART THAT MATTERS, and it was re-measured against the 336:
 * T29 is the SOLE PRE-EXISTING killer of G1 and T25 the SOLE PRE-EXISTING killer of B2 -- T1 and
 * T27 are each covered by two guards and discriminate neither, so deleting T25 or T29 as
 * "redundant with T1" leaves a guard with one test (G1x in normalizeListing.test.ts) instead of
 * two, not with none.
 */

import { componentCatalog } from "../../src/data/catalog";
import type { Listing } from "../storage/types";
import {
  CATALOG_COMPONENT_ID,
  MAX_TOKENS,
  MODEL_INDEXES,
  matchCatalogModels,
  phraseSpans,
  tokenValues,
  tokenize,
} from "./catalogIndex";
import {
  MARKERS,
  MULTIPLE,
  MULTI_UNIT,
  SYSTEM_PHRASES,
  WHOLE_UNIT,
  normalizeListing,
} from "./normalizeListing";

/**
 * The 15 titles a real GPU search returned in production, copied as literals. The suite READS
 * production data; it does not depend on it.
 */
const LIVE_TITLES = [
  "For trade: MSI RTX 3060 Ventus 2X 12GB for an Intel Arc B580 12gb",
  "EVGA GeForce GTX 980 Ti Classified Graphics Card for parts",
  "Timetec 16GB DDR4 3200MHz SODIMM Laptop RAM",
  "Tesla 128GB USB Drive and Key Card",
  "Samsung 870 EVO and 860 EVO 500GB SSD",
  "Lian Li lancool 217 White PC Case",
  "XPG Gammix D10 32GB (2x16GB) DDR4 3200MHz RAM",
  "Gigabyte vision 3060ti (white)",
  "AMD Radeon™ RX 6800 XT Phantom Gaming D 16G OC",
  "Selling My 4070 TI",
  "Lenovo ThinkCentre M70q Gen 6 U5235T 16GB/256GB W11 Pro",
  "Gaming+PC+",
  "RTX 4070 super gaming pc | Ryzen 5 7600 | 32gb DDR4 RAM | 1tb nvme",
  "GPU: ASUS ROG Astral GeForce RTX 5080",
  "MINT Alienware x17 R2 Flagship Ecosystem - i9 | RTX 3080 Ti (16GB)",
];

const WORKER_TYPES = Object.keys(CATALOG_COMPONENT_ID) as Listing["componentType"][];

const catalogModels = (componentType: Listing["componentType"]): readonly string[] => {
  const definition = componentCatalog.find(
    (entry) => entry.id === CATALOG_COMPONENT_ID[componentType],
  );
  if (definition === undefined) throw new Error(`no catalog component for ${componentType}`);
  return definition.models;
};

/**
 * The single catalog model a title names, or null. Every title below is a single-model case by
 * construction, so two hits is a broken fixture and says so rather than silently taking the
 * first.
 */
const match = (componentType: Listing["componentType"], title: string): string | null => {
  const models = matchCatalogModels(MODEL_INDEXES[componentType], tokenize(title));
  if (models.length > 1) {
    throw new Error(`fixture "${title}" matched ${models.length} models: ${models.join(", ")}`);
  }
  return models[0] ?? null;
};

describe("catalog index -- the match and its guards", () => {
  it.each<[string, Listing["componentType"], string, string | null]>([
    ["T2: a vendor-prefixed 5060 is the 5060", "gpu", "ASUS ROG RTX 5060 Dual OC", "GeForce RTX 5060"],
    ["T3 (W): the 16GB Ti SKU is its own model", "gpu", "ASUS Dual RTX 5060 Ti 16GB", "GeForce RTX 5060 Ti 16GB"],
    ["T30 (W): RM850x Shift is not RM850x", "psu", "Corsair RM850x Shift power supply", "Corsair RM850x Shift"],
    ["T29 (G1, SOLE KILLER): a revision the catalog lacks", "cpu_cooler", "Noctua NH-D15 G3 cpu cooler", null],
    ["T25 (B2, SOLE KILLER): X3D is not the non-X3D", "cpu", "Ryzen 7 7700X3D processor", null],
    ["T26 (G2): Ti Super is not Ti", "gpu", "MSI RTX 5070 Ti Super gaming card", null],
    ["T34 (G2): the redux is a cheaper line", "cpu_cooler", "Noctua NH-U12S redux CPU cooler", null],
    ["T35 (G2): the GRE is a cut-down SKU", "gpu", "Radeon RX 9070 GRE graphics card", null],
    ["T4: the tokens must be contiguous and in order", "gpu", "MSI Ventus RTX 4070 Ti Super graphics card", "GeForce RTX 4070 Ti Super"],
    ["T6: a fully concatenated alias", "gpu", "rx9070xt gpu, boxed", "Radeon RX 9070 XT"],
    ["T28: a concatenated alias, second guard", "gpu", "rtx5080 graphics card", "GeForce RTX 5080"],
    // T7b's killer is NOT what it looks like. MEASURED: dropping `toLowerCase` does not move it,
    // because the SAME tokenizer builds the index -- both sides break identically and the match
    // survives. What it does kill is the de-duplication in `matchCatalogModels`: this title
    // matches `Radeon RX 7800 XT` twice, once at `radeon` and once at the `rx` entry point. The
    // NFKD hazard the tokenizer's comment describes is killed by T15t below, not here -- and not
    // by T15 in normalizeListing.test.ts either, which is what this line used to say. Once
    // `Radeon RX 6800 XT` was catalogued that mutation stopped killing anything end-to-end.
    ["T7b: the trademark sign is noise (kills the hit de-duplication, not the case-folding)", "gpu", "AMD Radeon™ RX 7800 XT graphics card", "Radeon RX 7800 XT"],
  ])("%s", (_name, componentType, title, expected) => {
    expect(match(componentType, title)).toBe(expected);
  });

  /**
   * REGRESSION ONLY -- each of these is covered by TWO guards, so no single-guard ablation moves
   * either one and NEITHER DISCRIMINATES. They are kept because they are the two shapes the
   * brief names as actively dangerous; they are not evidence that G1 or B2 is tested.
   */
  it.each<[string, Listing["componentType"], string]>([
    ["T1: a bare Ti must not pool into the base card (G1 and G2 both refuse it)", "gpu", "ASUS Dual RTX 5060 Ti OC"],
    ["T27: a concatenated Ti must not pool into the base card (B2 and G2 both refuse it)", "gpu", "RTX5080Ti graphics card"],
  ])("%s", (_name, componentType, title) => {
    expect(match(componentType, title)).toBeNull();
  });
});

/**
 * PER-ELEMENT VOCABULARY COVERAGE. The tests below carry their OWN literal copy of each
 * vocabulary, deliberately: a test that iterates the production list cannot detect a deletion
 * FROM that list, because the row disappears with the element. Measured -- that is exactly how
 * dropping `"intel"` from OPTIONAL_LEADING passed 134 tests while silently un-matching every
 * Intel Arc listing that omits the word "Intel".
 *
 * Named limitation: these pin removals and changes, NOT additions. A new entry in either set is
 * caught only where it breaks T11's 336 self-resolutions, T13's overlap audit, or -- for a
 * catalog name rather than a vocabulary entry -- T47 and T48 below.
 */
describe("catalog index -- every vocabulary element, one at a time", () => {
  /**
   * T14. OPTIONAL_LEADING, element by element. The behaviour rows use a title that drops the
   * vendor word, which is the ONLY thing the set does: it adds suffix entry points to the trie.
   *
   * THE COUNT MAP IS THE EVIDENCE FOR THE TWO ELEMENTS THAT HAVE NO BEHAVIOUR ROW. `nvidia` and
   * `amd` are inert against THIS catalog -- no catalog name begins with either, so neither can
   * ever produce a suffix entry point, and no test can kill them. They are reported as dead
   * vocabulary rather than quietly kept; if a future catalog adds an "AMD Ryzen ..." or
   * "NVIDIA RTX ..." name, this map changes and that decision comes back into view.
   */
  it("T14: each vendor prefix that a catalog name actually carries is droppable", () => {
    const leading: Record<string, number> = { geforce: 0, nvidia: 0, radeon: 0, amd: 0, intel: 0, core: 0 };
    for (const componentType of WORKER_TYPES) {
      for (const model of catalogModels(componentType)) {
        const first = tokenize(model)[0].value;
        if (first in leading) leading[first] += 1;
      }
    }
    expect(leading).toEqual({ geforce: 43, nvidia: 0, radeon: 20, amd: 0, intel: 5, core: 19 });

    expect(match("gpu", "RTX 5080 graphics card")).toBe("GeForce RTX 5080");
    expect(match("gpu", "RX 7800 XT graphics card")).toBe("Radeon RX 7800 XT");
    // The one the whole sweep exists for: an Arc listing that omits the word "Intel".
    expect(match("gpu", "Arc B580 graphics card")).toBe("Intel Arc B580");
    // And the one `core` exists for: a seller writes "i7 12700K", never "Core i7-12700K".
    expect(match("cpu", "i7 12700K processor")).toBe("Core i7-12700K");
  });

  /**
   * T20. SUFFIX_WORDS, element by element: each one, following an otherwise-complete model name,
   * must refuse the match. The control is what stops this being satisfiable by a matcher that
   * refuses EVERY trailing word.
   */
  it.each([
    ["ti"], ["super"], ["xt"], ["xtx"], ["gre"], ["redux"], ["le"], ["chromax"], ["rgb"], ["d"],
    // The three the SKU-suffix corpus added. Without these rows each is killed only by a single
    // corpus row -- and corpus rows get edited when a mis-pool closes. This file's own rule.
    ["ii"], ["touch"], ["argb"],
  ])(
    "T20: a trailing %s refuses the match",
    (suffix) => {
      expect(match("gpu", `GeForce RTX 5080 ${suffix}`)).toBeNull();
    },
  );

  /**
   * T15t. THE ROLE T15 USED TO PLAY, MOVED TO THE LAYER THE GUARD LIVES AT.
   *
   * `catalogIndex.ts`'s tokenizer comment names T15 in normalizeListing.test.ts as the test that
   * goes red if `normalize("NFKD")` is moved BEFORE `toLowerCase()`. MEASURED: that stopped being
   * true the moment `Radeon RX 6800 XT` entered the catalog. Under the mutation T15's title
   * tokenizes `radeontm` and loses its `radeon` marker -- but `rx 6800 xt` is an OPTIONAL_LEADING
   * entry point, so the model resolves either way and the whole 220-test suite stayed green.
   *
   * THAT IS A CLASS OF DEFECT, NOT ONE INSTANCE: a guard whose only test asserts an END-TO-END
   * outcome can be disarmed by a pure DATA change, with no code touched and nothing going red.
   * The defence is to test a token-layer guard AT THE TOKEN LAYER, which nothing else here does.
   */
  it("T15t: the trademark sign is a separator, not a token (SOLE killer of the split order)", () => {
    expect(tokenValues(tokenize("AMD Radeon\u2122 RX 6800 XT"))).toEqual([
      "amd",
      "radeon",
      "rx",
      "6800",
      "xt",
    ]);
  });

  it("T20 control: an unlisted trailing word does NOT refuse the match", () => {
    expect(match("gpu", "GeForce RTX 5080 oc")).toBe("GeForce RTX 5080");
  });
});

describe("catalog index -- exhaustive properties", () => {
  /**
   * T11. The ANCHOR of the whole suite: a normalizer that always returns null fails 336 times
   * here. The counts are asserted FIRST so an empty or failed catalog import cannot pass this
   * vacuously.
   *
   * ALL NINE PER-TYPE COUNTS, NOT JUST `gpu`, AND THE REASON IS A HOLE THE OTHER GUARDS LEAVE
   * OPEN. A name typed into the WRONG component block is invisible to every other check here:
   * the total is unchanged, there is no duplicate, and the resolution loop below PASSES because
   * it declares each name under whatever type it was found in -- so a misfiled name
   * self-resolves happily under the wrong one. T12 cannot see it either, because it tests a name
   * against the eight OTHER indexes and the name is no longer in its real one. MEASURED: moving
   * `be quiet! Pure Power 11 600W` from the psu block to the case block left
   * `worker/normalize` + `src/App.test.tsx` at 234 passed, 0 failed.
   *
   * With nine numbers a MOVE shows as two counts changing and the diff NAMES BOTH TYPES, a name
   * added to the wrong block shows as the total plus one count, and a deletion shows as the
   * total. The consequence of a misfile is a LOST reference rather than a wrong price -- the
   * real listing stops matching and the foreign side is refused by rule 5 -- but with 336 names
   * hand-sorted into nine arrays, which array a line landed in is the single most likely error
   * in this file.
   *
   * THE KEYS ARE WORKER TYPES, NOT CATALOG IDS. `case_fan` here is `case_fans` in
   * src/data/catalog.ts; `catalogModels` maps through CATALOG_COMPONENT_ID. See the named trap
   * on that record.
   */
  it("T11: all 336 catalog names, declared as their own type, resolve to themselves", () => {
    const names = WORKER_TYPES.flatMap((componentType) =>
      catalogModels(componentType).map((model) => [componentType, model] as const),
    );
    expect(names).toHaveLength(336);
    expect(
      Object.fromEntries(
        WORKER_TYPES.map((componentType) => [componentType, catalogModels(componentType).length]),
      ),
    ).toEqual({
      cpu: 45,
      cpu_cooler: 29,
      motherboard: 36,
      ram: 26,
      storage: 40,
      gpu: 68,
      psu: 29,
      case: 37,
      case_fan: 26,
    });

    for (const [componentType, model] of names) {
      expect(
        normalizeListing({ title: model, priceCents: 6300, componentType }),
        `${componentType} | ${model}`,
      ).toEqual({ modelKey: model, variantKey: null, validity: "VALID", reason: "matched" });
    }
  });

  /**
   * T12. Every catalog name declared as each of the eight OTHER component types. A VALID result
   * carrying a model key would mean a listing entered another type's benchmark.
   */
  it("T12: none of the 2,688 cross-type pairs produces a VALID result with a model", () => {
    const pairs = WORKER_TYPES.flatMap((componentType) =>
      catalogModels(componentType).flatMap((model) =>
        WORKER_TYPES.filter((other) => other !== componentType).map(
          (declared) => [declared, model] as const,
        ),
      ),
    );
    expect(pairs).toHaveLength(2_688);

    const leaks = pairs.filter(([declared, model]) => {
      const result = normalizeListing({ title: model, priceCents: 6300, componentType: declared });
      return result.validity === "VALID" && result.modelKey !== null;
    });
    expect(leaks.map(([declared, model]) => `${declared} <- ${model}`)).toEqual([]);
  });

  /**
   * T47. EVERY SAME-TYPE TOKEN-PREFIX PAIR WHOSE FIRST EXTRA TOKEN IS NOT A SUFFIX WORD.
   *
   * `variantKey` is null by design, so two products sharing one catalog name pool into ONE
   * average. A shorter catalog name whose token sequence is a strict PREFIX of a longer one is
   * the shape that creates that pooling: G2 refuses the pair when the extra token is in
   * SUFFIX_WORDS, and every OTHER pair is protected by nothing except which siblings happen to
   * be listed. This asserts the exact remainder BY NAME, so each is a reviewed decision.
   *
   * A NEW ROW IS NOT AUTOMATICALLY A DEFECT -- `Ryzen 5 5600 < Ryzen 5 5600X` is correct and
   * wanted. It is a row that has to be looked at, priced, and either kept or closed by shipping
   * the sibling. That is the whole point: 27 reviewed decisions instead of 27 accidents.
   *
   * THE SUFFIX SET IS MIRRORED AS A LITERAL, NOT IMPORTED. This file's own rule (see the
   * vocabulary block above): a test that iterates the production list cannot detect a deletion
   * FROM that list, because the exclusion disappears with the element.
   *
   * IT WALKS EVERY TRIE ENTRY POINT, NOT JUST THE FULL NAMES. `buildModelIndex` inserts each
   * name AND every suffix obtained by dropping leading OPTIONAL_LEADING tokens -- 423 cores for
   * 336 names. A prefix relation that exists only between two STRIPPED cores pools exactly as
   * badly as one between two full names, and the full-name-only form could not see it.
   * MEASURED: over all 423 cores the answer is the same 27 rows it was over the 336 names, so
   * this ships as a no-op today and closes the gap the first time a stripped core becomes a
   * prefix of another name. Duplicate labels (a pair visible at both the full and the stripped
   * depth, as `Core i5-12400 < Core i5-12400F` is) are collapsed.
   */
  it("T47: every unguarded token-prefix pair is one of these 27", () => {
    const SUFFIX_MIRROR = new Set([
      "ti",
      "super",
      "xt",
      "xtx",
      "gre",
      "redux",
      "le",
      "chromax",
      "rgb",
      "d",
      "ii",
      "touch",
      "argb",
    ]);

    // A LITERAL MIRROR OF OPTIONAL_LEADING TOO, for the same reason as SUFFIX_MIRROR: importing
    // it would make this blind to a deletion from it.
    const LEADING_MIRROR = new Set(["geforce", "nvidia", "radeon", "amd", "intel", "core"]);
    // Every core buildModelIndex inserts: the full token sequence, plus each suffix obtained by
    // dropping leading optional tokens. `< length - 1` mirrors the production loop's guard
    // against a name that is entirely optional-leading tokens collapsing to an empty core.
    const cores = (model: string): string[][] => {
      const sequence = tokenValues(tokenize(model));
      const out = [sequence];
      let start = 0;
      while (start < sequence.length - 1 && LEADING_MIRROR.has(sequence[start])) {
        start += 1;
        out.push(sequence.slice(start));
      }
      return out;
    };

    const pairs = new Set<string>();
    for (const componentType of WORKER_TYPES) {
      const sequences = catalogModels(componentType).flatMap(
        (model) => cores(model).map((tokens) => [model, tokens] as const),
      );
      for (const [shorter, shorterTokens] of sequences) {
        for (const [longer, longerTokens] of sequences) {
          if (shorter === longer || shorterTokens.length >= longerTokens.length) continue;
          if (!shorterTokens.every((value, index) => value === longerTokens[index])) continue;
          if (SUFFIX_MIRROR.has(longerTokens[shorterTokens.length])) continue;
          pairs.add(`${componentType}: ${shorter} < ${longer}`);
        }
      }
    }

    expect([...pairs].sort()).toEqual([
      "case: Cooler Master NR200 < Cooler Master NR200P",
      "case: Corsair 4000D < Corsair 4000D Airflow",
      "case: Corsair 5000D < Corsair 5000D Airflow",
      "case: Fractal Meshify 2 < Fractal Meshify 2 Compact",
      "case: Fractal Meshify 2 < Fractal Meshify 2 XL",
      "case: Fractal North < Fractal North XL",
      "case: Lian Li O11 Dynamic EVO < Lian Li O11 Dynamic EVO XL",
      "case: NZXT H510 < NZXT H510 Elite",
      "case: NZXT H510 < NZXT H510 Flow",
      "case: NZXT H510 < NZXT H510i",
      "case: NZXT H710 < NZXT H710i",
      "case_fan: Arctic P12 PWM < Arctic P12 PWM PST",
      "case_fan: Lian Li UNI FAN SL120 < Lian Li UNI FAN SL120 V2",
      "cpu: Core i5-12400 < Core i5-12400F",
      "cpu: Ryzen 5 3600 < Ryzen 5 3600X",
      "cpu: Ryzen 5 5600 < Ryzen 5 5600X",
      "cpu: Ryzen 7 5700X < Ryzen 7 5700X3D",
      "cpu: Ryzen 7 5800X < Ryzen 7 5800X3D",
      "cpu: Ryzen 9 9900X < Ryzen 9 9900X3D",
      "cpu: Ryzen 9 9950X < Ryzen 9 9950X3D",
      "cpu_cooler: Noctua NH-D15 < Noctua NH-D15 G2",
      "motherboard: ASUS ROG Strix X570-E Gaming < ASUS ROG Strix X570-E Gaming WiFi II",
      "motherboard: ASUS TUF Gaming B550-Plus < ASUS TUF Gaming B550-Plus WiFi II",
      "motherboard: MSI MAG B550 Tomahawk < MSI MAG B550 Tomahawk MAX WiFi",
      "psu: Corsair RM1000x < Corsair RM1000x Shift",
      "psu: Corsair RM750x < Corsair RM750x Shift",
      "psu: Corsair RM850x < Corsair RM850x Shift",
    ]);
  });

  /**
   * T48. THE GUARD THE BRIEF BELIEVED T13 ALREADY WAS.
   *
   * T13 audits the rule vocabularies against EACH OTHER. It never looks at a catalog name, and
   * neither does anything else -- so NOTHING checked catalog names against the vocabularies at
   * all. A name can be harmless alone and, joined to a marker phrase of its own type, spell a
   * phrase that disqualifies the listing: `Lian Li O11 Dynamic Mini` + `pc case` is
   * `"... mini pc case"`, and `mini pc` is a SYSTEM_PHRASE. That name was drafted, caught here,
   * and is deliberately not in the catalog.
   *
   * IT AUDITS TWO VOCABULARIES, NOT FOUR, AND THE ARITHMETIC IS WHY. A span straddles only if it
   * STARTS before the join and ENDS after it, so it must be at least two tokens long. Every
   * WHOLE_UNIT and MULTI_UNIT entry is a SINGLE token, which makes `from < boundary && to >
   * boundary` impossible for them by construction -- including them would have been inert
   * padding that made this test's name claim more than it audits. They are covered instead by
   * T11: a single token that disqualifies a name fires on the name ALONE, so that name would
   * fail to self-resolve. MEASURED: of 14 WHOLE_UNIT tokens and 1 MULTI_UNIT token, 0 are
   * multi-token. What is left is the genuinely reachable class -- 8 of the 25 SYSTEM_PHRASES and
   * 3 of the 9 MULTIPLE phrases, 11 in all.
   *
   * ONLY SPANS THAT STRADDLE THE JOIN COUNT, AND THE NARROWING IS THE GUARD RATHER THAN A TEST
   * TRIMMED UNTIL IT WENT GREEN. The obvious formulation -- "name + marker must still resolve to
   * the name" -- FAILS 17 TIMES ON THE UNTOUCHED 176-NAME CATALOG, all of them
   * `<fan name> + "fan pack"`, which is ruling 2's deliberate choice that a fan pack really is a
   * pack. Flagging those would re-litigate a settled ruling, and the `pc case` -> `pc`
   * neutralisation with it. `pc case` contains `pc` WITHIN the marker and `fan pack` contains
   * `pack` WITHIN the marker; neither straddles, and a phrase spelled by the JOIN is exactly
   * what neither mechanism intends.
   *
   * MEASURED ON THREE CATALOGS: the untouched 176 -> 0 straddles, the 337-name draft -> exactly
   * 1 (the O11 Dynamic Mini, and nothing else), the shipped 336 -> 0. Zero on the untouched
   * catalog is what says this is a NEW guard rather than a pre-existing failure smuggled in
   * under a new name.
   *
   * ASSERTED BY NAME, NOT BY COUNT, so a straddle that appears is readable without re-deriving.
   */
  it("T48: no catalog name joined to its own type's marker spells a multi-token system or multiplicity phrase", () => {
    // Multi-token entries only: a one-token phrase cannot straddle a boundary. Asserted rather
    // than assumed, so that a future two-token WHOLE_UNIT/MULTI_UNIT entry re-opens this test
    // instead of silently sitting outside it.
    const multiToken = (phrases: readonly string[]): string[] =>
      phrases.filter((phrase) => tokenize(phrase).length > 1);
    expect(multiToken([...WHOLE_UNIT])).toEqual([]);
    expect(multiToken([...MULTI_UNIT])).toEqual([]);

    const vocabulary: [string, string][] = [
      ...multiToken(SYSTEM_PHRASES).map((phrase) => ["SYSTEM_PHRASES", phrase] as [string, string]),
      ...multiToken(MULTIPLE).map((phrase) => ["MULTIPLE", phrase] as [string, string]),
    ];
    // Not satisfiable by an empty vocabulary.
    expect(vocabulary).toHaveLength(11);

    const straddles: string[] = [];
    for (const componentType of WORKER_TYPES) {
      for (const model of catalogModels(componentType)) {
        const modelLength = tokenize(model).length;
        for (const marker of MARKERS[componentType]) {
          const markerLength = tokenize(marker).length;
          const joins: [string, string, number][] = [
            ["name+marker", `${model} ${marker}`, modelLength],
            ["marker+name", `${marker} ${model}`, markerLength],
          ];
          for (const [order, title, boundary] of joins) {
            const values = tokenValues(tokenize(title));
            for (const [set, phrase] of vocabulary) {
              for (const [from, to] of phraseSpans(values, tokenValues(tokenize(phrase)))) {
                // STRADDLES: starts before the join and ends after it.
                if (from < boundary && to > boundary) {
                  straddles.push(
                    `${componentType}: "${model}" ${order} "${marker}" spells ${set}:"${phrase}"`,
                  );
                }
              }
            }
          }
        }
      }
    }

    expect([...new Set(straddles)].sort()).toEqual([]);
  });

  /**
   * T33. THE CAP FAILS CLOSED. This title is LEGAL -- 146 characters, well inside the route's
   * 300-character bound -- and it carries a catalog model followed by a disqualifier that sits
   * beyond the 64th token. Under silent truncation the answer depended on which side of the cut
   * the disqualifier landed on; here it is `NEEDS_REVIEW / title-too-long` with a null key,
   * whatever was cut.
   */
  it("T33: a title at the token cap is NEEDS_REVIEW / title-too-long, never a model key", () => {
    const evasion = `GeForce RTX 5080 ${"a1 ".repeat(40)}gaming pc`;
    expect(evasion.length).toBeLessThanOrEqual(300);
    expect(tokenize(evasion)).toHaveLength(MAX_TOKENS);

    expect(normalizeListing({ title: evasion, priceCents: 250_000, componentType: "gpu" })).toEqual({
      modelKey: null,
      variantKey: null,
      validity: "NEEDS_REVIEW",
      reason: "title-too-long",
    });

    // THE HEADROOM, PINNED RATHER THAN ASSUMED: nothing real is near the cap, so the rule above
    // costs nothing that a shorter cap would not also cost.
    const longestCatalog = Math.max(
      ...WORKER_TYPES.flatMap((componentType) =>
        catalogModels(componentType).map((model) => tokenize(model).length),
      ),
    );
    expect(longestCatalog).toBe(11);
    expect(Math.max(...LIVE_TITLES.map((title) => tokenize(title).length))).toBe(18);
  });
});
