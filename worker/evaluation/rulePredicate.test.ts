// @vitest-environment node

/**
 * THE PARITY PROPERTY between RULE_PREDICATE (SQL) and `decide` (JS), over the plan's cross product:
 *
 *   validity {VALID, INVALID_REFERENCE, NEEDS_REVIEW, '', 'valid'}
 *   P {NULL, 0, 1, rand, 1e8, 1e8+1, 12.5, ~MAX_SAFE/5, 99,999,800}
 *   C {NULL, -1, 0, 4, 5, rand, 1e5, 1e5+1, 6.5, 90,072,172}
 *   T {NULL, -1, 0, P*C-1, P*C, P*C+1, rand, 1.5, MAX_SAFE-1, 2^53}
 *
 * THE THREE VALUES PAST THE PLAN'S LIST ARE THE OVERFLOW PROBES that make the bounds killable:
 * P = 1801439850948192 with C = 5, and P = 99,999,800 with C = 90,072,172, put P*C*10000 at
 * ~9.007e19 -- past 2^63, where SQLite falls back to a double whose spacing (16384) exceeds the
 * 10000 that separates T = P*C-1 from a deal. MEASURED with sqlite: without the price bound
 * (first pair) or the count bound (second pair) those rows read DEAL in SQL and NOT_DEAL in
 * `decide`. Most neighbouring values round the other way, which is why these exact ones are
 * pinned. 2^53 is a total `decide` calls corrupt.
 *   every mode x bp {0, 1, 435, 4999, 10000} x max {0, P-1, P, P+1}; unused rule fields NULL.
 *
 * Asserted:
 *   1. RULE_PREDICATE true  =>  decide(...).verdict === "DEAL"      (never a false DEAL), everywhere.
 *   2. Inside the bounds (P <= 1e8, and C <= 1e5 when the discount leg runs) the two are EQUAL.
 *   3. NOT_DEAL_PREDICATE true  <=>  decide(...).verdict === "NOT_DEAL", inside the same bounds. It
 *      only sorts, and past them the overflow probes below flip it (measured), which is why its
 *      own comment claims the bounds and no more.
 *
 * The values go through a REAL D1 column with the INTEGER affinity the live columns have, and
 * `decide` is fed what D1 READS BACK -- so 12.5 and 6.5 stay REAL on both sides, as in production.
 */

import { decide, type ValidatedSettings } from "./dealRules";
import {
  NOT_DEAL_PREDICATE,
  RULE_MAX_PRICE_CENTS,
  RULE_MAX_REFERENCE_COUNT,
  RULE_PREDICATE,
} from "./rulePredicate";
import type { DealMode } from "./types";
import { createTestDatabase, type TestDatabase } from "../testing/d1";

let database!: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database.dispose();
});

/** A small deterministic generator, so a red run reproduces. */
const random = (() => {
  let state = 0x2545f491;
  return (limit: number) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state % limit;
  };
})();

type Value = number | string | null;

const literal = (value: Value): string =>
  value === null ? "NULL" : typeof value === "string" ? `'${value.replace(/'/g, "''")}'` : String(value);

interface Case {
  validity: string;
  price: number | null;
  count: number | null;
  total: number | null;
  mode: DealMode | null;
  bp: number | null;
  max: number | null;
}

const buildCases = (): Case[] => {
  const validities = ["VALID", "INVALID_REFERENCE", "NEEDS_REVIEW", "", "valid"];
  const prices: (number | null)[] = [null, 0, 1, 1 + random(400_000), 1e8, 1e8 + 1, 12.5, 1801439850948192, 99_999_800];
  const counts: (number | null)[] = [null, -1, 0, 4, 5, 6 + random(500), 1e5, 1e5 + 1, 6.5, 90_072_172];
  const bps = [0, 1, 435, 4999, 10000];
  const cases: Case[] = [];
  for (const validity of validities) {
    for (const price of prices) {
      const p = price === null ? null : Math.floor(price);
      const maxes = (p === null ? [0, 1] : [0, p - 1, p, p + 1]).filter((value) => value >= 0);
      for (const count of counts) {
        const product = price === null || count === null ? null : price * count;
        const totals: (number | null)[] = [
          null,
          -1,
          0,
          1 + random(50_000_000),
          1.5,
          Number.MAX_SAFE_INTEGER - 1,
          2 ** 53,
          ...(product === null ? [] : [product - 1, product, product + 1]),
        ];
        for (const total of totals) {
          for (const bp of bps) cases.push({ validity, price, count, total, mode: "DISCOUNT", bp, max: null });
          // NO RULE, with stale fields a hand-written UPDATE could leave behind: never a deal.
          cases.push({ validity, price, count, total, mode: null, bp: 0, max: 1e12 });
          for (const max of maxes) {
            cases.push({ validity, price, count, total, mode: "MAXIMUM_PRICE", bp: null, max });
            for (const bp of bps) cases.push({ validity, price, count, total, mode: "BOTH", bp, max });
          }
        }
      }
    }
  }
  return cases;
};

interface Row {
  id: number;
  validity: string;
  price_cents: number | null;
  mode: DealMode | null;
  minimum_discount_bp: number | null;
  maximum_price_cents: number | null;
  count: number | null;
  total_price_cents: number | null;
  deal: number | null;
  not_deal: number | null;
}

describe("RULE_PREDICATE parity with decide", () => {
  it("never a false DEAL; equal inside the bounds; NOT_DEAL_PREDICATE equal inside them too", async () => {
    const db = database.db;
    // INTEGER affinity on the numeric columns, exactly as listings / users / model_stats declare.
    await db
      .prepare(
        `CREATE TABLE parity (id INTEGER PRIMARY KEY, validity TEXT, price_cents INTEGER, mode TEXT,
           minimum_discount_bp INTEGER, maximum_price_cents INTEGER, count INTEGER,
           total_price_cents INTEGER)`,
      )
      .run();
    const cases = buildCases();
    for (let start = 0; start < cases.length; start += 400) {
      const values = cases
        .slice(start, start + 400)
        .map(
          (row, offset) =>
            `(${start + offset}, ${[row.validity, row.price, row.mode, row.bp, row.max, row.count, row.total]
              .map(literal)
              .join(", ")})`,
        )
        .join(", ");
      await db.prepare(`INSERT INTO parity VALUES ${values}`).run();
    }

    // The aliases the predicate names, as self-joins on the one fixture row; `p` is an absent
    // observation, so C and T are the aggregate's own columns.
    const read = await db
      .prepare(
        `SELECT l.id, l.validity, l.price_cents, u.mode, u.minimum_discount_bp, u.maximum_price_cents,
                s.count, s.total_price_cents,
                (${RULE_PREDICATE}) AS deal, (${NOT_DEAL_PREDICATE}) AS not_deal
           FROM parity l
           JOIN parity u ON u.id = l.id
           JOIN parity s ON s.id = l.id
           LEFT JOIN (SELECT NULL AS listing_id, NULL AS price_cents) p ON 1 = 1
          ORDER BY l.id`,
      )
      .all<Row>();
    expect(read.results).toHaveLength(cases.length);

    const failures: string[] = [];
    let deals = 0;
    let equalChecked = 0;
    for (const row of read.results) {
      if (row.mode === null) {
        if (row.deal === 1 || row.not_deal === 1) failures.push(`a rule-less row judged ${JSON.stringify(row)}`);
        continue;
      }
      const settings: ValidatedSettings = {
        mode: row.mode,
        basisPoints: row.minimum_discount_bp,
        maximumPriceCents: row.maximum_price_cents,
        searchRevision: 0,
      };
      const verdict = decide(
        {
          candidatePriceCents: row.price_cents,
          validity: row.validity,
          referenceCount: row.count,
          referenceTotalCents: row.total_price_cents,
        },
        settings,
      ).verdict;
      const sqlDeal = row.deal === 1;
      const sqlNotDeal = row.not_deal === 1;
      const label = JSON.stringify(row);
      if (sqlDeal) deals += 1;
      if (sqlDeal && verdict !== "DEAL") failures.push(`false DEAL ${label} decide=${verdict}`);
      const inBounds =
        row.price_cents !== null &&
        row.price_cents <= RULE_MAX_PRICE_CENTS &&
        (row.mode === "MAXIMUM_PRICE" || (row.count !== null && row.count <= RULE_MAX_REFERENCE_COUNT));
      if (inBounds) {
        equalChecked += 1;
        if (verdict === "DEAL" && !sqlDeal) failures.push(`missed DEAL ${label}`);
        if (sqlNotDeal !== (verdict === "NOT_DEAL")) {
          failures.push(`NOT_DEAL mismatch ${label} decide=${verdict} sql=${String(row.not_deal)}`);
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
    // Anchors: the grid is the plan's, and both halves of the property are exercised.
    expect(cases.length).toBeGreaterThan(50_000);
    expect(deals).toBeGreaterThan(1_000);
    expect(equalChecked).toBeGreaterThan(10_000);
  }, 120_000);
});
