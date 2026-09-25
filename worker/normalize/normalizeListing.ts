/**
 * The classification rule: `(title, priceCents, componentType)` -> `{modelKey, variantKey,
 * validity, reason}`. Pure, deterministic and server-side. `./catalogIndex.ts` owns the tokens
 * and the model match; this file owns what a listing IS.
 *
 * IT RUNS IN THE WORKER, NOT THE COLLECTOR, and that is a security decision. A leaked
 * `COLLECTOR_TOKEN` can already choose a title; it must not be able to choose a `model_key`.
 * Collector-side, a leak would set `model_key` to ANY string and `validity` to `VALID`
 * directly, minting `model_stats` rows under keys no catalog model has. Worker-side the
 * attacker's levers reduce to `title` and `priceText`, which they already control.
 *
 * A WRONG MATCH IS WORSE THAN NO MATCH. `modelKey: null` is already handled downstream
 * (`skipped-no-model`, stored but never benchmarked); a mis-pooled model silently corrupts a
 * benchmark that nothing later corrects. Every tie in this file breaks towards refusing.
 */

import type { Listing, ObservationValidity } from "../storage/types";
import {
  MAX_TOKENS,
  MODEL_INDEXES,
  containsPhrase,
  matchCatalogModels,
  phraseSpans,
  tokenValues,
  tokenize,
  type Token,
} from "./catalogIndex";

/**
 * WHICH RULE FIRED. Deliberately NOT stored and NOT returned on the wire -- it exists so a test
 * can tell two rules apart: the CA$2,000 "RTX 4070 super gaming pc | Ryzen 5 7600 | ..." is
 * caught by rule 4 AND by rule 5, so a `validity`-only assertion passes with either one deleted.
 */
export type NormalizationReason =
  | "matched"
  | "model-unmatched"
  | "component-unconfirmed"
  | "multiple-models"
  | "wrong-component"
  | "mixed-components"
  | "whole-system"
  | "trade-only"
  | "not-working"
  | "wanted-ad"
  | "unknown-quantity"
  | "ambiguous-zero-price"
  | "title-too-long";

export interface Normalization {
  modelKey: string | null;
  variantKey: string | null;
  validity: ObservationValidity;
  reason: NormalizationReason;
}

/** A listing offering to BUY, not to sell. Its price is a wish, not a market reference. */
export const WANTED = ["wtb", "want to buy", "wanted", "looking for", "in search of", "iso"];

/** No money changes hands, so whatever number is attached is not a price. */
export const TRADE = ["for trade", "trade only", "trade for", "will trade", "swap", "trading"];

/** A broken unit is a real price for a DIFFERENT product than a working one. */
export const BROKEN = [
  "for parts",
  "parts only",
  "not working",
  "doesn't work",
  "broken",
  "damaged",
  "faulty",
  "cracked",
  "for repair",
  "as is",
];

/**
 * Whole systems named by BRAND or by a two-word phrase.
 *
 * `desktop` IS A PHRASE HERE AND NEVER A TOKEN, and that is a measurement about `desktop` ALONE:
 * as a bare token it fires on the catalog's own product wording -- `"AMD Ryzen 7 9800X3D Desktop
 * Processor"` and `"Kingston Fury Beast 32GB DDR4 desktop memory"` both become `whole-system`,
 * and `src/data/catalog.ts` literally describes cpu as "Desktop processors" and ram as "Desktop
 * memory kits". `laptop` and `notebook` carry no such collision and ARE tokens; see WHOLE_UNIT.
 *
 * THE BRAND LINES ARE THE SECOND DETECTOR FOR A MACHINE WITH NO WHOLE-UNIT WORD IN ITS TITLE --
 * `"Razer Blade 16 RTX 5080"` names no `pc`, no `laptop` and no system phrase otherwise.
 * MEASURED against all 176 catalog names and the 15 live titles; three candidates were REJECTED
 * on collisions and are named here so they are not "tidied" back in:
 *   `aorus`   -- 5 catalog motherboards (`Gigabyte X870E Aorus Master`, ...) AND Gigabyte's GPU
 *                line. A catalog collision: T11 goes red.
 *   `nitro`   -- `Sapphire Nitro+` is a mainstream AMD GPU board partner line. THE 0/176
 *                MEASUREMENT CANNOT SEE THIS: the catalog stores generic names (`Radeon RX 7800
 *                XT`) and holds no board-partner brands at all, so "0 collisions in the catalog"
 *                is a claim about the catalog, not about real listings.
 *   `predator` -- Acer sells Predator RAM and Predator NVMe drives, not only Predator machines.
 * The nine that ship are system-only product lines with no component line behind them.
 */
export const SYSTEM_PHRASES = [
  "thinkcentre",
  "thinkpad",
  "alienware",
  "optiplex",
  "elitedesk",
  "prodesk",
  "macbook",
  "imac",
  "nuc",
  "all in one",
  "workstation",
  "gaming desktop",
  "desktop pc",
  "desktop computer",
  "mini pc",
  "gaming laptop",
  "laptop computer",
  "razer blade",
  "legion",
  "omen",
  "victus",
  "zephyrus",
  "xps",
  "ideapad",
  "pavilion",
  "katana",
];

/**
 * Whole-unit TOKENS, neutralised when a marker phrase of the DECLARED type covers the position.
 * `"Lian Li Lancool 216 PC Case"` under a `case` search is a case, not a PC.
 *
 * `laptop` AND `notebook` ARE TOKENS HERE, AND THEY CLOSE A BLOCKING DEFECT. Without them a
 * whole machine that names no `pc`/`rig`/`build` contributed its whole price to a component's
 * benchmark: MEASURED, `"ASUS TUF Gaming A15 laptop RTX 4060"` at CA$1,200 wrote
 * `model_stats: GeForce RTX 4060 count=1 total=120000` -- the benchmark for a 4060 was a laptop.
 * The two-word `SYSTEM_PHRASES` entries could not catch it because they need adjacency.
 * MEASURED after adding them: 0 of 176 self-resolutions move, 0 of 1,408 cross-type pairs leak,
 * and no live listing changes its stored validity or model key.
 *
 * THE ONE COST, NAMED: `laptop` fires on the live `"Timetec 16GB DDR4 3200MHz SODIMM Laptop
 * RAM"`. Under a gpu search that listing was already refused, so nothing stored changes; declared
 * as `ram` it moves from `VALID`-with-no-key to `INVALID_REFERENCE`, because no `ram` marker
 * covers the word `laptop`. That is a lost reference, not a wrong one, and laptop memory is a
 * different product from the desktop kits this catalog lists.
 *
 * THE COST, STATED ABSOLUTELY RATHER THAN AS A DELTA. MEASURED over 24 realistic standalone
 * component titles, this table declines 3 a human would accept -- `"GeForce RTX 5060 - pulled
 * from my build"`, `"Seasonic Focus GX-850 PSU for desktop build"` and `"RTX 5080 graphics card
 * for gaming PC"` (the last was already refused by the phrase table this replaced). All three
 * are in the SAFE direction: a false positive costs a lost reference, never a wrong one.
 */
export const WHOLE_UNIT = new Set([
  "pc",
  "computer",
  "tower",
  "rig",
  "prebuilt",
  "build",
  "built",
  "setup",
  "battlestation",
  "machine",
  "system",
  "laptop",
  "notebook",
]);

/**
 * Phrases that state a multiplicity outright.
 *
 * `two`, `three` and `both` close the INFLATING direction of a blocking defect: MEASURED,
 * `"Two GeForce RTX 5080 cards"` at CA$4,000 was stored `VALID / GeForce RTX 5080`, which puts
 * twice the unit price into that model's benchmark and makes every genuine 5080 look like a
 * deal. MEASURED: 0 collisions across the 176 catalog names, the 15 live titles and every title
 * this suite asserts must stay matched.
 *
 * THREE CANDIDATES WERE REJECTED ON MEASURED COLLISIONS, named so they are not added later:
 *   `dual`  -- `ASUS Dual` is a real board-partner cooler line. It collides with three titles
 *              this suite pins as matches, T1 and T3 among them.
 *   `x 2`   -- as an anywhere-phrase it matches the catalog name `WD Black SN850X 2TB`.
 *   `x 3`   -- matches 8 X3D CPUs (`Ryzen 9 9950X3D`, ...).
 * The trailing form of `x N` ships instead, as `multiplierSuffix` below.
 */
export const MULTIPLE = ["lot of", "bundle", "pair of", "set of", "pcs", "pieces", "two", "three", "both"];

/**
 * Multiplicity TOKENS, checked UNCONDITIONALLY -- NOT through `hasUncovered`.
 *
 * "PC case" really is a case, but "FAN PACK" REALLY IS A PACK. An earlier draft routed `pack`
 * through the same marker-coverage neutralisation as WHOLE_UNIT, so the `case_fan` marker
 * `"fan pack"` suppressed it, and recorded that suppression as a defect fixed. It was a TRUE
 * POSITIVE BEING SUPPRESSED, on the one component type where Arctic, Noctua and Corsair all sell
 * primarily in 3- and 5-packs. MEASURED: `Arctic P12 Max fan pack`, `Arctic P12 PWM PST 5 Pack`,
 * `Noctua NF-A12x25 PWM 3-pack` and `Corsair iCUE LINK QX120 RGB triple pack` are all
 * `unknown-quantity` under this rule, while `Noctua NF-A12x25 PWM case fan` stays matched.
 * Cost: 0 of the 15 live titles.
 */
export const MULTI_UNIT = new Set(["pack"]);

/**
 * WHAT COUNTS AS EVIDENCE THAT THE ITEM IS FREE, as opposed to the word `free` appearing
 * somewhere in the title. Rule 8 used to test the bare token anywhere, so
 * `"GeForce RTX 5080 - free shipping"` at CA$0 was stored `VALID` WITH a catalog model key --
 * and `dealRules.decide` reads `VALID` plus a zero price under `MAXIMUM_PRICE` as
 * `DEAL / within-maximum`. That is the verdict PR #6 exists to prevent.
 *
 * The anchor is the ITEM: `free` leading the title, or a phrase that can only describe the item.
 * The leading token is refused when the next word is the thing being given away instead --
 * `"Free shipping on this GeForce RTX 5080"` is not a free graphics card.
 */
export const FREE_ITEM_PHRASES = ["free to a good home", "free item"];
export const FREE_IS_NOT_THE_ITEM = new Set(["shipping", "delivery", "postage"]);

const DIGITS = /^[0-9]+$/;
const LETTERS = /^[a-z]+$/;

/**
 * A LEADING multiplier: `"3x Arctic P14 Max case fans"` is three fans, not one.
 *
 * INDEX 0 ONLY, and that term is load-bearing. MEASURED: an `Nx`-anywhere form fires on
 * `"Ryzen 5 9600X processor"` and 5 other X-suffixed CPUs as soon as any word follows the model
 * name, on all four X-suffixed Corsair PSUs the same way (`RM850x`, `RM850x Shift`,
 * `RM1000x Shift`, `RM1200x Shift` -- T11 goes red naming `Corsair RM1200x Shift`), and on
 * `"MSI RTX 5080 Ventus 3X OC"`, a real cooler designation. Restricted to index 0 it moves 0 of
 * 176 catalog self-resolutions and 0 of the 15 live titles.
 *
 * THESE ARE NOT THE SAME COLLISIONS AS THE ONES THAT REJECTED `x 2` AND `x 3` AS `MULTIPLE`
 * PHRASES. Those are `WD Black SN850X 2TB` and the 8 X3D CPUs; these are the X-suffixed CPUs and
 * PSUs followed by a word. Quoting one list as evidence for the other is how that justification
 * went wrong once already.
 *
 * No `startsRun` term and no `endsRun` term: at index 0 a digit token always starts its run, and
 * because runs alternate letter and digit blocks a mid-run `x` is always followed by DIGITS,
 * which the LETTERS test already refuses. Both were measured unkillable and deleted, the same
 * discipline applied to the two guards deleted from catalogIndex.ts.
 */
export const multiplierPrefix = (tokens: readonly Token[]): boolean => {
  const [count, times, next] = tokens;
  return (
    count !== undefined &&
    DIGITS.test(count.value) &&
    times !== undefined &&
    times.value === "x" &&
    next !== undefined &&
    LETTERS.test(next.value)
  );
};

/**
 * What EVIDENCES each component type, beyond a catalog match. The nine-index scan below is what
 * catches a mixed bundle whose foreign part is a catalog model carrying no marker word
 * (`"RTX 5080 and Fractal North"`), and this table is what catches the reverse: a component the
 * catalog does not list at all.
 *
 * Bare `"cpu"` is deliberately absent -- see T13, the bidirectional vocabulary audit.
 */
/**
 * A TRAILING multiplier: `"GeForce RTX 5080 x2"` is two cards, not one.
 *
 * The last two tokens only. MEASURED: 0 collisions across the 176 catalog names, the 15 live
 * titles and every title this suite pins as a match -- no catalog name ENDS in `x` followed by
 * digits, because the capacity or generation always follows (`SN850X 2TB`, `NF-A12x25 PWM`).
 *
 * THE RESIDUAL, NAMED: a title TRUNCATED to exactly that shape does fire -- `"G.Skill Flare X5"`
 * and `"Noctua NF-A12x25"` with nothing after them. That is a lost reference, not a wrong one,
 * and it is the same direction every other tie in this file breaks.
 */
export const multiplierSuffix = (tokens: readonly Token[]): boolean => {
  const count = tokens[tokens.length - 1];
  const times = tokens[tokens.length - 2];
  return (
    count !== undefined &&
    DIGITS.test(count.value) &&
    times !== undefined &&
    times.value === "x"
  );
};

export const MARKERS: Record<Listing["componentType"], readonly string[]> = {
  cpu: [
    "processor",
    "ryzen",
    "threadripper",
    "xeon",
    "i 3",
    "i 5",
    "i 7",
    "i 9",
    "core ultra",
    "pentium",
    "athlon",
  ],
  cpu_cooler: ["cpu cooler", "heatsink", "aio cooler", "air cooler", "liquid cooler"],
  motherboard: ["motherboard", "mobo", "mainboard"],
  ram: ["ddr 3", "ddr 4", "ddr 5", "dimm", "sodimm", "memory kit"],
  storage: ["ssd", "hdd", "nvme", "hard drive", "m 2 drive", "solid state"],
  gpu: ["gpu", "graphics card", "video card", "rtx", "gtx", "geforce", "radeon"],
  psu: ["psu", "power supply"],
  case: ["pc case", "computer case", "tower case", "chassis"],
  case_fan: ["case fan", "case fans", "fan pack"],
};

const COMPONENT_TYPES = Object.keys(MARKERS) as Listing["componentType"][];

const containsAnyPhrase = (values: readonly string[], phrases: readonly string[]): boolean =>
  phrases.some((phrase) => containsPhrase(values, phrase));

/** The token positions consumed by a marker phrase of the DECLARED component type. */
const markerCoverage = (values: readonly string[], declared: Listing["componentType"]): Set<number> => {
  const covered = new Set<number>();
  for (const phrase of MARKERS[declared]) {
    for (const [from, to] of phraseSpans(values, tokenValues(tokenize(phrase)))) {
      for (let index = from; index < to; index += 1) covered.add(index);
    }
  }
  return covered;
};

/** True when a token of `vocabulary` appears at a position no declared-type marker covers. */
const hasUncovered = (
  values: readonly string[],
  declared: Listing["componentType"],
  vocabulary: ReadonlySet<string>,
): boolean => {
  const covered = markerCoverage(values, declared);
  return values.some((value, index) => vocabulary.has(value) && !covered.has(index));
};

/** True when the TITLE says the item itself is free -- not that the shipping is. */
export const freeItemEvidence = (values: readonly string[]): boolean =>
  (values[0] === "free" && !FREE_IS_NOT_THE_ITEM.has(values[1] ?? "")) ||
  containsAnyPhrase(values, FREE_ITEM_PHRASES);

export const systemEvidence = (
  values: readonly string[],
  declared: Listing["componentType"],
): boolean =>
  containsAnyPhrase(values, SYSTEM_PHRASES) || hasUncovered(values, declared, WHOLE_UNIT);

/**
 * `modelKey` and `variantKey` are NULL whenever validity is not VALID. Otherwise the trade-only
 * listing stores `model_key = 'Intel Arc B580'` for a card it is not selling, and
 * `model_key IS NOT NULL => validity = 'VALID'` -- asserted in the e2e by SQL -- stops being
 * true.
 */
const refuse = (validity: ObservationValidity, reason: NormalizationReason): Normalization => ({
  modelKey: null,
  variantKey: null,
  validity,
  reason,
});

/**
 * `variantKey` IS NULL FOR EVERY COMPONENT TYPE IN THIS SLICE, and that is a decision with a
 * named cost, not an omission. The catalog already encodes storage capacity, RAM capacity and
 * DDR generation, PSU wattage, CPU suffixes and GPU VRAM where it differentiates -- but it does
 * NOT encode RAM speed/timings or motherboard revisions: MEASURED, `Corsair Vengeance 32GB DDR5
 * 6000 CL30` and `... DDR5 5200 CL40`, roughly 30% apart in price, resolve to the SAME model
 * key and will be averaged together. A title-derived variant key can only FRAGMENT a pool, and
 * `MINIMUM_REFERENCE_COUNT = 5` means a fragmented pool produces NO estimate at all.
 * Fragmentation is the more expensive failure here.
 */
export const normalizeListing = (input: {
  title: string;
  priceCents: number | null;
  componentType: Listing["componentType"];
}): Normalization => {
  const declared = input.componentType;
  const tokens = tokenize(input.title);

  // RULE 0, AND IT RUNS FIRST. A title at exactly MAX_TOKENS may have been truncated, and every
  // one of the six disqualifier classes -- whole-system, foreign-component, multi-pack, wanted,
  // trade-only, not-working -- lives in the title text a truncation would discard. MEASURED: a
  // LEGAL 146-character title (`GeForce RTX 5080` + 40 two-token filler pairs + `gaming pc`)
  // tokenizes to exactly 64, and under silent truncation its `gaming pc` survived only by luck
  // -- one token further out and the same title would have returned a VALID model key for a
  // whole PC. A cap that bounds CPU by hiding evidence is worse than the cost it avoids.
  if (tokens.length === MAX_TOKENS) return refuse("NEEDS_REVIEW", "title-too-long");

  const values = tokenValues(tokens);
  const models = matchCatalogModels(MODEL_INDEXES[declared], tokens);
  const evidenced = COMPONENT_TYPES.filter(
    (type) =>
      containsAnyPhrase(values, MARKERS[type]) ||
      matchCatalogModels(MODEL_INDEXES[type], tokens).length > 0,
  );
  const foreign = evidenced.filter((type) => type !== declared);

  // 1-3: the price is not a price for this product at all.
  if (containsAnyPhrase(values, WANTED)) return refuse("INVALID_REFERENCE", "wanted-ad");
  if (containsAnyPhrase(values, TRADE)) return refuse("INVALID_REFERENCE", "trade-only");
  if (containsAnyPhrase(values, BROKEN)) return refuse("INVALID_REFERENCE", "not-working");

  // 4: THE DANGEROUS CASE. A CA$2,000 machine whose title names a real GPU must never enter that
  // GPU's average.
  if (systemEvidence(values, declared)) return refuse("INVALID_REFERENCE", "whole-system");

  // 5: a component of another type is evidenced. The MAJORITY case in the live data.
  if (foreign.length > 0) {
    return refuse(
      "INVALID_REFERENCE",
      evidenced.includes(declared) ? "mixed-components" : "wrong-component",
    );
  }

  // 6: two catalog models of the DECLARED type -- a bundle, and there is no way to say which
  // price belongs to which.
  if (models.length > 1) return refuse("INVALID_REFERENCE", "multiple-models");

  // 7: more than one unit, so the price is not a unit price. Quantity is handled by REFUSING TO
  // CONTRIBUTE rather than by a `quantity` column: `recordSightings` computes its aggregates with
  // an implicit q = 1, so a column nothing reads would be a lie in the schema.
  if (
    containsAnyPhrase(values, MULTIPLE) ||
    values.some((value) => MULTI_UNIT.has(value)) ||
    multiplierPrefix(tokens) ||
    multiplierSuffix(tokens)
  ) {
    return refuse("NEEDS_REVIEW", "unknown-quantity");
  }

  // 8: CA$0 with nothing saying the ITEM is free is a placeholder, not a price.
  //
  // MEASURED, because the two comments that used to describe this disagreed: `parsePriceText`
  // returns NULL for the word "Free" and ZERO for "CA$0" -- and Facebook renders a genuinely free
  // item as "CA$0", which is exactly why a real zero can reach this rule and why the exemption
  // below exists at all. The claim that an explicitly free listing never arrives here with 0 was
  // false; worker/api/priceText.ts had it right.
  if (input.priceCents === 0 && !freeItemEvidence(values)) {
    return refuse("NEEDS_REVIEW", "ambiguous-zero-price");
  }

  // 9: nothing says this is even the declared component. `"Selling My 4070 TI"` carries no
  // rtx/gtx/geforce/radeon token and matches no catalog name -- do not guess.
  if (models.length === 0 && !evidenced.includes(declared)) {
    return refuse("NEEDS_REVIEW", "component-unconfirmed");
  }

  // 10: a real, standalone, uncatalogued component. VALID with a null key: it is stored and
  // evaluated, and it cannot contribute to any benchmark. THIS IS NOT A COVERAGE METER -- see
  // docs/collector-ingest.md for the query that is.
  if (models.length === 0) {
    return { modelKey: null, variantKey: null, validity: "VALID", reason: "model-unmatched" };
  }

  // 11: exactly one catalog model of the declared type, and nothing above objected.
  return { modelKey: models[0], variantKey: null, validity: "VALID", reason: "matched" };
};
