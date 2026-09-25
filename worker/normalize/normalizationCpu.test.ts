// @vitest-environment node

/**
 * The CPU cost normalization adds to the request path, measured the way
 * worker/evaluation/evaluationCpu.test.ts measures its own: MANY iterations per clock read, and
 * THE RESULT IS CONSUMED. A block timer whose result is thrown away measures dead-code
 * elimination -- that file documents three wrong numbers produced exactly that way, so every
 * loop here folds something from each result into `sink` and prints it.
 *
 * THE BUDGET THIS IS AGAINST. PLAN.md sets a 10 ms hard CPU limit per invocation and
 * evaluationCpu.test.ts states the repo's own invariant as p95 < 8 ms; normalization is only one
 * part of the route, which also pays `JSON.parse` of the body and 100 SHA-256 content hashes.
 * All three assertions below are against the same 8 ms.
 *
 * HONEST LIMITATION, THE SAME ONE evaluationCpu.test.ts CARRIES: these are Node measurements on
 * a development machine, not workerd. At this headroom -- roughly 39x under the invariant on
 * real traffic -- the conclusion survives it, and the real bound is structural anyway: MAX_TOKENS
 * caps the work per title regardless of how long the title is.
 */

import { componentCatalog } from "../../src/data/catalog";
import type { Listing } from "../storage/types";
import { CATALOG_COMPONENT_ID, MAX_TOKENS, buildModelIndex, tokenize } from "./catalogIndex";
import { normalizeListing } from "./normalizeListing";

/** The 15 titles a real GPU search returned in production, copied as literals. */
const LIVE_BATCH: [string, number][] = [
  ["For trade: MSI RTX 3060 Ventus 2X 12GB for an Intel Arc B580 12gb", 0],
  ["EVGA GeForce GTX 980 Ti Classified Graphics Card for parts", 2500],
  ["Timetec 16GB DDR4 3200MHz SODIMM Laptop RAM", 5000],
  ["Tesla 128GB USB Drive and Key Card", 5100],
  ["Samsung 870 EVO and 860 EVO 500GB SSD", 6500],
  ["Lian Li lancool 217 White PC Case", 12000],
  ["XPG Gammix D10 32GB (2x16GB) DDR4 3200MHz RAM", 15000],
  ["Gigabyte vision 3060ti (white)", 36000],
  ["AMD Radeon™ RX 6800 XT Phantom Gaming D 16G OC", 49900],
  ["Selling My 4070 TI", 100000],
  ["Lenovo ThinkCentre M70q Gen 6 U5235T 16GB/256GB W11 Pro", 125000],
  ["Gaming+PC+", 185000],
  ["RTX 4070 super gaming pc | Ryzen 5 7600 | 32gb DDR4 RAM | 1tb nvme", 200000],
  ["GPU: ASUS ROG Astral GeForce RTX 5080", 300000],
  ["MINT Alienware x17 R2 Flagship Ecosystem - i9 | RTX 3080 Ti (16GB)", 350000],
];

/**
 * THE WORST LEGAL BATCH, ON BOTH SIDES OF THE TOKEN CAP. 100 listings is
 * MAX_LISTINGS_PER_BATCH and 300 characters is MAX_TITLE_LENGTH, so both are batches a token
 * holder can legally send.
 *
 * `CAPPED_TITLE` maximises letter/digit splits -- every character boundary is a token boundary,
 * 300 tokens before truncation. Under THIS implementation it is no longer the expensive one:
 * rule 0 runs first, so a capped title short-circuits before the nine-index scan ever starts.
 * MEASURING ONLY THAT TITLE WOULD BE A CLAIM WIDER THAN ITS MEASUREMENT, so `UNCAPPED_TITLE`
 * sits one token UNDER the cap and pays the full scan: 63 tokens, the most work any legal title
 * can reach.
 */
const CAPPED_TITLE = "a1b2c3d4e5".repeat(40).slice(0, 300);
const UNCAPPED_TITLE = `${"abcd1234 ".repeat(31)}efgh`;

let sink = 0;

/**
 * Block-timed: `inner` calls per clock read, `reps` reads, sorted, p50/p95 returned per call.
 * The 30 warm-up blocks let the JIT settle before anything is recorded.
 */
const measure = (work: () => number, inner: number, reps = 60): { p50: number; p95: number } => {
  for (let warm = 0; warm < 30; warm += 1) sink += work();
  const samples: number[] = [];
  for (let rep = 0; rep < reps; rep += 1) {
    const start = performance.now();
    for (let index = 0; index < inner; index += 1) sink += work();
    samples.push((performance.now() - start) / inner);
  }
  samples.sort((a, b) => a - b);
  return {
    p50: samples[Math.floor(samples.length * 0.5)],
    p95: samples[Math.floor(samples.length * 0.95)],
  };
};

const WORKER_TYPES = Object.keys(CATALOG_COMPONENT_ID) as Listing["componentType"][];

describe("normalization CPU", () => {
  /** T38: what real traffic costs -- one 15-listing window, normalized end to end. */
  it("T38: p95 for the 15-listing live batch is far under the 8 ms budget", () => {
    const work = (): number => {
      let consumed = 0;
      for (const [title, priceCents] of LIVE_BATCH) {
        consumed += normalizeListing({ title, priceCents, componentType: "gpu" }).reason.length;
      }
      return consumed;
    };

    const { p50, p95 } = measure(work, 20);
    console.log(
      `normalizeListing over the 15 live titles: p50 ${p50.toFixed(4)} ms, p95 ${p95.toFixed(4)} ms [sink ${sink}]`,
    );
    expect(p95).toBeLessThan(8);
  });

  /**
   * T39: the indexes are built ONCE, at module load, so this cost lands on the first request of
   * an isolate and never again. Asserted against the same per-invocation budget, because that
   * first request is the one that pays it.
   */
  it("T39: building all nine model indexes is far under the 8 ms budget", () => {
    const modelLists = WORKER_TYPES.map((componentType) => {
      const definition = componentCatalog.find(
        (entry) => entry.id === CATALOG_COMPONENT_ID[componentType],
      );
      if (definition === undefined) throw new Error(`no catalog component for ${componentType}`);
      return definition.models;
    });
    expect(modelLists.flat()).toHaveLength(336);

    const work = (): number => {
      let consumed = 0;
      for (const models of modelLists) consumed += buildModelIndex(models).children.size;
      return consumed;
    };

    const { p50, p95 } = measure(work, 20);
    console.log(
      `buildModelIndex x9 (all 336 models): p50 ${p50.toFixed(4)} ms, p95 ${p95.toFixed(4)} ms [sink ${sink}]`,
    );
    expect(p95).toBeLessThan(8);
  });

  /**
   * T40c: THE WORST LEGAL BATCH, both sides of the cap. These are the numbers the cap exists
   * for -- uncapped, the same shape measured 7.50 ms and would have breached the repo's existing
   * 8 ms invariant with `JSON.parse` and 100 content hashes still to pay on top.
   */
  it("T40c: p95 for the worst legal 100-listing batch is under the 8 ms budget", () => {
    expect(CAPPED_TITLE).toHaveLength(300);
    expect(tokenize(CAPPED_TITLE)).toHaveLength(MAX_TOKENS);
    expect(UNCAPPED_TITLE.length).toBeLessThanOrEqual(300);
    // ONE TOKEN UNDER the cap: rule 0 does not fire, so every rule below it runs in full.
    expect(tokenize(UNCAPPED_TITLE)).toHaveLength(MAX_TOKENS - 1);

    const batch = (title: string) => (): number => {
      let consumed = 0;
      for (let index = 0; index < 100; index += 1) {
        consumed += normalizeListing({
          title,
          priceCents: 12_345 + index,
          componentType: "gpu",
        }).reason.length;
      }
      return consumed;
    };

    const capped = measure(batch(CAPPED_TITLE), 1, 40);
    const uncapped = measure(batch(UNCAPPED_TITLE), 1, 40);
    console.log(
      `normalizeListing over the worst legal batch (100 x 300 chars): ` +
        `capped at 64 tokens p50 ${capped.p50.toFixed(4)} ms, p95 ${capped.p95.toFixed(4)} ms; ` +
        `63 tokens (full scan) p50 ${uncapped.p50.toFixed(4)} ms, p95 ${uncapped.p95.toFixed(4)} ms [sink ${sink}]`,
    );
    expect(capped.p95).toBeLessThan(8);
    expect(uncapped.p95).toBeLessThan(8);
  });
});
