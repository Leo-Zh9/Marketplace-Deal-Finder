/**
 * The classification rule: `(title, priceCents, componentType)` -> `{componentType, modelKey,
 * variantKey, validity, reason}`, where the returned type is the one the title proves when it
 * proves exactly one, and the search's otherwise. Pure, deterministic and server-side.
 * `./catalogIndex.ts` owns the tokens and the model match; this file owns what a listing IS.
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
  matchCatalogSpans,
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
  | "title-too-long"
  | "accessory";

export interface Normalization {
  /**
   * THE TYPE THE LISTING IS CLASSIFIED AND STORED UNDER, which is not always the type of the
   * search that found it. See `resolveComponentType`.
   */
  componentType: Listing["componentType"];
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
 * THE `desktop <component>` RETAIL PHRASING IS A NAMED RESIDUAL, AND IT IS NOT THE TRAILING
 * RULE'S DOING -- it arrived with the `desktop` admission itself. `desktop` is a whole-unit token
 * on all NINE types while the neutralising markers exist only on `cpu` and `ram`, so ordinary
 * retail phrasing is refused on the other seven: MEASURED,
 * `"GeForce RTX 5080 desktop graphics card"`, `"Corsair RM850x desktop power supply"`,
 * `"Samsung 990 Pro 2TB desktop SSD"`, and the same shape on case, case_fan, cpu_cooler and
 * motherboard. `"desktop graphics card"` is how retail distinguishes a desktop GPU from a laptop
 * one. Lost references, never wrong ones; `STANDALONE_COMPONENTS` now carries three of them so
 * the cost figure can see the family at all.
 *
 * IT IS CHEAP AND SAFE TO CLOSE, AND MEASURED SO RATHER THAN ASSUMED: adding
 * `"desktop graphics card"` to `MARKERS.gpu` recovers `"GeForce RTX 5080 desktop graphics card"`
 * as a match while `"Dell Desktop | Graphics card: RTX 5080"` STAYS refused, because the trailing
 * rule above protects any future `desktop *` marker globally. The price per type is one marker
 * phrase plus the T13 overlap rows it creates. NOT DONE HERE: that is seven types' worth of new
 * vocabulary arriving at merge time, and this slice has learned what new vocabulary costs.
 *
 * `desktop` IS NOW A TOKEN TOO, and the argument that kept it out was true of the BARE token and
 * stopped being true the moment the marker mechanism could cover it. It used to fire on the
 * catalog's own product wording -- `"AMD Ryzen 7 9800X3D Desktop Processor"` and `"Kingston Fury
 * Beast 32GB DDR4 desktop memory"` -- so `MARKERS.cpu` gained `desktop processor` and
 * `MARKERS.ram` gained `desktop memory`, and those two phrases COVER the word exactly as
 * `pc case` already covers `pc`. Both titles now resolve to their catalog models, and
 * `"Dell Desktop GeForce RTX 4060"` -- a CA$1,100 prebuilt that was writing itself into the
 * 4060 benchmark -- is refused.
 *
 * THE BRAND LINES ARE THE SECOND DETECTOR FOR A MACHINE WITH NO WHOLE-UNIT WORD IN ITS TITLE --
 * `"Razer Blade 16 RTX 5080"` names no `pc`, no `laptop` and no system phrase otherwise.
 * MEASURED against all 336 catalog names and the 15 live titles; three candidates were REJECTED
 * on collisions and are named here so they are not "tidied" back in:
 *   `aorus`   -- 8 catalog motherboards (`Gigabyte X870E Aorus Master`, ...) AND Gigabyte's GPU
 *                line. A catalog collision: T11 goes red.
 *   `nitro`   -- `Sapphire Nitro+` is a mainstream AMD GPU board partner line. THE 0/336
 *                MEASUREMENT CANNOT SEE THIS: the catalog stores generic names (`Radeon RX 7800
 *                XT`) and holds no board-partner brands at all, so "0 collisions in the catalog"
 *                is a claim about the catalog, not about real listings.
 *   `predator` -- Acer sells Predator RAM and Predator NVMe drives, not only Predator machines.
 *   `katana`  -- `Scythe Katana` is a mainstream tower CPU cooler line. It was ADMITTED in the
 *                first pass and caught on re-review; it fails the same test that rejected
 *                `nitro`, and the corpus that should have caught it held a title for every
 *                REJECTED word and none for any ACCEPTED one, so it could only ever confirm
 *                refusals. `BOARD_PARTNER_TITLES` now carries a row per accepted word too.
 * The eight that ship are system-only product lines with no component line behind them.
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
 * MEASURED WHEN THEY WERE ADDED, against the 176-name catalog as of PR #14 -- scoped rather
 * than re-numbered, because "0 move" is a before/after ablation that cannot be re-run now: 0 of
 * 176 self-resolutions moved, 0 of 1,408 cross-type pairs leaked, and no live listing changed
 * its stored validity or model key.
 *
 * WHAT GOES RED IF A TOKEN LEAVES THIS SET, MEASURED ONE AT A TIME: T21c (the per-element sweep,
 * which carries its own literal copy), a named row in CASES (F1a `laptop`, F1b `notebook`, T9c
 * `build`, T9d `tower`, R2a `desktop`), and F5b over WHOLE_MACHINES. T11 and T12 do NOT -- they
 * prove only that no catalog name is shadowed and none is cross-listed, and both stay green with
 * every guard in catalogIndex.ts deleted.
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
  "desktop",
]);

/**
 * Phrases that state a multiplicity outright.
 *
 * `two`, `three` and `both` close the INFLATING direction of a blocking defect: MEASURED,
 * `"Two GeForce RTX 5080 cards"` at CA$4,000 was stored `VALID / GeForce RTX 5080`, which puts
 * twice the unit price into that model's benchmark and makes every genuine 5080 look like a
 * deal. MEASURED: 0 collisions across the 336 catalog names, the 15 live titles and every title
 * this suite asserts must stay matched.
 *
 * THE COST, STATED RATHER THAN OMITTED. These words decline real standalone listings, and the
 * comment here used to claim no cost at all while the WHOLE_UNIT table above stated its own
 * honestly. MEASURED, and now carried in `STANDALONE_COMPONENTS`: age phrasing
 * (`"GeForce RTX 5080, two months old"`), compatibility copy
 * (`"Noctua NH-D15 fits both AM4 and AM5"`) and a kit written the trailing way round
 * (`"Corsair Vengeance 32GB 2x16"`, which PLAN.md:54 calls ONE kit) are all refused as
 * `unknown-quantity`. Lost references, never wrong ones -- but a vocabulary whose comment claims
 * no cost is how a cost stops being counted.
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
 * THINGS SOLD FOR A COMPONENT RATHER THAN AS ONE, consulted ONLY when the type resolution would
 * move a listing away from the search's type -- see `accessoryEvidence`.
 *
 * WHY IT EXISTS. An accessory search returns accessories that NAME the part they fit:
 * `"12VHPWR cable for RTX 4090"` under a psu search evidences one type (gpu) with a catalog
 * model, so the resolution would store a CA$40 cable as a VALID GeForce RTX 4090 reference --
 * pulling that model's mean down until the cable itself read as a DEAL. MEASURED on review:
 * a cable, a waterblock, a mounting bracket, a replacement fan, a riser mount, thermal pads and a
 * backplate, each from the matching accessory search, all resolved VALID with a model.
 *
 * SCOPED TO THE CROSS-TYPE CASE ON PURPOSE. Applied under every type it would refuse ordinary
 * same-type copy -- a PSU "with all cables", a card "with support bracket". THE SAME-TYPE HOLE IS
 * PRE-EXISTING AND STAYS, NAMED: `"GPU support bracket RTX 4090"` under a gpu search is still a
 * VALID RTX 4090 (pinned in ACCEPTED_EXPOSURE), for the corpus work that follows.
 *
 * NO BARE `for`: `"for sale"` is everywhere. The `X for <model>` shape is caught positionally
 * instead -- `for` immediately before a matched catalog model -- in `accessoryEvidence`.
 *
 * THE SECOND ROUND OF WORDS (`fan`, `fans`, `replacement`, `box`, `holder`, `stand`, `support`)
 * came from review: `"RTX 3080 FE fan replacement"` from a case-fan search, `"RTX 4090 box only"`
 * from a psu search and `"RTX 4090 vertical GPU holder"` from a case search all resolved VALID
 * with a model. THE TRADE IS DELIBERATE: this list runs only on a cross-type resolution, where a
 * false refusal costs a NEEDS_REVIEW (a lost reference) and a missed accessory writes a wrong
 * price. `empty box` and the earlier `fan for` are NOT listed because `box` and `fan` cover them,
 * and a phrase no mutation can kill is deleted here, not kept.
 */
export const ACCESSORY = [
  "cable",
  "cables",
  "adapter",
  "bracket",
  "waterblock",
  "water block",
  "backplate",
  "riser",
  "mount",
  "mounting",
  "shroud",
  "thermal pad",
  "thermal pads",
  "fan",
  "fans",
  "replacement",
  "box",
  "holder",
  "stand",
  "support",
];

/**
 * ACCESSORY WORDS THAT ARE THE PRODUCT ITSELF for one type: a case fan IS a fan. Without this a
 * real fan found by another type's search could never move to case_fan -- and five catalog names
 * carry the word (`Lian Li UNI FAN SL120 V2`, ...), so T12 goes red, 40 cross-type pairs short.
 */
const ACCESSORY_OWN_WORDS: Partial<Record<Listing["componentType"], readonly string[]>> = {
  case_fan: ["fan", "fans"],
};

const DIGITS = /^[0-9]+$/;
const LETTERS = /^[a-z]+$/;

/**
 * A LEADING multiplier: `"3x Arctic P14 Max case fans"` is three fans, not one.
 *
 * INDEX 0 OR 1, because one verb before the quantity is this marketplace's house style rather
 * than a constructed shape: `"Selling My 4070 TI"` is one of the 15 real listings, and
 * `"Selling 2x GeForce RTX 5080"` at CA$4,000 was storing twice the unit price as one 5080's
 * price -- the INFLATING direction. MEASURED at index <= 1: 0 of the 336 catalog names trips the
 * predicate; T12's 2,688 cross-type pairs, the 15 live titles and all seven committed corpora
 * stay green, which is the same claim re-checked on every run rather than a one-off sweep.
 *
 * THE RESIDUAL THE SECOND INDEX DOES NOT REACH, NAMED: two words before the quantity
 * (`"Selling my 2x RTX 5080"`) is still uncaught, and is pinned in ACCEPTED_EXPOSURE.
 *
 * AND THE COST OF THE SECOND INDEX, WHICH THE FIRST VERSION OF THIS COMMENT DID NOT STATE.
 * "every collision sits at index 2 or beyond" is measured over catalog names AND their
 * vendor-stripped forms, with and without a trailing word -- 20 triples, all at index exactly 2,
 * 0 at index <= 1. It is NOT true of a title that names only the bare SKU: `"9600X processor"`
 * puts the triple at index 0 (a pre-existing cost of the leading form) and `"AMD 9600X
 * processor"` or `"Corsair 850x power supply"` put it at index 1 (the cost this bound adds).
 * Each of those is refused as `unknown-quantity` where it would otherwise have been a usable
 * reference with a null key. `STANDALONE_COMPONENTS` carries one.
 *
 * THE BOUND IS WHAT IS LOAD-BEARING, AND THE CATALOG SLICE MADE IT MORE SO. MEASURED: an
 * `Nx`-anywhere form fires on `"Ryzen 5 9600X processor"` and 14 other X-suffixed CPUs as soon
 * as any word follows the model name -- it was 5 others before the catalog grew to 336 -- on all
 * EIGHT X-suffixed Corsair PSUs the same way (`RM650x`, `RM750x`, `RM750x Shift`, `RM850x`,
 * `RM850x Shift`, `RM1000x`, `RM1000x Shift`, `RM1200x Shift` -- T11 goes red naming
 * `Corsair RM1200x Shift`), and on
 * `"MSI RTX 5080 Ventus 3X OC"`, a real cooler designation. Every one of those triples sits at
 * index 2 or beyond, which is exactly why the bound stops at 1 and why widening it further is
 * not free.
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
export const MULTIPLIER_MAX_START = 1;

export const multiplierPrefix = (tokens: readonly Token[]): boolean => {
  for (let start = 0; start <= MULTIPLIER_MAX_START; start += 1) {
    const count = tokens[start];
    const times = tokens[start + 1];
    const next = tokens[start + 2];
    if (
      count !== undefined &&
      DIGITS.test(count.value) &&
      times !== undefined &&
      times.value === "x" &&
      next !== undefined &&
      LETTERS.test(next.value)
    ) {
      return true;
    }
  }
  return false;
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
 * The last two tokens only. MEASURED: 0 collisions across the 336 catalog names, the 15 live
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
    // Covers the whole-unit token `desktop` for a cpu listing; see WHOLE_UNIT.
    "desktop processor",
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
  // `desktop memory` covers the whole-unit token `desktop` for a ram listing; see WHOLE_UNIT.
  ram: ["ddr 3", "ddr 4", "ddr 5", "dimm", "sodimm", "memory kit", "desktop memory"],
  storage: ["ssd", "hdd", "nvme", "hard drive", "m 2 drive", "solid state"],
  gpu: ["gpu", "graphics card", "video card", "rtx", "gtx", "geforce", "radeon"],
  psu: ["psu", "power supply"],
  case: ["pc case", "computer case", "tower case", "chassis"],
  case_fan: ["case fan", "case fans", "fan pack"],
};

const COMPONENT_TYPES = Object.keys(MARKERS) as Listing["componentType"][];

const containsAnyPhrase = (values: readonly string[], phrases: readonly string[]): boolean =>
  phrases.some((phrase) => containsPhrase(values, phrase));

/**
 * Tokens whose marker coverage must TRAIL the model name rather than lead it.
 *
 * WHY THIS EXISTS, AND WHY IT HOLDS EXACTLY ONE WORD. Retail box wording follows the product --
 * `"Ryzen 7 9800X3D Desktop Processor"` -- while a prebuilt's spec list leads with the machine
 * and then lists what is inside it. Punctuation is stripped before matching, so
 * `"Dell Desktop | Processor: Core i9-14900K | 32GB | 1TB"` tokenizes `desktop` and `processor`
 * ADJACENT: the `desktop processor` marker matched at the front of the title and neutralised the
 * very token that says the listing is a whole machine. MEASURED: that title was stored
 * `VALID / Core i9-14900K` at CA$1,500, so a whole prebuilt became the i9-14900K benchmark --
 * roughly 2x the real price, in the inflating direction. The same shape reached RAM, and
 * pipe-delimited spec lists are the live data's own house style: 2 of the 15 production listings
 * are one, surviving today only because they happen to carry a `pc` token as well.
 *
 * SCOPED TO `desktop` DELIBERATELY. The general rule -- "a marker only neutralises what follows a
 * matched model" -- regresses `"PC Case - Fractal North"`, where `pc case` leads and the model
 * span follows it, which is ordinary case phrasing rather than a spec list. `pc`, `computer` and
 * `tower` keep their position-free neutralisation.
 *
 * THE COST, NAMED, AND IT HAS TWO HALVES. Word order is the only signal available, so any title
 * that LEADS with the retail category is refused -- including one naming a catalogued model:
 *   `"AMD Ryzen 5 4500 Desktop Processor"`         (uncatalogued: no span for the marker to trail)
 *   `"Desktop Processor Core i9-14900K"`           (CATALOGUED, but the category leads)
 *   `"Desktop Memory Corsair Vengeance 32GB DDR5"` (the same on ram)
 * The second half is inherent rather than incidental: `"Desktop Processor: Core i9-14900K"` is
 * token-identical in shape to `"Desktop | Processor: Core i9-14900K"`, which is the prebuilt this
 * rule exists to refuse. Both halves are lost references, never wrong ones, which is the
 * direction every tie in this file breaks.
 */
const COVERED_ONLY_WHEN_TRAILING = new Set(["desktop"]);

/** The token positions consumed by a marker phrase of the DECLARED component type. */
const markerCoverage = (
  values: readonly string[],
  tokens: readonly Token[],
  declared: Listing["componentType"],
): Set<number> => {
  const covered = new Set<number>();
  const modelSpans = matchCatalogSpans(MODEL_INDEXES[declared], tokens);
  for (const phrase of MARKERS[declared]) {
    for (const [from, to] of phraseSpans(values, tokenValues(tokenize(phrase)))) {
      const trailsAModel = modelSpans.some((span) => from >= span.end);
      for (let index = from; index < to; index += 1) {
        if (COVERED_ONLY_WHEN_TRAILING.has(values[index]) && !trailsAModel) continue;
        covered.add(index);
      }
    }
  }
  return covered;
};

/** True when a token of `vocabulary` appears at a position no declared-type marker covers. */
const hasUncovered = (
  values: readonly string[],
  tokens: readonly Token[],
  declared: Listing["componentType"],
  vocabulary: ReadonlySet<string>,
): boolean => {
  const covered = markerCoverage(values, tokens, declared);
  return values.some((value, index) => vocabulary.has(value) && !covered.has(index));
};

/**
 * ONLY WHOLE_UNIT IS NEUTRALISED BY A MARKER. This is the only place `hasUncovered` is called;
 * SYSTEM_PHRASES here, and MULTIPLE / MULTI_UNIT / both multiplier predicates in rule 7, are
 * checked UNCONDITIONALLY -- ruling 2 makes that deliberate for MULTI_UNIT, because a fan pack
 * really is a pack even under a `case_fan` search.
 *
 * THE GENERAL ANSWER TO "WHICH OTHER EXCLUDED WORDS COULD A MARKER NOW ADMIT": none of them.
 * `desktop` was admitted once `desktop processor` and `desktop memory` could cover it, and it is
 * the only excluded word that belonged in WHOLE_UNIT in the first place. MEASURED over the other
 * seven -- `dual`, `x 2`, `x 3` (MULTIPLE) and `aorus`, `nitro`, `predator`, `katana`
 * (SYSTEM_PHRASES) -- on two independent grounds: none sits in a marker-neutralised vocabulary,
 * and no marker phrase contains any of them, so there would be nothing to cover them with even
 * if the mechanism were extended. Their collisions are with catalog MODEL NAMES and with
 * component product lines, which a marker cannot dissolve by construction.
 */
/**
 * WHAT COUNTS AS EVIDENCE THAT THE ITEM ITSELF IS FREE, as opposed to the shipping, the pickup
 * or something bundled with it. Rule 8 used to test the bare token anywhere, so
 * `"GeForce RTX 5080 - free shipping"` at CA$0 was stored `VALID` WITH a catalog model key --
 * and `dealRules.decide` reads `VALID` plus a zero price under `MAXIMUM_PRICE` as
 * `DEAL / within-maximum`. That is the verdict PR #6 exists to prevent.
 *
 * THIS IS A QUALIFIER, NOT A DENYLIST, AND THAT IS THE WHOLE POINT. `free` must LEAD the title
 * and the very next token must belong to the ITEM -- covered by a marker phrase of the declared
 * type, or inside a matched catalog model's span. A denylist of the other thing was tried and
 * REPLACED: it needed patching twice inside one review round (`pickup`, then `pick`, because the
 * tokenizer splits `pick up` in two), and a token denylist cannot tell `"free ... pick up only"`
 * -- a free graphics card collected in person -- from `"free pick up"`. Enumerating a
 * natural-language family is instance-shaped by construction; asking what the word `free` is
 * attached to is not, and it needs no list to maintain.
 *
 * THE DIRECTION OF ITS MISTAKES IS THE SAFE ONE. A free listing cannot reach a benchmark at all
 * -- `recordSightings` requires `priceCents > 0` -- so the only thing `VALID`-at-zero buys is a
 * `DEAL` verdict. Refusing a zero-price phrasing costs no reference and removes a spurious deal.
 *
 * THE NAMED COST, BOTH HALVES: a genuinely free item phrased tail-first
 * (`"GeForce RTX 5080, free to a good home"`) and one whose title puts anything between `free`
 * and the item (`"Free to a good home GeForce RTX 5080"`) are both `NEEDS_REVIEW`.
 */
export const freeItemEvidence = (
  values: readonly string[],
  tokens: readonly Token[],
  declared: Listing["componentType"],
): boolean => {
  if (values[0] !== "free") return false;
  if (markerCoverage(values, tokens, declared).has(1)) return true;
  return matchCatalogSpans(MODEL_INDEXES[declared], tokens).some(
    (span) => span.start <= 1 && 1 < span.end,
  );
};

/**
 * True when the title reads as something sold FOR a `type` part: an ACCESSORY phrase, or `for`
 * directly before a matched catalog model of that type (`"... for RTX 4090"`,
 * `"... for Ryzen 5 5600X"`). Called only for a resolution that would change the type.
 */
export const accessoryEvidence = (
  values: readonly string[],
  tokens: readonly Token[],
  type: Listing["componentType"],
): boolean =>
  containsAnyPhrase(
    values,
    ACCESSORY.filter((phrase) => !(ACCESSORY_OWN_WORDS[type] ?? []).includes(phrase)),
  ) ||
  matchCatalogSpans(MODEL_INDEXES[type], tokens).some(
    (span) => span.start > 0 && values[span.start - 1] === "for",
  );

export const systemEvidence = (
  values: readonly string[],
  tokens: readonly Token[],
  declared: Listing["componentType"],
): boolean =>
  containsAnyPhrase(values, SYSTEM_PHRASES) || hasUncovered(values, tokens, declared, WHOLE_UNIT);

/**
 * `modelKey` and `variantKey` are NULL whenever validity is not VALID. Otherwise the trade-only
 * listing stores `model_key = 'Intel Arc B580'` for a card it is not selling, and
 * `model_key IS NOT NULL => validity = 'VALID'` -- asserted in the e2e by SQL -- stops being
 * true.
 */
const refuse = (
  componentType: Listing["componentType"],
  validity: ObservationValidity,
  reason: NormalizationReason,
): Normalization => ({
  componentType,
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
  const tokens = tokenize(input.title);

  // RULE 0, AND IT RUNS FIRST. A title at exactly MAX_TOKENS may have been truncated, and every
  // one of the six disqualifier classes -- whole-system, foreign-component, multi-pack, wanted,
  // trade-only, not-working -- lives in the title text a truncation would discard. MEASURED: a
  // LEGAL 146-character title (`GeForce RTX 5080` + 40 two-token filler pairs + `gaming pc`)
  // tokenizes to exactly 64, and under silent truncation its `gaming pc` survived only by luck
  // -- one token further out and the same title would have returned a VALID model key for a
  // whole PC. A cap that bounds CPU by hiding evidence is worse than the cost it avoids.
  if (tokens.length === MAX_TOKENS) {
    return refuse(input.componentType, "NEEDS_REVIEW", "title-too-long");
  }

  const values = tokenValues(tokens);
  // One walk per index, shared by the evidence scan, the resolution and rules 6/9-11. (Rule 4's
  // marker coverage and rule 8 still walk the resolved type's spans themselves, as before.)
  const modelsByType = {} as Record<Listing["componentType"], string[]>;
  for (const type of COMPONENT_TYPES) {
    modelsByType[type] = matchCatalogModels(MODEL_INDEXES[type], tokens);
  }
  const evidenced = COMPONENT_TYPES.filter(
    (type) => containsAnyPhrase(values, MARKERS[type]) || modelsByType[type].length > 0,
  );

  // THE TYPE COMES FROM THE TITLE WHEN THE TITLE PROVES IT, AND FROM THE SEARCH OTHERWISE.
  //
  // `listings` is keyed `(source, listing_id)` with ONE `component_type`, and Facebook returns the
  // same listing to searches of different types. Classified under the search's type, a
  // model-matched listing flipped every run -- VALID under its own search, INVALID
  // `wrong-component` under the other -- and each flip removed its price contribution and the
  // next restored it. MEASURED in production (October): 167 `removed` and 170 `restored` events
  // against 38 `recorded`, every one of them a model-matched cross-type flip.
  //
  // THE RULE: exactly ONE type is evidenced and that type has a catalog model match. Both clauses
  // are load-bearing. Without the model clause a single marker word retypes a listing: `ryzen`,
  // `ssd` and `rtx` are one-word evidence, a marker-only listing carries no key and so no
  // contribution for a retype to protect, and the live `"Microsoft Surface Pro ... 512GB SSD"`
  // would become a VALID storage row (TR-m4). Without EXACTLY-one, a title naming catalogued
  // parts of two types (`"Ryzen 7 9800X3D / RTX 5080 16GB"`) would be stored under whichever type
  // COMPONENT_TYPES lists first instead of being refused under the search's type (TR-2).
  //
  // THERE IS NO "the declared type is not evidenced" CLAUSE, and adding one changes nothing:
  // when exactly one type is evidenced and it is the declared type, resolving to it IS the
  // declared type. It would be an equivalent mutant, and this file deletes guards no mutation
  // can kill.
  //
  // THE RESIDUAL, NAMED: a cross-type title evidenced by a MARKER only still flips between
  // VALID-no-key and INVALID across searches. It never touches an aggregate (no key), but its
  // verdict goes stale. See docs/collector-ingest.md.
  //
  // AN ACCESSORY IS NOT MOVED. A title that proves one type but reads as something sold FOR that
  // type (`"12VHPWR cable for RTX 4090"` from a psu search) keeps the search's type and is refused
  // as `accessory` after rules 1-3. Without this the resolution turned accessories from accessory
  // searches into VALID references for the part they fit. See ACCESSORY for why it is cross-type
  // only.
  //
  // FROM HERE ON `declared` IS THE RESOLVED TYPE; every rule below that says "declared" means it.
  const [only] = evidenced;
  const proven: Listing["componentType"] =
    evidenced.length === 1 && modelsByType[only].length > 0 ? only : input.componentType;
  const accessory = proven !== input.componentType && accessoryEvidence(values, tokens, proven);
  const declared = accessory ? input.componentType : proven;
  const models = modelsByType[declared];
  const foreign = evidenced.filter((type) => type !== declared);
  const refuseAs = (validity: ObservationValidity, reason: NormalizationReason): Normalization =>
    refuse(declared, validity, reason);

  // 1-3: the price is not a price for this product at all.
  if (containsAnyPhrase(values, WANTED)) return refuseAs("INVALID_REFERENCE", "wanted-ad");
  if (containsAnyPhrase(values, TRADE)) return refuseAs("INVALID_REFERENCE", "trade-only");
  if (containsAnyPhrase(values, BROKEN)) return refuseAs("INVALID_REFERENCE", "not-working");

  // 3b: an accessory for a part of ANOTHER type than the search's. NEEDS_REVIEW, not
  // INVALID_REFERENCE: the title says what it fits, not that it is the wrong thing.
  if (accessory) return refuseAs("NEEDS_REVIEW", "accessory");

  // 4: THE DANGEROUS CASE. A CA$2,000 machine whose title names a real GPU must never enter that
  // GPU's average.
  if (systemEvidence(values, tokens, declared)) {
    return refuseAs("INVALID_REFERENCE", "whole-system");
  }

  // 5: a component of another type is evidenced. The MAJORITY case in the live data.
  if (foreign.length > 0) {
    return refuseAs(
      "INVALID_REFERENCE",
      evidenced.includes(declared) ? "mixed-components" : "wrong-component",
    );
  }

  // 6: two catalog models of the DECLARED type -- a bundle, and there is no way to say which
  // price belongs to which.
  if (models.length > 1) return refuseAs("INVALID_REFERENCE", "multiple-models");

  // 7: more than one unit, so the price is not a unit price. Quantity is handled by REFUSING TO
  // CONTRIBUTE rather than by a `quantity` column: `recordSightings` computes its aggregates with
  // an implicit q = 1, so a column nothing reads would be a lie in the schema.
  if (
    containsAnyPhrase(values, MULTIPLE) ||
    values.some((value) => MULTI_UNIT.has(value)) ||
    multiplierPrefix(tokens) ||
    multiplierSuffix(tokens)
  ) {
    return refuseAs("NEEDS_REVIEW", "unknown-quantity");
  }

  // 8: CA$0 with nothing saying the ITEM is free is a placeholder, not a price. See
  // `freeItemEvidence`: the word must LEAD and must be attached to the item, not to the postage.
  //
  // MEASURED, because the two comments that used to describe this disagreed: `parsePriceText`
  // returns NULL for the word "Free" and ZERO for "CA$0" -- and Facebook renders a genuinely free
  // item as "CA$0", which is exactly why a real zero can reach this rule and why the exemption
  // below exists at all. The claim that an explicitly free listing never arrives here with 0 was
  // false; worker/api/priceText.ts had it right.
  if (input.priceCents === 0 && !freeItemEvidence(values, tokens, declared)) {
    return refuseAs("NEEDS_REVIEW", "ambiguous-zero-price");
  }

  // 9: nothing says this is even the declared component. `"Selling My 4070 TI"` carries no
  // rtx/gtx/geforce/radeon token and matches no catalog name -- do not guess.
  if (models.length === 0 && !evidenced.includes(declared)) {
    return refuseAs("NEEDS_REVIEW", "component-unconfirmed");
  }

  // 10: a real, standalone, uncatalogued component. VALID with a null key: it is stored and
  // evaluated, and it cannot contribute to any benchmark. THIS IS NOT A COVERAGE METER -- see
  // docs/collector-ingest.md for the query that is.
  if (models.length === 0) {
    return {
      componentType: declared,
      modelKey: null,
      variantKey: null,
      validity: "VALID",
      reason: "model-unmatched",
    };
  }

  // 11: exactly one catalog model of the declared type, and nothing above objected.
  return {
    componentType: declared,
    modelKey: models[0],
    variantKey: null,
    validity: "VALID",
    reason: "matched",
  };
};
