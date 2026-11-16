// @vitest-environment node

/**
 * REFERENCE-PRICE YIELD AGAINST REAL TRAFFIC. `testing/liveCorpus.ts` holds 141 real titles with a
 * hand label each; this file runs every title through `normalizeListing` under EVERY search type
 * that returned it, exactly as ingest would, and holds the rule to two hard gates and one floor.
 *
 * THE HARD GATES ARE PRECISION. A wrong key writes a wrong price into a benchmark that nothing
 * later corrects, so a single one fails the suite: a keyed title must carry its label's model AND
 * its label's type, under every search; a title that is not a standalone component must never be
 * keyed at all.
 *
 * THE FLOOR IS RECALL, AND IT IS PINNED EXACTLY, NOT AS A MINIMUM. A change that recalls more must
 * move these numbers on purpose and say which titles it gained; a change that recalls less goes
 * red naming the title it lost. The miss list is asserted by title for that reason -- a count
 * alone says that something moved, not what.
 */

import { componentCatalog } from "../../src/data/catalog";
import { parsePriceText } from "../api/priceText";
import type { Listing } from "../storage/types";
import { CATALOG_COMPONENT_ID } from "./catalogIndex";
import { normalizeListing, type Normalization } from "./normalizeListing";
import { LIVE_CORPUS, type LiveCorpusEntry } from "./testing/liveCorpus";

const catalogModels = (componentType: Listing["componentType"]): readonly string[] => {
  const definition = componentCatalog.find(
    (entry) => entry.id === CATALOG_COMPONENT_ID[componentType],
  );
  if (definition === undefined) throw new Error(`no catalog component for ${componentType}`);
  return definition.models;
};

/** Every (search, result) pair one entry produces -- the rule under each search that returned it. */
const sightings = (entry: LiveCorpusEntry): [Listing["componentType"], Normalization][] =>
  entry.searchedAs.map((searched) => [
    searched,
    normalizeListing({
      title: entry.title,
      priceCents: parsePriceText(entry.priceText),
      componentType: searched,
    }),
  ]);

const keyed = (result: Normalization): boolean => result.modelKey !== null;

describe("live corpus -- the corpus itself", () => {
  it("holds 141 distinct titles, each returned by at least one search", () => {
    expect(LIVE_CORPUS).toHaveLength(141);
    expect(new Set(LIVE_CORPUS.map((entry) => entry.title)).size).toBe(141);
    expect(LIVE_CORPUS.filter((entry) => entry.searchedAs.length === 0)).toEqual([]);
  });

  /**
   * A label naming a model the catalog does not hold would make the precision gate demand an
   * impossible key -- and a typo in a label would read as a wrong key in the rule.
   */
  it("every catalogued label names a model the catalog lists under that type", () => {
    const unknown = LIVE_CORPUS.flatMap((entry) =>
      entry.label.kind === "component" && !catalogModels(entry.label.type).includes(entry.label.modelKey)
        ? [`${entry.label.type} / ${entry.label.modelKey} <- ${entry.title}`]
        : [],
    );
    expect(unknown).toEqual([]);
  });

  it("carries no listing id, URL or contact detail", () => {
    const leaks = LIVE_CORPUS.filter(({ title }) =>
      /https?:|www\.|facebook|@|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b|\b\d{15,17}\b/i.test(title),
    );
    expect(leaks.map((entry) => entry.title)).toEqual([]);
  });
});

describe("live corpus -- hard gates (precision)", () => {
  it("GATE 1: 0 wrong keys -- every keyed title carries its label's model and type, under every search", () => {
    const wrong = LIVE_CORPUS.flatMap((entry) =>
      sightings(entry).flatMap(([searched, result]) => {
        if (!keyed(result)) return [];
        const { label } = entry;
        const right =
          label.kind === "component" &&
          result.modelKey === label.modelKey &&
          result.componentType === label.type;
        return right ? [] : [`[${searched}] ${result.componentType}/${result.modelKey} <- ${entry.title}`];
      }),
    );
    expect(wrong).toEqual([]);
  });

  it("GATE 2: a title that is not a standalone component is keyed under no search", () => {
    const keyedNonComponents = LIVE_CORPUS.flatMap((entry) =>
      entry.label.kind === "not-a-component"
        ? sightings(entry)
            .filter(([, result]) => keyed(result))
            .map(([searched, result]) => `[${searched}] ${result.modelKey} <- ${entry.title}`)
        : [],
    );
    expect(keyedNonComponents).toEqual([]);
  });

  /** Uncatalogued parts have no right key; any key on one is a wrong key by construction. */
  it("GATE 2b: an uncatalogued component is keyed under no search", () => {
    const keyedUncatalogued = LIVE_CORPUS.flatMap((entry) =>
      entry.label.kind === "uncatalogued"
        ? sightings(entry)
            .filter(([, result]) => keyed(result))
            .map(([searched, result]) => `[${searched}] ${result.modelKey} <- ${entry.title}`)
        : [],
    );
    expect(keyedUncatalogued).toEqual([]);
  });
});

describe("live corpus -- the floor (recall), pinned on master 404677e and raised by Part 2", () => {
  const components = LIVE_CORPUS.filter((entry) => entry.label.kind !== "not-a-component");
  const catalogued = LIVE_CORPUS.filter((entry) => entry.label.kind === "component");
  const recalledEverywhere = catalogued.filter((entry) =>
    sightings(entry).every(([, result]) => keyed(result)),
  );

  /**
   * 9 of 13 ON MASTER 404677e. PART 2 RAISES IT ONE RULE AT A TIME, each move deliberate:
   * +1 the inner `MAG` sub-brand (`MSI B850 Tomahawk ...`), +1 the two-module kit-spec skip
   * (`G.SKILL Ripjaws V 16GB (2x8GB) ...`). PR 2.4 adds one by CATALOG, not by rule: `Ryzen 7
   * 3800X` entered the catalog on replay frequency, so `AMD RYZEN 7 3800X` moved from
   * uncatalogued to catalogued and is keyed under its one search.
   */
  it("counts: 36 standalone components, 14 of them catalogued, 12 of 14 keyed under every search", () => {
    expect({
      titles: LIVE_CORPUS.length,
      standaloneComponents: components.length,
      catalogued: catalogued.length,
      recalledUnderEverySearch: recalledEverywhere.length,
      keyedUnderSomeSearch: LIVE_CORPUS.filter((entry) => sightings(entry).some(([, r]) => keyed(r)))
        .length,
    }).toEqual({
      titles: 141,
      standaloneComponents: 36,
      catalogued: 14,
      recalledUnderEverySearch: 12,
      keyedUnderSomeSearch: 12,
    });
  });

  /**
   * THE MISSES, BY TITLE, WITH WHAT EACH ONE NEEDS. This list is the recall work queue; a
   * change that closes one moves it here on purpose.
   */
  it("misses exactly these two catalogued titles", () => {
    expect(
      catalogued
        .filter((entry) => !recalledEverywhere.includes(entry))
        .map((entry) => entry.title)
        .sort(),
    ).toEqual(
      [
        // No `gtx`: series words are not droppable, so `1050 ti` alone is not the catalog name.
        "1050TI GPU",
        // The seller wrote RTX for a GTX card; the series word is not droppable, by design.
        "Gigabyte GeForce RTX 1650 4GB",
      ].sort(),
    );
  });
});
