// @vitest-environment node

/**
 * The index and its three guards, plus the three EXHAUSTIVE properties of the whole rule that
 * are properties of the catalog rather than of any one title. The exhaustive ones run through
 * `normalizeListing` deliberately: asserting them at the matcher alone would pass while a
 * classification rule threw every match away.
 *
 * READ THE GUARD-ABLATION TABLE BEFORE DELETING ANYTHING HERE. Measured over 5,808 generated
 * titles (176 names x (1 + 16 suffixes x 2 concatenation forms)), removing one guard and keeping
 * the rest changes: W 84 results, G1 5, B2 518, G2 1,580. T29 is the SOLE killer of G1 and T25
 * the SOLE killer of B2 -- T1 and T27 are each covered by two guards and discriminate neither,
 * so deleting T25 or T29 as "redundant with T1" leaves a guard with no test at all.
 */

import { componentCatalog } from "../../src/data/catalog";
import type { Listing } from "../storage/types";
import { CATALOG_COMPONENT_ID, MAX_TOKENS, MODEL_INDEXES, matchCatalogModels, tokenize } from "./catalogIndex";
import { normalizeListing } from "./normalizeListing";

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
    // NFKD hazard the tokenizer's comment describes is killed by T15, not here.
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
 * caught only where it breaks T11's 176 self-resolutions or T13's overlap audit.
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
    const leading: Record<string, number> = { geforce: 0, nvidia: 0, radeon: 0, amd: 0, intel: 0 };
    for (const componentType of WORKER_TYPES) {
      for (const model of catalogModels(componentType)) {
        const first = tokenize(model)[0].value;
        if (first in leading) leading[first] += 1;
      }
    }
    expect(leading).toEqual({ geforce: 13, nvidia: 0, radeon: 7, amd: 0, intel: 3 });

    expect(match("gpu", "RTX 5080 graphics card")).toBe("GeForce RTX 5080");
    expect(match("gpu", "RX 7800 XT graphics card")).toBe("Radeon RX 7800 XT");
    // The one the whole sweep exists for: an Arc listing that omits the word "Intel".
    expect(match("gpu", "Arc B580 graphics card")).toBe("Intel Arc B580");
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

  it("T20 control: an unlisted trailing word does NOT refuse the match", () => {
    expect(match("gpu", "GeForce RTX 5080 oc")).toBe("GeForce RTX 5080");
  });
});

describe("catalog index -- exhaustive properties", () => {
  /**
   * T11. The ANCHOR of the whole suite: a normalizer that always returns null fails 176 times
   * here. The two counts are asserted FIRST so an empty or failed catalog import cannot pass
   * this vacuously.
   */
  it("T11: all 176 catalog names, declared as their own type, resolve to themselves", () => {
    const names = WORKER_TYPES.flatMap((componentType) =>
      catalogModels(componentType).map((model) => [componentType, model] as const),
    );
    expect(names).toHaveLength(176);
    expect(catalogModels("gpu")).toHaveLength(23);

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
  it("T12: none of the 1,408 cross-type pairs produces a VALID result with a model", () => {
    const pairs = WORKER_TYPES.flatMap((componentType) =>
      catalogModels(componentType).flatMap((model) =>
        WORKER_TYPES.filter((other) => other !== componentType).map(
          (declared) => [declared, model] as const,
        ),
      ),
    );
    expect(pairs).toHaveLength(1_408);

    const leaks = pairs.filter(([declared, model]) => {
      const result = normalizeListing({ title: model, priceCents: 6300, componentType: declared });
      return result.validity === "VALID" && result.modelKey !== null;
    });
    expect(leaks.map(([declared, model]) => `${declared} <- ${model}`)).toEqual([]);
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
