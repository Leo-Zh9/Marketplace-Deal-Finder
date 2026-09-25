/**
 * The token layer and the per-component-type model index: everything that turns a title into one
 * of the 336 names in `src/data/catalog.ts`. The classification rules live next door in
 * `./normalizeListing.ts`; nothing in this file knows what `validity` is.
 *
 * WHY A TOKEN TRIE AND NOT SUBSTRING MATCHING. Lower-cased and stripped of punctuation,
 * `"4070 Ti"` is a substring of `"GeForce RTX 4070 Ti Super"` and `"RTX 5060"` is a substring of
 * both `"RTX 5060 Ti 16GB"` and `"RTX 5060 Ti 8GB"` -- so a substring rule pools a 4070 Ti
 * listing with 4070 Ti SUPER prices. `model_stats` is an UNTRIMMED running mean with no outlier
 * filter anywhere in the Worker, so one mis-pooled row moves a benchmark and nothing later
 * dilutes it. A shorter model name must never silently match a longer one, which is what the
 * three guards in `matchCatalogModels` are for.
 */

import { componentCatalog } from "../../src/data/catalog";
import type { ComponentType } from "../../src/types";
import type { Listing } from "../storage/types";

/**
 * The tokenizer's hard bound. MEASURED: the longest catalog model is 11 tokens and the longest
 * of the 15 live titles is 18, so 64 is ~3.5x headroom over anything real; 0 of 336 catalog
 * names reach it -- the longest is still 11 tokens, which T33 asserts.
 *
 * `tokenize` TRUNCATES at this bound -- it does not throw and it does not refuse. A caller that
 * receives exactly MAX_TOKENS tokens therefore cannot tell a title that fits from one that was
 * cut, so it must treat the result as INCOMPLETE. `normalizeListing`'s rule 0 is that caller and
 * it fails closed; see the comment there for why silent truncation was the wrong answer.
 */
export const MAX_TOKENS = 64;

/** `endsRun` is true when this piece is the last one of its original alphanumeric run. */
export interface Token {
  value: string;
  endsRun: boolean;
}

/**
 * Lower-case, split on every non-alphanumeric character, then split each surviving run at its
 * letter/digit boundaries -- so `"rtx5080"`, `"RTX 5080"` and `"RTX-5080"` all tokenize alike,
 * which is what makes the concatenated aliases in real titles match the spaced catalog names.
 *
 * NO `normalize("NFKD")`, DELIBERATELY, AND THE ORDER IS THE WHOLE POINT. MEASURED:
 * `"RTX™".toLowerCase().normalize("NFKD")` is `"rtxTM"` -- U+2122 decomposes to an UPPER-CASE
 * `TM`, which the lower-case-only split class below then treats as a separator, so NFKD placed
 * AFTER the lower-casing changes nothing (measured: it kills no test). Put it BEFORE, and the
 * `TM` is lower-cased into the token stream: the live `AMD Radeon™ RX 6800 XT ...` tokenizes
 * `radeontm` instead of `radeon` and loses its gpu marker.
 *
 * T15t IN catalogIndex.test.ts IS THE TEST THAT GOES RED FOR IT, AND THE REASON IT HAD TO MOVE
 * IS ITSELF THE LESSON. This comment used to name T15 in normalizeListing.test.ts, whose title
 * IS that live listing. MEASURED: once `Radeon RX 6800 XT` entered the catalog, the mutation
 * stopped killing anything at all -- `rx 6800 xt` is an OPTIONAL_LEADING entry point, so the
 * title still resolves and still ends `VALID / matched`. It does NOT drop to
 * `component-unconfirmed`, which is what this sentence used to claim. A guard whose only test
 * asserts an END-TO-END outcome can be disarmed by a pure DATA change, with no code touched and
 * no test going red; T15t asserts the TOKEN STREAM, which is the layer the guard lives at.
 * MEASURED: 0 of the 336 catalog names contain a non-ASCII character, so the catalog side loses
 * nothing either way.
 */
export const tokenize = (text: string): Token[] => {
  const tokens: Token[] = [];
  for (const run of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (run === "") continue;
    const pieces = run.match(/[a-z]+|[0-9]+/g) ?? [];
    for (let index = 0; index < pieces.length; index += 1) {
      if (tokens.length === MAX_TOKENS) return tokens;
      tokens.push({ value: pieces[index], endsRun: index === pieces.length - 1 });
    }
  }
  return tokens;
};

export const tokenValues = (tokens: readonly Token[]): string[] =>
  tokens.map((token) => token.value);

/**
 * WHERE a phrase matched, not merely whether. The marker-coverage neutralisation in
 * `normalizeListing` needs the positions: `"PC case"` under a `case` search is the declared
 * component, and only knowing that the `case` marker COVERS position 0 distinguishes it from
 * `"RTX 5070 PC"`. A boolean cannot.
 */
export const phraseSpans = (
  values: readonly string[],
  phrase: readonly string[],
): [number, number][] => {
  const spans: [number, number][] = [];
  if (phrase.length === 0) return spans;
  for (let start = 0; start + phrase.length <= values.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < phrase.length; offset += 1) {
      if (values[start + offset] !== phrase[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) spans.push([start, start + phrase.length]);
  }
  return spans;
};

/**
 * A vocabulary phrase is tokenized with the SAME tokenizer as the title, so spacing and
 * punctuation inside a phrase carry no meaning: `"i 9"`, `"i9"` and `"i-9"` are one phrase.
 */
export const containsPhrase = (values: readonly string[], phrase: string): boolean =>
  phraseSpans(values, tokenValues(tokenize(phrase))).length > 0;

/**
 * Vendor prefixes a seller drops freely: `"RTX 5080"` is the same card as `"GeForce RTX 5080"`.
 * Each one is inserted as an alternative ENTRY POINT, never removed from the model name itself.
 *
 * SERIES TOKENS (`rtx`, `rx`, `gtx`, `arc`) ARE DELIBERATELY NOT HERE. Dropping them would put a
 * bare `5080` in the trie, and Dell ships an OptiPlex 5080; the live data already contains that
 * hazard shape (`Lenovo ThinkCentre M70q`). The named cost: a title naming a card without its
 * series word (`"Selling my 4070 Super"`) is a MISS, and a miss is safe.
 *
 * `core` IS HERE BECAUSE THE CATALOG FORCED IT. Every Intel CPU name is `Core i7-12700K`, and a
 * seller writes `"i7 12700K"`; with `core` undroppable, 19 of the 45 cpu names were unreachable in
 * the phrasing sellers actually use. There is no catalog-only fix -- a second entry for the same
 * product would split its pool. MEASURED, and re-derivable from this repo alone: take each of the
 * 19 `Core ...` names, strip the leading word, and append `processor` / `cpu` /
 * `desktop processor` -- 57 titles. WITH `core` here, 0 fail to resolve to their own name;
 * WITHOUT it, all 57 do. It is a PREFIX only; G2 inspects the token AFTER a completed match, so
 * this cannot interact with `core` as a trailing word, which SUFFIX_WORDS below refuses to admit
 * for a separate and still-valid reason.
 *
 * THE ONE COST `core` ADDS, NAMED RATHER THAN DISCOVERED LATER. MEASURED:
 * `"MSI PRO Z690-A i7 12700K combo"` under a cpu search is `VALID / Core i7-12700K` -- a
 * CPU-plus-board bundle entering the chip's own average, in the INFLATING direction. It is a
 * WIDENING of a hole that already exists rather than a new class: MEASURED on this same tree,
 * `"ASUS TUF B650-Plus and Ryzen 7 7700X combo"` is already `VALID / Ryzen 7 7700X`, because
 * `Ryzen` is part of the name a seller types and needs no entry point. `core` extends that
 * exposure to the 19 Intel names; it does not create it. The bundle IS caught whenever the board
 * is named with a motherboard marker -- `"i7 12700K and motherboard combo"` is refused by rule 5
 * as `mixed-components` -- so what leaks is the phrasing that names a board model and no marker.
 *
 * THE FIX IS ONE WORD, AND IT IS DELIBERATELY NOT MADE HERE: `combo` as a one-word MULTIPLE
 * phrase closes both halves at once. MULTIPLE is global across all nine types, so a new entry
 * needs its own collision sweep against all 336 names, the 15 live titles and all seven corpora
 * -- which is exactly the cost this slice has already learned that new vocabulary carries. It is
 * the first thing to try the next time that vocabulary is opened.
 *
 * `nvidia` AND `amd` ARE MEASURED INERT, AND THEY ARE KEPT ON PURPOSE. MEASURED: 0 of the 336
 * catalog names begin with either word -- every name this set can reach today is `GeForce ...`
 * (43), `Radeon ...` (20), `Intel Arc ...` (5) or `Core ...` (19) -- so neither can produce an
 * entry point, and no test can kill either one. DO NOT DELETE THEM FOR TIDINESS. This set
 * ANTICIPATES catalog names rather than describing them, and whether to grow the catalog further
 * is an open question. Deleted, the day a vendor-prefixed name lands is SILENT: the full
 * name still self-resolves so T11 stays green, while a title naming that card without its vendor
 * word quietly stops matching. Kept, that day is LOUD: T14 in catalogIndex.test.ts asserts the
 * count map `{geforce: 43, nvidia: 0, radeon: 20, amd: 0, intel: 5, core: 19}` and fails the
 * moment it stops being true, which puts the decision in front of a human instead of into an
 * aggregate.
 */
const OPTIONAL_LEADING = new Set(["geforce", "nvidia", "radeon", "amd", "intel", "core"]);

/**
 * Tokens that turn an otherwise-complete model name into a DIFFERENT vendor SKU. G2 refuses a
 * match followed by one of these, so `"RTX 5070 Ti Super"` does not pool into `RTX 5070 Ti`.
 *
 * SEVEN CANDIDATES WERE MEASURED AND REFUSED, and the reason matters more than the list: ALL TEN
 * passed the whole suite. A green suite is a claim about the suite, not about real listings --
 * the same blindness that let `nitro` through as a system phrase. So each was judged on whether
 * the word has a DESCRIPTIVE use that follows a model name:
 *   `atx`      -- a form factor, not a variant: `"MSI MAG B650 Tomahawk WiFi ATX motherboard"`
 *                 is the catalog model, and the collector's own fixture has that shape.
 *   `expo`     -- a memory profile the catalog kits already carry.
 *   `core`     -- NOT for the reason first written here. "collides with Intel's `Core` naming"
 *                 was DISPROVED: Intel's `Core` is always a PREFIX, and G2 only ever inspects the
 *                 token AFTER a completed match, so that collision cannot occur -- 0 across 3,168
 *                 catalog-derived titles. The real reason is that `core` genuinely follows a
 *                 completed match in ordinary CPU phrasing, and THIS LIST IS GLOBAL ACROSS ALL
 *                 NINE COMPONENT TYPES: a word admitted to fix one `case` variant applies to the
 *                 cpu index too. Type-scoped suffix lists would let `case` have it without cpu
 *                 paying for it; that is a design change and is out of scope here.
 *   `a`        -- the English article. `"GeForce RTX 5080 a great deal"` would stop matching.
 *   `fe`       -- a Founders Edition is the same die and the same comparison product.
 *   `tg`, `platinum` -- could not be established as DIFFERENT from the catalog entry rather than
 *                 the name of it, and refusing the product the catalog lists is the wrong error.
 * Each refusal costs a pinned mis-pool, stated in ACCEPTED_EXPOSURE rather than left unmeasured.
 *
 * AN OPEN-ENDED BLOCKLIST, NOT A CLOSED ONE. It closed five real mis-pools found under review
 * (`NH-U12S redux`, `NH-D15 chromax`, `RX 9070 GRE`, `RTX 5090 D`, `H7 Flow RGB`), and
 * `"Corsair RM850x 2021"` -> `Corsair RM850x` still stands: year-suffixed revisions are an
 * unbounded class and enumerating years would prove the list open-ended rather than close it.
 * That residual is PINNED by T36 in normalizeListing.test.ts so the next one is visible rather
 * than discovered. MEASURED AGAINST THE 176-NAME CATALOG AS OF PR #14, and scoped rather than
 * re-numbered because the per-addition ablation behind it cannot be re-run from the repo: every
 * addition beyond the original four left all 176 self-resolutions intact and the 1,408
 * cross-type pairs at 0 leaks.
 *
 * WHAT ACTUALLY GOES RED IF AN ENTRY LEAVES THIS LIST -- and it is NOT T11 or T12. MEASURED,
 * deleting one element at a time: T20 in catalogIndex.test.ts (the per-element sweep, which
 * carries its own literal copy of this list), R6 over SKU_SUFFIX_PHRASINGS, G1x over
 * GENERATION_TITLES, and for four of them a named row in CASES (T26 `super`, T34 `redux`,
 * T35 `gre`, T25/T27 the concatenated forms). Deleting `redux` gives T20 + R6 + T34; deleting
 * `xt` gives T20 + G1x; deleting `ii` or `touch` gives T20 + R6.
 *
 * T11 AND T12 PROVE SOMETHING NARROWER, AND CITING THEM HERE WOULD BE FALSE COMFORT. MEASURED:
 * deleting ALL THREE admissibility guards from `walkFrom` leaves T11 at 0 failures and T12 at 0
 * leaks while `"MSI RTX 5070 Ti Super gaming card"` starts resolving to `GeForce RTX 5070 Ti`.
 * What they do prove is that no catalog name is SHADOWED by another (T11: all 336 self-resolve)
 * and that none is CROSS-LISTED under a foreign type (T12: 2,688 pairs, 0 leaks). Neither can
 * see a guard or a vocabulary element disappear.
 */
const SUFFIX_WORDS = new Set([
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
  // ADDED AFTER A CORPUS WAS WRITTEN FOR THIS LIST RATHER THAN FROM IT -- see
  // SKU_SUFFIX_PHRASINGS in normalizeListing.test.ts, which found 10 mis-pools in 20 real
  // variant titles. Each of these three is a genuine SKU differentiator with no descriptive use
  // this project could name, and each was measured against all 176 catalog names AS OF PR #14,
  // the 15 live titles and every title the suite pins as a match. What kills their REMOVAL today
  // is T20, R6 and -- for `argb` -- G1x; see the note above on why T11 and T12 cannot.
  "ii",
  "touch",
  "argb",
]);

/** A prefix trie node; the exported index is its root. */
export interface ModelIndex {
  children: Map<string, ModelIndex>;
  /** The catalog name that ENDS here, or null when this node is only a prefix. */
  model: string | null;
}

/**
 * Insert each model's full token sequence plus every suffix obtained by dropping leading
 * OPTIONAL_LEADING tokens. MEASURED: 336 models produce 423 cores -- the names themselves plus
 * 87 vendor-stripped entry points (geforce 43, radeon 20, intel 5, core 19) -- and 0 of them
 * begin with a pure-digit token.
 *
 * First insert wins on a collision. MEASURED: no catalog name is shadowed -- T11 resolves all
 * 336 to themselves.
 */
export const buildModelIndex = (models: readonly string[]): ModelIndex => {
  const root: ModelIndex = { children: new Map(), model: null };
  const insert = (sequence: readonly string[], model: string): void => {
    let node = root;
    for (const value of sequence) {
      let next = node.children.get(value);
      if (next === undefined) {
        next = { children: new Map(), model: null };
        node.children.set(value, next);
      }
      node = next;
    }
    if (node.model === null) node.model = model;
  };

  for (const model of models) {
    const sequence = tokenValues(tokenize(model));
    insert(sequence, model);
    // `< length - 1`: a model whose name is ENTIRELY optional-leading tokens never becomes an
    // empty core, which would make the root itself terminal and match every title.
    let start = 0;
    while (start < sequence.length - 1 && OPTIONAL_LEADING.has(sequence[start])) {
      start += 1;
      insert(sequence.slice(start), model);
    }
  }
  return root;
};

/**
 * One greedy walk from `start`, and the three guards that decide whether it is admissible.
 *
 * W  -- take the DEEPEST complete name reached, not the first. Without it `"Corsair RM850x
 *       Shift"` stops at `Corsair RM850x`, i.e. a different, cheaper product.
 * G1 -- the walk must not continue PAST the last complete name. `"Noctua NH-D15 G3"` walks one
 *       token beyond `NH-D15`, so the title is more specific than anything the catalog holds and
 *       the honest answer is no match.
 * B2 -- the last matched token must END its character run. Without it `"Ryzen 7 7700X3D"` ends
 *       mid-run on the `7700x` of `7700x3d` and pools an X3D chip into the non-X3D model.
 * G2 -- the token AFTER the match must not be a vendor SKU suffix. See SUFFIX_WORDS.
 */
const walkFrom = (
  index: ModelIndex,
  tokens: readonly Token[],
  start: number,
): { model: string; depth: number } | null => {
  let node = index;
  let depth = 0;
  let terminalDepth = -1;
  let terminalModel: string | null = null;

  while (start + depth < tokens.length) {
    const next = node.children.get(tokens[start + depth].value);
    if (next === undefined) break;
    node = next;
    depth += 1;
    if (node.model !== null) {
      terminalDepth = depth;
      terminalModel = node.model;
    }
  }

  if (terminalModel === null) return null;
  if (terminalDepth < depth) return null;
  if (!tokens[start + terminalDepth - 1].endsRun) return null;
  const after = tokens[start + terminalDepth];
  if (after !== undefined && SUFFIX_WORDS.has(after.value)) return null;
  return { model: terminalModel, depth: terminalDepth };
};

/**
 * Every DISTINCT catalog model the title names, in the order their matches start.
 *
 * A start-of-run guard and a span-containment filter were both written, MEASURED and DELETED
 * rather than shipped untestable: 0 of the 423 cores begin with a digit token, and the greedy
 * walk never yields two nested spans holding DIFFERENT models. Do not re-add either without a
 * test that can go red.
 */
export interface ModelSpan {
  model: string;
  /** Inclusive token index where the match begins. */
  start: number;
  /** EXCLUSIVE token index where it ends. */
  end: number;
}

/**
 * Every admissible match WITH its token span. `matchCatalogModels` is this, de-duplicated down to
 * the names; the spans exist because rule 8 has to ask whether one PARTICULAR token belongs to
 * the item being named, which a list of names cannot answer.
 */
export const matchCatalogSpans = (index: ModelIndex, tokens: readonly Token[]): ModelSpan[] => {
  const spans: ModelSpan[] = [];
  for (let start = 0; start < tokens.length; start += 1) {
    const hit = walkFrom(index, tokens, start);
    if (hit !== null) spans.push({ model: hit.model, start, end: start + hit.depth });
  }
  return spans;
};

export const matchCatalogModels = (index: ModelIndex, tokens: readonly Token[]): string[] => [
  ...new Set(matchCatalogSpans(index, tokens).map((span) => span.model)),
];

/**
 * THE NAMED TRAP: the Worker calls it `case_fan` (worker/storage/types.ts) and the catalog calls
 * it `case_fans` (src/types.ts). Every other id is spelled the same on both sides.
 *
 * The `Record<Listing["componentType"], ...>` type makes adding a WORKER component type without
 * a mapping a compile error, exactly as `COMPONENT_TYPES` in worker/api/listings.ts already does.
 * THE REVERSE IS NOT CAUGHT: a new CATALOG id compiles fine and simply goes unused here.
 */
export const CATALOG_COMPONENT_ID: Record<Listing["componentType"], ComponentType> = {
  cpu: "cpu",
  cpu_cooler: "cpu_cooler",
  motherboard: "motherboard",
  ram: "ram",
  storage: "storage",
  gpu: "gpu",
  psu: "psu",
  case: "case",
  case_fan: "case_fans",
};

const catalogModels = (id: ComponentType): readonly string[] => {
  const definition = componentCatalog.find((entry) => entry.id === id);
  // THROWS AT MODULE LOAD rather than falling back to an empty index. An empty index answers
  // "no model" for every title of that type -- indistinguishable from a real miss, and it would
  // disable a whole component type silently.
  if (definition === undefined) {
    throw new Error(`catalogIndex: src/data/catalog.ts has no component "${id}"`);
  }
  return definition.models;
};

/**
 * Built ONCE at module load, not per request. MEASURED: 0.110 ms for all nine types.
 */
export const MODEL_INDEXES: Record<Listing["componentType"], ModelIndex> = (() => {
  const entries = Object.entries(CATALOG_COMPONENT_ID) as [
    Listing["componentType"],
    ComponentType,
  ][];
  const indexes = {} as Record<Listing["componentType"], ModelIndex>;
  for (const [workerType, catalogId] of entries) {
    indexes[workerType] = buildModelIndex(catalogModels(catalogId));
  }
  return indexes;
})();
