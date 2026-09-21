# Phase 3C — D1 storage: migrations, drift detection, rebuilds

The storage layer lives in `worker/storage/`. It consumes the normalized `Listing`
contract and nothing else: there is no provider, no HTTP client and no source name
anywhere in the schema or the logic. `source` and `validity` are opaque values the
caller supplies.

## Applying migrations

Migration files live in `migrations/` and are applied with wrangler's own migration
runner, which uses a quote- and comment-aware splitter — so a pretty-printed file is
fine. (`db.exec()` is not: it splits on newlines and cannot handle a multi-line
`CREATE TABLE`. The test seam applies the schema with `db.batch()` for the same
reason.)

```bash
npm run db:migrate:local   # .wrangler/state, offline, safe to repeat
npm run db:migrate         # --remote: writes to the real database
```

`db:migrate:local` against `0001_initial_storage.sql` reports
`6 commands executed successfully` (five statements in the file plus wrangler's own
`d1_migrations` bookkeeping insert).

Tests never touch either: `worker/testing/d1.ts` boots a Miniflare-backed D1 and
applies the same migration file via a `?raw` import, so the file stays the single
source of truth and the suite runs with no network.

## Why `variant_key` is `TEXT NOT NULL` with an `''` sentinel

`Listing.variantKey` is `string | null`, but a NULL must never reach the database. In
SQLite a NULL key column does not deduplicate in a unique index, `ON CONFLICT` never
fires on it, and `WHERE variant_key = ?` bound to NULL matches **zero rows** — which
is the write path's correlated `EXISTS` and both of cleanup's subqueries. The
aggregate arithmetic would silently skip every variant-less listing while reporting
success. `normalizeVariantKey` applies the sentinel at exactly one place on the way
in, and `NOT NULL` on all three tables makes the mistake throw instead of corrupt.

## Detecting aggregate drift

`model_stats` is a pure function of `price_observations`. This query returns the
groups where they disagree; it should return nothing.

```sql
-- Absence on either side counts as (0, 0), so a count = 0 orphan between a
-- write-path removal and the next cleanup sweep is not a false positive.
SELECT COALESCE(s.market_key, o.market_key)   AS market_key,
       COALESCE(s.model_key,  o.model_key)    AS model_key,
       COALESCE(s.variant_key,o.variant_key)  AS variant_key,
       COALESCE(s.count, 0)                   AS stats_count,
       COALESCE(o.c, 0)                       AS actual_count,
       COALESCE(s.total_price_cents, 0)       AS stats_total,
       COALESCE(o.s, 0)                       AS actual_total
  FROM model_stats s
  FULL OUTER JOIN (SELECT market_key, model_key, variant_key,
                          COUNT(*) c, SUM(price_cents) s
                     FROM price_observations
                    GROUP BY market_key, model_key, variant_key) o
    USING (market_key, model_key, variant_key)
 WHERE COALESCE(s.count, 0) <> COALESCE(o.c, 0)
    OR COALESCE(s.total_price_cents, 0) <> COALESCE(o.s, 0);
```

There is no alerting; alerting is Phase 4. Three layers catch drift today: the
`model_stats` CHECK constraints throw at write time and roll the batch back, the
consistency-property test catches arithmetic drift at preflight, and this query is
the operational check.

## Rebuilding `model_stats`

Fully recoverable. **Both statements go in ONE `db.batch()`** — D1 rejects
`BEGIN TRANSACTION` and `SAVEPOINT`, so a batch is the only transaction available.

```sql
DELETE FROM model_stats;
INSERT INTO model_stats (market_key, model_key, variant_key, count, total_price_cents)
SELECT market_key, model_key, variant_key, COUNT(*), SUM(price_cents)
  FROM price_observations
 GROUP BY market_key, model_key, variant_key;
```

No recovery code ships: the recovery is two SQL statements.

## Rebuilding `price_observations`

Rebuildable from `listings`, which is exactly why `listings.market_key` is a column.

```sql
-- The last_seen_at filter is MANDATORY. Without it this resurrects every listing ever
-- seen, including every one cleanup deliberately expired. Omitting it does not repair
-- the aggregate, it corrupts it.
INSERT INTO price_observations
       (source, listing_id, market_key, model_key, variant_key, price_cents, last_seen_at)
SELECT source, listing_id, market_key, model_key, variant_key, price_cents, last_seen_at
  FROM listings
 WHERE price_cents IS NOT NULL
   AND model_key   IS NOT NULL
   AND validity    = 'VALID'
   AND last_seen_at >= :now - 7 * 86400;      -- NOT OPTIONAL
```

Then rebuild `model_stats` from it.

`listings` itself is **not** rebuildable. The population refills over subsequent
scans, but `first_seen_at` is permanently lost for existing rows. That is the one
irreversible loss, and it is why `listings` carries the composite
`(source, listing_id)` primary key now rather than later: SQLite cannot `ALTER` a
primary key, so adding `source` after rows exist means create-copy-drop-rename.

## The write budget

D1 Free allows 100,000 row writes/day. An unchanged listing's `last_seen_at` is
refreshed only when the persisted value is at least `HEARTBEAT_SECONDS` (6 hours)
old, and the suppression lives in the `WHERE` clause rather than a JavaScript `if`,
so a caller cannot bypass it and its effect shows up in D1's own accounting.

| Path | rows written |
|---|---|
| NEW, first listing in its model group | 9 |
| NEW, group already exists | 8 |
| Contribution change (price, market, model, variant) | 6 |
| UNCHANGED, inside the heartbeat window | 0 |
| UNCHANGED, heartbeat due | 3 |

At 48 scans/day that is 12 rows/listing/day instead of 144 — a ceiling of ~8,300
tracked listings rather than ~700. At N = 3,000 steady state costs 36,000 rows/day,
36% of the budget.

### What cleanup costs, for 3E to budget against

Cleanup is the single largest burst, and its **read** cost is the part that surprises.
`CLEAN_A`'s two subqueries and `CLEAN_B` all filter on
`(market_key, model_key, variant_key, last_seen_at)`, and the only index is on
`last_seen_at` alone — so each group re-walks the expired range.

| Scenario | groups | batches | rows read | rows written |
|---|---|---|---|---|
| Steady state (2,900 live / 100 stale) | 100 | 4 | 16,009 | 200 |
| Mass expiry (0 live / 3,000 stale) | 200 | 8 | **921,409** | 3,400 |

That worst case is ~18% of the 5,000,000/day read budget in a single call. It is bounded
by `maxBatches`, so it cannot run away, and `remaining: true` tells 3E to resume. Adding a
`(market_key, model_key, variant_key)` index would cut it, at the cost of one more row
written per observation insert — deliberately not taken here, because the budget does not
need it and `CREATE INDEX` is a cheap migration when 3D or 3E shows it does.

These counts were measured against the local workerd D1. It is the same code path as
production, but **re-measure against the real database once 3E turns on scheduling**:
`recordSightings` and `cleanupStaleObservations` both return
`usage: { rowsRead, rowsWritten }` summed from D1's `meta`, so that re-measurement is
a read of a report.
