# Multi-user (migrations/0009)

Up to `MAX_USERS = 3` approved people share one deployment. Each has their **own** area (any catalog
location and radius), searches, deal rule and Start/Stop. Areas may overlap. Per-user Discord
webhooks and the round-robin notify loop are PR3; until then alerts go to the owner only, through
`DISCORD_WEBHOOK_URL`, exactly as before.

## Users

- A user is an email on the `APPROVED_EMAILS` secret. The `users` row is created on that person's
  first authenticated request (`worker/users/users.ts`). There is no admin UI.
- **User 1 is the existing install.** 0009 seeds it from `watch_market` (area), the rule in force
  (converted to basis points) and `monitoring_state`, with **no email**. The operator claims it
  after migrating. Until then every browser route answers `503 OWNER_UNCLAIMED` rather than
  creating an empty user 2 for the owner's own sign-in.
- A new user starts **stopped**, with no area and no rule. A fourth person is
  `403 USER_LIMIT_REACHED`.
- **Active** = on the allowlist AND Started. The collector's watch list, the monitoring run's
  `STOPPED` and the notify step all use that one definition. An unusable allowlist **throws**:
  `/api/watch-targets` answers 503 `AUTH_CONFIG_*`, a monitoring run records `DEGRADED`. It never
  reads as "nobody is active".

### Local development: a second identity

Under `APP_ENV=local` on a loopback host only, `X-Local-User: <name>` (`[a-z0-9-]{1,20}`) makes the
request `<name>@localhost`, and `@localhost` users count as approved. In the dev dashboard, open
`http://localhost:5173/?as=alice` to make that tab alice (stored in `sessionStorage`); `?as=` with
no value returns to the default `local-dev@localhost`. A production build never sends the header
and a production Worker never reads it.

A fresh local database needs the owner claimed once, like production:

```sh
npx wrangler d1 execute marketplace-deal-finder-db --local \
  --command "UPDATE users SET email = 'local-dev@localhost' WHERE user_id = 1 AND email IS NULL"
```

## One evidence pool, area membership

- `recordSightings` binds the constant `EVIDENCE_POOL_KEY` (`43.6532,-79.3832|25km`, the owner's
  market when 0009 shipped) into the content hash, `price_observations`, `model_stats` and
  `listings.market_key`, **never the sighting's market**. `listings.market_key` therefore means
  "evidence pool", not "the market the collector ran in". Every stored hash, observation and
  aggregate stays byte-identical, and a listing seen from two overlapping areas is one listing with
  one contribution.
- **Consequence:** price averages pool across every user's area. All catalog locations are Ontario
  and CAD, which is what makes that acceptable.
- Which areas saw a listing is `listing_markets (market_key, source, listing_id, last_seen_at)`,
  keyed by `marketKey(envelope.market)` and written on every sighting path with the same heartbeat
  suppression as `HEARTBEAT_LISTING`. Nothing deletes from it.
- Preview, enqueue and re-check filter with
  `EXISTS (SELECT 1 FROM listing_markets m WHERE m.market_key = <the user's area key> ...)`.
  Freshness still reads `listings.last_seen_at`.

## Searches and the shared 9-search budget

- `user_watch_targets (user_id, target_id, component_type, query)`. The market is **derived** from
  the owning user's area, never stored per row.
- A search's identity is `(component_type, query, area market key)`. Two users with the same search
  in the same area share one Facebook request.
- **The cap is 9 distinct searches over every user's stored targets** (active or not), enforced
  atomically: the last statement of a save batch inserts a `0` into `watch_cap_guard`, whose
  `CHECK (ok = 1)` refuses it when the count is over 9, and D1 rolls the whole save back. The API
  answers `409 WATCH_BUDGET_FULL {used, maximum: 9, yours}`. An area change can turn a shared
  search into a distinct one and legitimately 409. Each user's own 9-target cap (400
  `WATCH_TARGETS_EXCEEDED`) is unchanged.
- `GET /api/watch-targets` returns the de-duplicated union of **active** users' searches. Every
  target carries its own `market`; its wire `targetId` is `${type}-${slug(query)}@${location}-${radius}`
  (suffixed `~2`, `~3`... on a slug collision), so the collector's per-target guard state follows
  one Facebook request. The top-level `market` is present only when every target shares one market,
  else `null` (an old collector then fails loudly). `monitoring: "stopped"` only when no user is
  active.

## Deal rules: shared evaluation, per-user rule

- `search_settings` / `search_revisions` are now a **frozen internal DISCOUNT evidence rule**. The
  drain still evaluates every listing once under it, which keeps `evaluation_tasks.status`
  meaningful (`NEEDS_REVIEW` = not enough market evidence yet). No API writes it.
- Each user's rule lives on `users` (`mode`, `minimum_discount_bp`, `maximum_price_cents`, with
  CHECKs mirroring `validateSettings`) and is applied at read and notify time by `RULE_PREDICATE`
  (`worker/evaluation/rulePredicate.ts`). `rulePredicate.test.ts` proves SQL true => `decide` DEAL
  everywhere, and equality inside its bounds (price <= $1M, comparables <= 100,000).
- Preview labels are `decide(...)` with the user's rule on the live aggregate; a never-judged
  listing stays `PENDING`. Sort: deal, everything else, pending, NOT_DEAL last.
- Every watch save and every real rule change stamps `users.alerts_reopened_at`. Enqueue admits a
  candidate judged in the last day **or** whose user re-opened alerts in the last day, so a
  loosened rule alerts the deals it newly qualifies. A SENT row is never re-enqueued.

## Notifications

`user_notifications` is 0007's table per user (`PRIMARY KEY (user_id, source, listing_id)`, same
state machine). In PR2 the notify step runs for user 1 only, sends to `DISCORD_WEBHOOK_URL`, and
does nothing (one user read) when user 1 is not active. `/api/status` counts the caller's own rows.

## Operator pre-flight (read-only, before deploying)

Run each against production with `wrangler d1 execute marketplace-deal-finder-db --remote --command "..."`:

```sql
-- 1. The saved market key must equal EVIDENCE_POOL_KEY: expect toronto, 43.6532, -79.3832, 25.
SELECT location, latitude, longitude, radius_km FROM watch_market WHERE id = 1;
-- 2. The rule in force. If mode is not DISCOUNT, 0009 adds ONE DISCOUNT revision and the drain
--    re-judges every task once (count them with 5).
SELECT r.revision, r.mode, r.minimum_discount_percent, r.maximum_price_cents
  FROM search_settings s JOIN search_revisions r ON r.revision = s.current_revision WHERE s.id = 1;
-- 3. 0009 writes one listing_markets row per listing.
SELECT COUNT(*) FROM listings;
-- 4. Every listing's market. Rows outside 43.6532,-79.3832|25km stay members of their old area only.
SELECT market_key, COUNT(*) FROM listings GROUP BY 1;
-- 5. Tasks a bump would re-open, and the watch list 0009 copies to user 1.
SELECT status, COUNT(*) FROM evaluation_tasks GROUP BY 1;
SELECT COUNT(*) FROM watch_targets;
SELECT status, COUNT(*) FROM notifications GROUP BY 1;
```

On the collector device: the guard state must hold no `refused:*` latch, because every target id
changes at deploy (`jq '.alarm | keys' ~/.marketplace-collector-state.json`).

## Deploy order

1. Deploy the PR1 collector on the device first (it reads `targets[i].market` and falls back to the
   top-level `market`; it is safe against the current Worker).
2. Hold the monitor lock for an hour:
   ```sql
   INSERT INTO monitor_lock (id, run_id, acquired_at, expires_at)
   VALUES (1, 'HOLD', unixepoch(), unixepoch() + 3600)
   ON CONFLICT(id) DO UPDATE SET run_id = 'HOLD', acquired_at = excluded.acquired_at,
                                 expires_at = excluded.expires_at;
   ```
3. Apply 0009: `npm run db:migrate`.
4. Claim user 1 (lowercase, exactly as Google returns it):
   `UPDATE users SET email = '<owner email>' WHERE user_id = 1 AND email IS NULL;`
5. Deploy the Worker.
6. Release the lock: `UPDATE monitor_lock SET expires_at = 0, run_id = '' WHERE id = 1;`

Steps 3 and 4 before step 5: the new Worker answers `OWNER_UNCLAIMED` until 4 is done.

## Rollback

1. `wrangler rollback` to the previous Worker.
2. If user 1's rule differs from the current `search_settings` revision, write it back as a new
   revision (percent = `minimum_discount_bp / 100`) and point `search_settings` at it.
3. Replace `watch_targets` with user 1's rows:
   `DELETE FROM watch_targets; INSERT INTO watch_targets (target_id, component_type, query) SELECT target_id, component_type, query FROM user_watch_targets WHERE user_id = 1;`
4. Set `monitoring_state` and `watch_market` from user 1:
   `UPDATE monitoring_state SET enabled = (SELECT monitoring_enabled FROM users WHERE user_id = 1), changed_at = (SELECT monitoring_changed_at FROM users WHERE user_id = 1) WHERE id = 1;`
   `UPDATE watch_market SET location = u.location, latitude = u.latitude, longitude = u.longitude, radius_km = u.radius_km FROM (SELECT * FROM users WHERE user_id = 1) u WHERE watch_market.id = 1;`
5. Upsert user 1's non-CANCELLED `user_notifications` back into `notifications` (same columns,
   `ON CONFLICT (source, listing_id) DO UPDATE` every column).
6. `NOTIFICATIONS` stays on. The 0009 tables stay; nothing reads them.
