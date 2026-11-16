// @vitest-environment node

/**
 * The replay's pure half. `testing/d1ListingsExport.json` is shaped exactly like
 * `wrangler d1 execute --remote --json` output (one statement entry: `results`, `success`, `meta`),
 * with synthetic ids, and holds one row per outcome the report distinguishes.
 */

import { readFileSync } from "node:fs";
import { formatReport, parseD1Export, replay } from "./replay";

const FIXTURE = readFileSync(new URL("./testing/d1ListingsExport.json", import.meta.url), "utf8");

describe("replay -- parsing wrangler's --json output", () => {
  it("reads every row of every statement", () => {
    expect(parseD1Export(FIXTURE).map((row) => row.listing_id)).toEqual([
      "fx-same",
      "fx-gain",
      "fx-lose",
      "fx-change",
      "fx-validity",
      "fx-unmatched",
      "fx-quantity",
      "fx-no-price",
      "fx-multiline",
      "fx-skipped",
    ]);
  });

  it("tolerates the banner lines wrangler prints without --json", () => {
    expect(parseD1Export(`🌀 Executing on remote database\n${FIXTURE}`)).toHaveLength(10);
  });

  it("refuses a failed statement, a non-export and a SELECT with the wrong columns", () => {
    expect(() => parseD1Export('[{"results":[],"success":false}]')).toThrow(/did not succeed/);
    expect(() => parseD1Export('{"error":"x"}')).toThrow(/no JSON array/);
    expect(() => parseD1Export('[{"rows":[]}]')).toThrow(/no "results"/);
    expect(() =>
      parseD1Export(
        '[{"results":[{"listing_id":"a","title":"t","price":1,"component_type":"gpu","validity":"VALID","model_key":null}],"success":true}]',
      ),
    ).toThrow(/price_cents/);
  });
});

describe("replay -- the report", () => {
  const report = replay(parseD1Export(FIXTURE));

  it("lists a row whose type is outside the nine instead of replaying it", () => {
    expect(report.rows).toBe(10);
    expect(report.skipped).toEqual([{ listingId: "fx-skipped", componentType: "gpuu" }]);
  });

  it("(a) breaks the replayed rows down by reason", () => {
    expect(report.reasons).toEqual({
      "component-unconfirmed": 2,
      matched: 3,
      "model-unmatched": 2,
      "unknown-quantity": 1,
      "whole-system": 1,
    });
  });

  it("(b) counts distinct keyed listing ids, stored and at this commit", () => {
    expect(report.keyedListingIds).toEqual({ stored: 3, commit: 3 });
  });

  /**
   * One row per diff kind, and the unchanged row absent. The gained key carries the type change
   * with it: the stored row is the pre-resolution `cpu` refusal of a card a cpu search returned.
   */
  it("(c) names every row that gains, changes or loses a key, or changes validity or type", () => {
    expect(
      report.diff.map((row) => [row.kind, row.listingId, row.stored.modelKey, row.commit.modelKey, row.commit.componentType]),
    ).toEqual([
      ["gains key", "fx-gain", null, "GeForce RTX 5070 Ti", "gpu"],
      ["changes key", "fx-change", "GeForce RTX 3080 Ti", "GeForce RTX 3080", "gpu"],
      ["loses key", "fx-lose", "GeForce RTX 3070", null, "gpu"],
      ["changes validity or type", "fx-validity", null, null, "storage"],
    ]);
  });

  it("(d) lists the unkeyed components: model-unmatched, component-unconfirmed, unknown-quantity", () => {
    expect(report.unkeyedComponents.map((row) => [row.componentType, row.reason, row.listingId])).toEqual([
      ["cpu", "component-unconfirmed", "fx-multiline"],
      ["gpu", "model-unmatched", "fx-no-price"],
      ["gpu", "unknown-quantity", "fx-quantity"],
      ["motherboard", "model-unmatched", "fx-unmatched"],
      ["storage", "component-unconfirmed", "fx-validity"],
    ]);
  });

  it("prints one line per title, so a seller's line breaks cannot split a row", () => {
    const text = formatReport(report);
    expect(text).toContain("(b) yield: distinct listing_ids carrying a model key\n  stored 3\n  commit 3\n");
    expect(text).toContain(
      "GAINS KEY  fx-gain  cpu INVALID_REFERENCE -  ->  gpu VALID GeForce RTX 5070 Ti (matched)",
    );
    expect(text).toContain('"Cobra CPI 450 Power Inverter – $40 CAD\\n\\nCobra 400W');
    expect(text).toContain("no price");
  });
});
