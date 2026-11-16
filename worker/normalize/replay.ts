/**
 * REPLAY: run every stored listing through THIS commit's `normalizeListing`, under its stored
 * `component_type`, and report what the commit would store differently. The operator tool behind
 * `scripts/replay-normalization.ts`; pure, so it is tested here rather than through a process.
 *
 * WHY IT IS EXACT RATHER THAN APPROXIMATE. `normalizeListing` is a pure function of
 * `(title, priceCents, componentType)` and all three are stored columns. `price_cents` is the
 * value `parsePriceText` already produced, so replaying it skips nothing. Replaying under the
 * stored type is what ingest would store if the search that last wrote the row ran again on this
 * commit -- and for a row this commit's rule wrote, it reproduces the row exactly, because the type
 * resolution depends on the title alone when it fires and returns its input when it does not.
 *
 * THE INPUT is what `wrangler d1 execute <db> --remote --json --command "<SELECT>"` prints: an
 * array with one entry per statement, each `{ results: Row[], success: boolean, meta: {...} }`
 * (wrangler-dist/cli.js, `executeRemotely` -> the D1 `/query` API response, printed with
 * `JSON.stringify` under `--json`). Column names are `migrations/0001_initial_storage.sql`'s.
 */

import type { Listing } from "../storage/types";
import { CATALOG_COMPONENT_ID } from "./catalogIndex";
import { normalizeListing, type Normalization, type NormalizationReason } from "./normalizeListing";

/** The SELECT the script documents: exactly these columns, by these names. */
export const REPLAY_SELECT =
  "SELECT listing_id,title,price_cents,component_type,validity,model_key FROM listings";

export interface StoredRow {
  listing_id: string;
  title: string;
  price_cents: number | null;
  component_type: string;
  validity: string;
  model_key: string | null;
}

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/**
 * Parses wrangler's `--json` output. Anything before the first `[` is dropped, because a wrangler
 * run WITHOUT `--json` prints banner lines first; every row is then checked column by column, so
 * a SELECT that names a different column fails loudly here instead of replaying `undefined`.
 */
export const parseD1Export = (raw: string): StoredRow[] => {
  const start = raw.indexOf("[");
  if (start === -1) throw new Error("replay: no JSON array in the input");
  const parsed: unknown = JSON.parse(raw.slice(start));
  if (!Array.isArray(parsed)) throw new Error("replay: the input is not a JSON array");

  const rows: StoredRow[] = [];
  parsed.forEach((statement: unknown, index) => {
    if (typeof statement !== "object" || statement === null || !("results" in statement)) {
      throw new Error(`replay: statement ${index} has no "results" -- is this wrangler --json output?`);
    }
    const { results, success } = statement as { results: unknown; success?: unknown };
    if (success === false) throw new Error(`replay: statement ${index} did not succeed`);
    if (!Array.isArray(results)) throw new Error(`replay: statement ${index} "results" is not an array`);
    results.forEach((row: unknown, rowIndex) => {
      const at = `replay: statement ${index} row ${rowIndex}`;
      if (typeof row !== "object" || row === null) throw new Error(`${at} is not an object`);
      const r = row as Record<string, unknown>;
      if (typeof r.listing_id !== "string") throw new Error(`${at}: listing_id is not a string`);
      if (typeof r.title !== "string") throw new Error(`${at}: title is not a string`);
      if (!(r.price_cents === null || typeof r.price_cents === "number")) {
        throw new Error(`${at}: price_cents is not a number or null`);
      }
      if (typeof r.component_type !== "string") throw new Error(`${at}: component_type is not a string`);
      if (typeof r.validity !== "string") throw new Error(`${at}: validity is not a string`);
      if (!isNullableString(r.model_key)) throw new Error(`${at}: model_key is not a string or null`);
      rows.push({
        listing_id: r.listing_id,
        title: r.title,
        price_cents: r.price_cents,
        component_type: r.component_type,
        validity: r.validity,
        model_key: r.model_key,
      });
    });
  });
  return rows;
};

export type DiffKind = "gains key" | "loses key" | "changes key" | "changes validity or type";

export interface DiffRow {
  kind: DiffKind;
  listingId: string;
  title: string;
  stored: { componentType: string; validity: string; modelKey: string | null };
  commit: { componentType: string; validity: string; modelKey: string | null; reason: NormalizationReason };
}

export interface UnkeyedRow {
  listingId: string;
  componentType: string;
  reason: NormalizationReason;
  priceCents: number | null;
  title: string;
}

export interface ReplayReport {
  rows: number;
  /** Rows whose stored `component_type` is not one of the nine: not replayable, listed instead. */
  skipped: { listingId: string; componentType: string }[];
  reasons: Partial<Record<NormalizationReason, number>>;
  keyedListingIds: { stored: number; commit: number };
  diff: DiffRow[];
  unkeyedComponents: UnkeyedRow[];
}

/**
 * The reasons that mean "a real component the rule could not key" -- the catalog-candidate queue.
 * `component-unconfirmed` and `unknown-quantity` are in it because both hold real single parts the
 * rule declined on vocabulary, not only junk; a human sorts them.
 */
const UNKEYED_COMPONENT_REASONS: ReadonlySet<NormalizationReason> = new Set([
  "model-unmatched",
  "component-unconfirmed",
  "unknown-quantity",
]);

const isComponentType = (value: string): value is Listing["componentType"] =>
  Object.hasOwn(CATALOG_COMPONENT_ID, value);

const diffKind = (stored: StoredRow, commit: Normalization): DiffKind | null => {
  if (stored.model_key === null && commit.modelKey !== null) return "gains key";
  if (stored.model_key !== null && commit.modelKey === null) return "loses key";
  if (stored.model_key !== commit.modelKey) return "changes key";
  if (stored.validity !== commit.validity || stored.component_type !== commit.componentType) {
    return "changes validity or type";
  }
  return null;
};

export const replay = (rows: readonly StoredRow[]): ReplayReport => {
  const report: ReplayReport = {
    rows: rows.length,
    skipped: [],
    reasons: {},
    keyedListingIds: { stored: 0, commit: 0 },
    diff: [],
    unkeyedComponents: [],
  };
  const storedKeyed = new Set<string>();
  const commitKeyed = new Set<string>();

  for (const row of rows) {
    if (row.model_key !== null) storedKeyed.add(row.listing_id);
    if (!isComponentType(row.component_type)) {
      report.skipped.push({ listingId: row.listing_id, componentType: row.component_type });
      continue;
    }
    const commit = normalizeListing({
      title: row.title,
      priceCents: row.price_cents,
      componentType: row.component_type,
    });
    report.reasons[commit.reason] = (report.reasons[commit.reason] ?? 0) + 1;
    if (commit.modelKey !== null) commitKeyed.add(row.listing_id);

    const kind = diffKind(row, commit);
    if (kind !== null) {
      report.diff.push({
        kind,
        listingId: row.listing_id,
        title: row.title,
        stored: { componentType: row.component_type, validity: row.validity, modelKey: row.model_key },
        commit: {
          componentType: commit.componentType,
          validity: commit.validity,
          modelKey: commit.modelKey,
          reason: commit.reason,
        },
      });
    }
    if (UNKEYED_COMPONENT_REASONS.has(commit.reason)) {
      report.unkeyedComponents.push({
        listingId: row.listing_id,
        componentType: commit.componentType,
        reason: commit.reason,
        priceCents: row.price_cents,
        title: row.title,
      });
    }
  }

  report.keyedListingIds = { stored: storedKeyed.size, commit: commitKeyed.size };
  const order: DiffKind[] = ["gains key", "changes key", "loses key", "changes validity or type"];
  report.diff.sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.title.localeCompare(b.title),
  );
  report.unkeyedComponents.sort(
    (a, b) =>
      a.componentType.localeCompare(b.componentType) ||
      a.reason.localeCompare(b.reason) ||
      a.title.localeCompare(b.title),
  );
  return report;
};

/** One line per title: line breaks inside a seller's title would otherwise split a row. */
const oneLine = (title: string): string => JSON.stringify(title);

const price = (cents: number | null): string => (cents === null ? "no price" : `CA$${(cents / 100).toFixed(2)}`);

const side = (state: { componentType: string; validity: string; modelKey: string | null }): string =>
  `${state.componentType} ${state.validity} ${state.modelKey ?? "-"}`;

export const formatReport = (report: ReplayReport): string => {
  const lines: string[] = [];
  lines.push(`rows replayed: ${report.rows - report.skipped.length} of ${report.rows}`);
  for (const skip of report.skipped) {
    lines.push(`  SKIPPED ${skip.listingId}: component_type ${JSON.stringify(skip.componentType)} is not one of the nine`);
  }

  lines.push("", "(a) reasons at this commit");
  for (const [reason, count] of Object.entries(report.reasons).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${reason.padEnd(22)} ${count}`);
  }

  lines.push(
    "",
    "(b) yield: distinct listing_ids carrying a model key",
    `  stored ${report.keyedListingIds.stored}`,
    `  commit ${report.keyedListingIds.commit}`,
  );

  lines.push("", `(c) stored vs this commit: ${report.diff.length} rows differ -- HAND-CHECK EVERY GAINED KEY`);
  for (const row of report.diff) {
    lines.push(
      `  ${row.kind.toUpperCase()}  ${row.listingId}  ${side(row.stored)}  ->  ${side(row.commit)} (${row.commit.reason})`,
      `      ${oneLine(row.title)}`,
    );
  }

  lines.push("", `(d) unkeyed components: ${report.unkeyedComponents.length} -- catalog candidates to hand-label`);
  for (const row of report.unkeyedComponents) {
    lines.push(
      `  ${row.componentType.padEnd(11)} ${row.reason.padEnd(21)} ${price(row.priceCents).padEnd(12)} ${oneLine(row.title)}`,
    );
  }
  return `${lines.join("\n")}\n`;
};
