// @vitest-environment node

/**
 * MIGRATION 0009 CHANGES NOTHING THE OWNER CAN SEE. A pre-0009 install (0001-0008) is seeded the way
 * production looks -- a saved DISCOUNT rule, a narrowed watch list with a kept broad search, listings
 * in the saved market AND in an old one, tasks judged by the REAL evaluateBatch, a SENT and a
 * CANCELLED notification -- and measured with FROZEN COPIES of the 9c5aac7 statements. Then 0009 is
 * applied, user 1 is claimed exactly as the runbook says, and the same questions are asked of the
 * new code:
 *
 *   - the Preview set, its order and every label, unfiltered and filtered, are identical;
 *   - the notify enqueue selects exactly the listings the old one did;
 *   - the SENT notification is never re-enqueued, even after a save re-opens alerts;
 *   - the watch list, the area, the rule and Start/Stop read back identically;
 *   - the collector's watch list holds the same searches in the same market.
 */

import { createTestDatabase, MIGRATIONS, splitSqlStatements, type TestDatabase } from "../testing/d1";
import { evaluateBatch } from "../evaluation/evaluateBatch";
import { SELECTION_PREDICATE, handleGetVerdicts } from "../api/verdicts";
import { handleGetSettings } from "../api/settings";
import { handleGetWatch, invert, type StoredTarget } from "../api/watch";
import { handleGetWatchTargets } from "../api/watchTargets";
import { enqueueCandidates, freshnessCutoff, ENQUEUE_LIMIT, NOTIFY_RECENT_EVALUATION_SECONDS } from "../notify/enqueue";
import { readSelection, selectionFromTargets } from "../notify/selection";
import { areaMarketKey, loadUser } from "../users/users";
import { EVIDENCE_POOL_KEY } from "./marketKey";

const NOW = 1_800_000_000;
const SOURCE = "facebook-marketplace";
const SAVED = EVIDENCE_POOL_KEY; // the 0005 seed market, toronto / 25 km
const OLD = "43.4643,-80.5204|25km";
const OWNER = "owner@example.com";
const MODEL = "GeForce RTX 5080";

/** 9c5aac7 worker/api/verdicts.ts, verbatim. */
const OLD_BODY = `SELECT l.source, l.listing_id, l.component_type, l.model_key,
       l.variant_key, l.title, l.price_cents, l.location_text, l.url, l.last_seen_at,
       t.verdict AS verdict,
       CASE WHEN p.listing_id IS NULL THEN s.count
            ELSE s.count - 1 END                               AS reference_count,
       CASE WHEN p.listing_id IS NULL THEN s.total_price_cents
            ELSE s.total_price_cents - p.price_cents END        AS reference_total_cents
  FROM listings l
  LEFT JOIN evaluation_tasks t
         ON t.source = l.source AND t.listing_id = l.listing_id
  LEFT JOIN price_observations p
         ON p.source = l.source AND p.listing_id = l.listing_id
  LEFT JOIN model_stats s
         ON s.market_key  = COALESCE(p.market_key,  l.market_key)
        AND s.model_key   = COALESCE(p.model_key,   l.model_key)
        AND s.variant_key = COALESCE(p.variant_key, l.variant_key)
`;
const OLD_ORDER = ` ORDER BY CASE WHEN t.verdict IS NULL      THEN 2
               WHEN t.verdict = 'DEAL'     THEN 0
               WHEN t.verdict = 'NOT_DEAL' THEN 3
               ELSE 1 END,
          l.last_seen_at DESC, l.listing_id
 LIMIT ?1`;
const OLD_SELECT_VERDICTS = OLD_BODY + ` WHERE l.market_key = ?2` + OLD_ORDER;
const OLD_SELECT_VERDICTS_FILTERED =
  OLD_BODY + ` WHERE l.market_key = ?4 AND (${SELECTION_PREDICATE})` + OLD_ORDER;

/** 9c5aac7 worker/notify/enqueue.ts ENQUEUE's SELECT half, verbatim but for the INSERT. */
const OLD_ENQUEUE_SELECT = `SELECT l.listing_id
  FROM listings l
  JOIN evaluation_tasks t ON t.source = l.source AND t.listing_id = l.listing_id
  JOIN search_settings ss ON ss.id = 1
 WHERE l.validity = 'VALID'
   AND l.model_key IS NOT NULL
   AND t.status = 'COMPLETE'
   AND t.verdict = 'DEAL'
   AND t.evaluated_revision = ss.current_revision
   AND l.last_seen_at >= ?4
   AND l.market_key = ?7
   AND (${SELECTION_PREDICATE})
   AND t.evaluated_at >= ?6
   AND NOT EXISTS (SELECT 1 FROM notifications n
                    WHERE n.source = l.source AND n.listing_id = l.listing_id
                      AND n.status <> 'CANCELLED')
 ORDER BY t.evaluated_at DESC, l.listing_id
 LIMIT ?5`;

/** 9c5aac7 worker/api/verdicts.ts statusFor, verbatim: the label WAS the stored verdict. */
const statusFor = (verdict: string | null): string =>
  verdict === null
    ? "PENDING"
    : verdict === "DEAL"
      ? "DEAL"
      : verdict === "NOT_DEAL"
        ? "NOT_DEAL"
        : "NEEDS_REVIEW";

let database!: TestDatabase;
let db!: D1Database;

beforeAll(async () => {
  database = await createTestDatabase(MIGRATIONS.length - 1);
  db = database.db;
}, 120_000);

afterAll(async () => {
  await database.dispose();
});

/**
 * One sighting the way the pre-0009 recordSightings stored it: the listing in the market the
 * collector ran in, and -- for a contributing listing -- its observation and its share of the
 * aggregate in that same market.
 */
const listing = async (
  id: string,
  input: {
    market?: string;
    model?: string | null;
    type?: string;
    price?: number | null;
    validity?: string;
    lastSeenAt?: number;
  } = {},
) => {
  const market = input.market ?? SAVED;
  const model = input.model === undefined ? MODEL : input.model;
  const price = input.price === undefined ? 300_000 : input.price;
  const validity = input.validity ?? "VALID";
  await db
    .prepare(
      `INSERT INTO listings (source, listing_id, market_key, component_type, model_key, variant_key,
         title, price_cents, location_text, url, validity, content_hash, first_seen_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?7, 'Toronto, ON', ?8, ?9, 'h', ?10, ?10)`,
    )
    .bind(
      SOURCE,
      id,
      market,
      input.type ?? "gpu",
      model,
      `title ${id}`,
      price,
      `https://www.facebook.com/marketplace/item/${id}`,
      validity,
      input.lastSeenAt ?? NOW - 600,
    )
    .run();
  if (validity === "VALID" && model !== null && price !== null && price > 0) {
    await db.batch([
      db
        .prepare(
          `INSERT INTO price_observations (source, listing_id, market_key, model_key, variant_key,
             price_cents, last_seen_at) VALUES (?1, ?2, ?3, ?4, '', ?5, ?6)`,
        )
        .bind(SOURCE, id, market, model, price, NOW - 600),
      db
        .prepare(
          `INSERT INTO model_stats (market_key, model_key, variant_key, count, total_price_cents)
           VALUES (?1, ?2, '', 1, ?3)
           ON CONFLICT (market_key, model_key, variant_key) DO UPDATE
             SET count = count + 1, total_price_cents = total_price_cents + excluded.total_price_cents`,
        )
        .bind(market, model, price),
    ]);
  }
  await db
    .prepare(
      "INSERT INTO evaluation_tasks (source, listing_id, status, created_at) VALUES (?1, ?2, 'PENDING', 1)",
    )
    .bind(SOURCE, id)
    .run();
};

const seedPreZeroZeroNine = async () => {
  // The saved rule: DISCOUNT 15 %, revision 4 (so 0009's evidence-rule step has nothing to bump).
  await db.batch([
    db.prepare(
      `INSERT INTO search_revisions (revision, mode, minimum_discount_percent, maximum_price_cents, created_at)
       VALUES (4, 'DISCOUNT', 15, NULL, 1)`,
    ),
    db.prepare("INSERT INTO search_settings (id, current_revision) VALUES (1, 4)"),
    // The watch list: gpu NARROWED to one model, which turns the seed's broad `gpu-toronto` into a
    // kept search; the seed's `cpu-toronto`; and a legacy `mobo-toronto`.
    db.prepare(
      `INSERT INTO watch_targets (target_id, component_type, query) VALUES
         ('gpu-geforce-rtx-5080', 'gpu', '${MODEL}'),
         ('mobo-toronto', 'motherboard', 'motherboard')`,
    ),
    db.prepare("UPDATE monitoring_state SET enabled = 1, changed_at = 1700000000 WHERE id = 1"),
  ]);

  // Six references at 300,000 in the saved market, the deals and non-deals among them.
  for (const [id, price] of [
    ["ref-1", 300_000],
    ["ref-2", 310_000],
    ["ref-3", 290_000],
    ["ref-4", 305_000],
    ["ref-5", 295_000],
    ["deal-sent", 200_000],
    ["deal-cancelled", 210_000],
    ["deal-new", 220_000],
    ["dear", 340_000],
  ] as const) {
    await listing(id, { price, lastSeenAt: NOW - 600 - price / 1000 });
  }
  await listing("thin", { model: "GeForce RTX 4070", price: 100_000 });
  await listing("invalid", { validity: "INVALID_REFERENCE", price: 150_000 });
  await listing("free", { price: 0 });
  await listing("no-model", { model: null, price: 50_000 });
  await listing("cpu-broad", { type: "cpu", model: "Ryzen 7 9800X3D", price: 40_000 });
  await listing("stale-deal", { price: 190_000, lastSeenAt: NOW - 30 * 86_400 });
  // In the OLD market: a deal there, never on the page and never alerted.
  for (let index = 0; index < 6; index += 1) {
    await listing(`old-${index}`, { market: OLD, price: index === 0 ? 100_000 : 300_000 });
  }

  // THE REAL DRAIN, under the saved rule, judges everything above.
  const report = await evaluateBatch(db, {
    source: SOURCE,
    settings: { mode: "DISCOUNT", minimumDiscountPercent: 15, maximumPriceCents: null, searchRevision: 4 },
    now: NOW - 1_000,
    batchSize: 98,
  });
  expect(report.claimed).toBe(21);

  // Collected after the drain: never judged, PENDING on both sides.
  await listing("pending", { price: 180_000, lastSeenAt: NOW - 60 });

  await db.batch([
    db
      .prepare(
        `INSERT INTO notifications (source, listing_id, model_key, status, created_at, updated_at,
           attempts, last_attempt_at, sent_price_cents, sent_at)
         VALUES (?1, 'deal-sent', ?2, 'SENT', 1, 1, 1, ?3, 200000, ?3)`,
      )
      .bind(SOURCE, MODEL, NOW - 2_000),
    db
      .prepare(
        `INSERT INTO notifications (source, listing_id, model_key, status, created_at, updated_at)
         VALUES (?1, 'deal-cancelled', ?2, 'CANCELLED', 1, 1)`,
      )
      .bind(SOURCE, MODEL),
  ]);
};

type Labelled = Array<[string, string]>;

const oldPreview = async (filtered: { all: string[]; pairs: string[] } | null): Promise<Labelled> => {
  const read =
    filtered === null
      ? await db.prepare(OLD_SELECT_VERDICTS).bind(51, SAVED).all<{ listing_id: string; verdict: string | null }>()
      : await db
          .prepare(OLD_SELECT_VERDICTS_FILTERED)
          .bind(51, JSON.stringify(filtered.all), JSON.stringify(filtered.pairs), SAVED)
          .all<{ listing_id: string; verdict: string | null }>();
  return read.results.map((row) => [row.listing_id, statusFor(row.verdict)]);
};

const query = (filtered: { all: string[]; pairs: string[] } | null) => {
  const params = new URLSearchParams();
  if (filtered !== null) {
    // The wire speaks catalog ids; these fixtures use only ids whose spelling is the same.
    params.set("all", JSON.stringify(filtered.all));
    params.set("pairs", JSON.stringify(filtered.pairs));
  }
  return params;
};

const applyZeroZeroNine = async () => {
  const sql = MIGRATIONS[MIGRATIONS.length - 1];
  await db.batch(splitSqlStatements(sql).map((statement) => db.prepare(statement)));
  // The runbook's claim, verbatim.
  await db.prepare(`UPDATE users SET email = '${OWNER}' WHERE user_id = 1 AND email IS NULL`).run();
};

describe("migration 0009 -- the owner sees no change", () => {
  it("M9: Preview, labels, alerts, watch list, rule and Start/Stop are identical across 0009", async () => {
    await seedPreZeroZeroNine();

    // ---- BEFORE, measured with the 9c5aac7 statements.
    const storedTargets = (
      await db.prepare("SELECT target_id, component_type, query FROM watch_targets ORDER BY target_id").all<{
        target_id: string;
        component_type: string;
        query: string;
      }>()
    ).results.map((row): StoredTarget => ({
      targetId: row.target_id,
      componentType: row.component_type,
      query: row.query,
    }));
    const selection = selectionFromTargets(storedTargets);
    const previewBefore = await oldPreview(null);
    const filteredBefore = await oldPreview(selection);
    const enqueueBefore = (
      await db
        .prepare(OLD_ENQUEUE_SELECT)
        .bind(
          NOW,
          JSON.stringify(selection.all),
          JSON.stringify(selection.pairs),
          freshnessCutoff(NOW),
          ENQUEUE_LIMIT,
          NOW - NOTIFY_RECENT_EVALUATION_SECONDS,
          SAVED,
        )
        .all<{ listing_id: string }>()
    ).results.map((row) => row.listing_id);
    const inverted = invert(storedTargets);
    const market = await db.prepare("SELECT * FROM watch_market WHERE id = 1").first<{
      location: string;
      latitude: number;
      longitude: number;
      radius_km: number;
    }>();

    // The fixture is live: something of every kind is on the page and alerting.
    expect(previewBefore.map(([, label]) => label)).toEqual(
      expect.arrayContaining(["DEAL", "NOT_DEAL", "NEEDS_REVIEW", "PENDING"]),
    );
    expect(enqueueBefore).toEqual(["deal-cancelled", "deal-new", "free"]);

    // ---- 0009.
    await applyZeroZeroNine();
    const owner = (await loadUser(db, 1))!;
    expect(owner.email).toBe(OWNER);

    // ---- AFTER: the Preview, unfiltered and filtered, same rows, same order, same labels.
    const after = async (filtered: { all: string[]; pairs: string[] } | null): Promise<Labelled> => {
      const result = await handleGetVerdicts(db, query(filtered), owner);
      if (!result.ok) throw new Error(result.code);
      return result.body.listings.map((row) => [row.listingId, row.evaluation.status]);
    };
    expect(await after(null)).toEqual(previewBefore);
    expect(await after(selection)).toEqual(filteredBefore);

    // ---- The selection the notify step reads is the same.
    expect(await readSelection(db, 1)).toEqual(selection);

    // ---- Alerts: the same listings are enqueued, and the SENT one is not among them.
    expect(await enqueueCandidates(db, NOW, selection, areaMarketKey(owner.area), 1)).toBe(
      enqueueBefore.length,
    );
    const pending = await db
      .prepare(
        "SELECT listing_id FROM user_notifications WHERE user_id = 1 AND status = 'PENDING' ORDER BY listing_id",
      )
      .all<{ listing_id: string }>();
    expect(pending.results.map((row) => row.listing_id)).toEqual([...enqueueBefore].sort());

    // ...and a save that RE-OPENS alerts still never re-enqueues the SENT row.
    await db.prepare("UPDATE users SET alerts_reopened_at = ?1 WHERE user_id = 1").bind(NOW).run();
    await enqueueCandidates(db, NOW, selection, areaMarketKey(owner.area), 1);
    const sent = await db
      .prepare("SELECT status, sent_price_cents FROM user_notifications WHERE listing_id = 'deal-sent'")
      .all();
    expect(sent.results).toEqual([{ status: "SENT", sent_price_cents: 200_000 }]);

    // ---- The watch list and the area.
    const watch = await handleGetWatch(db, owner);
    expect(watch).toEqual({
      ok: true,
      status: 200,
      body: {
        selection: {
          components: inverted.components,
          models: inverted.models,
          location: { slug: market!.location, latitude: market!.latitude, longitude: market!.longitude },
          radiusKm: market!.radius_km,
        },
        storedTargets,
        keptSearches: inverted.residue,
      },
    });

    // ---- The rule and Start/Stop.
    expect(handleGetSettings(owner)).toEqual({
      ok: true,
      status: 200,
      body: { settings: { mode: "DISCOUNT", minimumDiscountPercent: 15, maximumPriceCents: null } },
    });
    expect({ enabled: owner.monitoringEnabled, changedAt: owner.monitoringChangedAt }).toEqual({
      enabled: true,
      changedAt: 1_700_000_000,
    });

    // ---- The collector runs the same searches in the same market.
    const targets = await handleGetWatchTargets(db, {
      APP_ENV: "production",
      APPROVED_EMAILS: JSON.stringify([OWNER]),
    });
    if (!targets.ok) throw new Error(targets.code);
    expect(targets.body.monitoring).toBe("running");
    expect(targets.body.market).toEqual({
      location: market!.location,
      latitude: market!.latitude,
      longitude: market!.longitude,
      radiusKm: market!.radius_km,
    });
    expect(targets.body.targets.map((target) => `${target.componentType}:${target.query}`).sort()).toEqual(
      storedTargets.map((row) => `${row.componentType}:${row.query}`).sort(),
    );

    // ---- The evidence rule was already DISCOUNT: 0009 bumped nothing.
    const revisions = await db.prepare("SELECT revision FROM search_revisions").all();
    expect(revisions.results).toEqual([{ revision: 4 }]);
  });
});

describe("migration 0009 -- the evidence rule and the owner's rule", () => {
  /**
   * M9b. AN OWNER WHOSE RULE IS NOT DISCOUNT keeps that rule as THEIR rule, and the frozen evidence
   * rule gains ONE DISCOUNT revision at the owner's percent (0 when the mode had none).
   */
  it.each<[string, string, number | null, number | null, Record<string, unknown>, number]>([
    ["MAXIMUM_PRICE", "MAXIMUM_PRICE", null, 74_900, { mode: "MAXIMUM_PRICE", minimum_discount_bp: null, maximum_price_cents: 74_900 }, 0],
    ["BOTH", "BOTH", 23.5, 74_900, { mode: "BOTH", minimum_discount_bp: 2350, maximum_price_cents: 74_900 }, 23.5],
    ["DISCOUNT 4.35", "DISCOUNT", 4.35, null, { mode: "DISCOUNT", minimum_discount_bp: 435, maximum_price_cents: null }, -1],
  ])("M9b: a %s owner", async (_label, mode, percent, max, rule, bumpedPercent) => {
    const fresh = await createTestDatabase(MIGRATIONS.length - 1);
    try {
      await fresh.db.batch([
        fresh.db
          .prepare(
            `INSERT INTO search_revisions (revision, mode, minimum_discount_percent, maximum_price_cents, created_at)
             VALUES (2, ?1, ?2, ?3, 1)`,
          )
          .bind(mode, percent, max),
        fresh.db.prepare("INSERT INTO search_settings (id, current_revision) VALUES (1, 2)"),
      ]);
      await fresh.db.batch(
        splitSqlStatements(MIGRATIONS[MIGRATIONS.length - 1]).map((statement) => fresh.db.prepare(statement)),
      );
      expect(
        await fresh.db
          .prepare("SELECT mode, minimum_discount_bp, maximum_price_cents FROM users WHERE user_id = 1")
          .first(),
      ).toEqual(rule);
      const evidence = await fresh.db
        .prepare(
          `SELECT s.current_revision AS revision, r.mode, r.minimum_discount_percent AS percent
             FROM search_settings s JOIN search_revisions r ON r.revision = s.current_revision`,
        )
        .first();
      expect(evidence).toEqual(
        bumpedPercent === -1
          ? { revision: 2, mode: "DISCOUNT", percent: 4.35 }
          : { revision: 3, mode: "DISCOUNT", percent: bumpedPercent },
      );
    } finally {
      await fresh.dispose();
    }
  });
});
