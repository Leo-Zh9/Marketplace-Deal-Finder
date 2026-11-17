# Phase 4: Discord deal notifications (backend)

This phase adds a `notify` step to the monitor Workflow. It runs after the drain steps and posts each
qualifying DEAL to a Discord incoming webhook, at most once per listing. It also adds a
`notifications` field to `GET /api/status`, which is additive.

**It is inert until both switches are set.** With no `DISCORD_WEBHOOK_URL` secret, or with the
switch anywhere short of `NOTIFICATIONS=on`, the step makes no D1 query and no request, and
`/api/status` does not read the table.

Code: `worker/notify/`. Table: `migrations/0007_notifications.sql`. Tests: `worker/notify/*.test.ts`,
`worker/storage/schema.test.ts` (S-p1..S-p6), `worker/scheduling/runMonitor.test.ts` (R-n1, R-n2), and
the notification section of `scripts/e2e-local.sh`.

## Configuration and states

There are two inputs, and both are Worker secrets. Neither is declared in `wrangler.jsonc` `vars`,
because a var and a secret with the same name clash and the next deploy would overwrite the secret.

| Input | Meaning |
|---|---|
| `DISCORD_WEBHOOK_URL` | The destination. It is validated, and it is never logged or stored anywhere. |
| `NOTIFICATIONS` | Only the exact string `on` enables sending. Absent, `ON` and `true` all mean off. |

The URL must look like `https://<host>/api/webhooks/<digits>/<token>`, where the host is one of
`discord.com`, `discordapp.com`, `ptb.discord.com` or `canary.discord.com`. It may not carry a port,
credentials, a query or a fragment. When `APP_ENV` is `local` (and only then), the Worker also
accepts `http://127.0.0.1:<port>/...`, which is the e2e stub.

`notifications.state` is the first of these that applies:

| State | When | D1 work |
|---|---|---|
| `unconfigured` | No URL. | none |
| `invalid-url` | A URL that fails the rule above. | none |
| `off` | A valid URL, but `NOTIFICATIONS` is not `on`. | none |
| `webhook-rejected` | On, and the row with the latest `last_attempt_at` has `last_error LIKE 'webhook-rejected%'`. | status read |
| `on` | On otherwise. | status read |

**The inert paths do no D1 work.** In the first three states the step returns before its first
query, and `/api/status` returns `{state}` without touching the table. So a Worker deployed before
migration 0007 cannot degrade monitoring or make the status route fail. Counts
(`pending`, `sent24h`, `deliveryUnknown`, `failed`, `lastSentAt`) appear only for `on` and
`webhook-rejected`. `pending` includes SENDING (in flight), and `lastSentAt` is in epoch seconds.

**What `webhook-rejected` means.** The most recent answer Discord gave was 401, 403 or 404, and
nothing more than that.
- A later 2xx clears it, because it is newer.
- A cancel can't erase it, because cancels, sweeps and re-arms never write `last_attempt_at` or
  `last_error`.
- With nothing PENDING, nothing probes the webhook. The state therefore stays `webhook-rejected`
  until the next deal tests it, even if the webhook has since been fixed.
- Rows written in one step share the run's `now`, so ties are possible. A rejection stops the step,
  which makes the rejected row the last fetch of that step, so a tie resolves to the rejected row.

### On the dashboard

The Collection panel renders `notifications` as one line (`src/components/CollectionStatusPanel.tsx`):

| `notifications` | The panel reads |
|---|---|
| `unconfigured` | Discord alerts: not configured |
| `invalid-url` | Discord alerts: webhook URL invalid |
| `off` | Discord alerts: off (webhook ready) |
| `on` with counts | Discord alerts: on, N sent in the last 24 hours, M delivery unknown[, P pending][, F failed] |
| `on` with no counts (the Worker could not read the table) | Discord alerts: on (counts unavailable) |
| `webhook-rejected` | Discord alerts: webhook rejected, replace the secret. N sent in the last 24 hours, M delivery unknown[, P pending][, F failed] |
| present but malformed | Discord alerts: status unreadable |
| absent (an API Worker older than this backend) | no line; the rest of the panel renders as before |

`N` is `sent24h`, a rolling 24-hour window rather than a calendar day, and `M` is
`deliveryUnknown`. `P` (`pending`) and `F` (`failed`) are added only when they are above 0, so a
sender that has stalled or is being refused does not read like a quiet day. The counts appear only
for `on` and `webhook-rejected`. The client
(`src/services/marketplaceClient.ts`) checks the field separately from the rest of the status
body, so a malformed field costs this one line and never fails the status poll. It also rebuilds
the field from its checked parts, so nothing unchecked reaches the panel: an inert state is
`{state}` alone.

## The table

There is one row per listing, ever: `PRIMARY KEY (source, listing_id)`. PLAN.md §18 asks for
`UNIQUE(user, platform, listing_id)`. There is exactly one user (ARCHITECTURE.md §1), so the user
column is dropped and `source` serves as the platform. It is a normal rowid table, not WITHOUT
ROWID, because the claim addresses rows by `rowid` (schema test S-p3). The index on
`(status, next_attempt_at)` serves the claim. History is never pruned, as PLAN.md §6 requires.

## The state machine

```text
             enqueue (one INSERT ... SELECT per run)
                         |
                         v
   +---------------> PENDING <---------------------- 401/403/404 (not counted, stop step)
   |                     |    <---------------------- 429 (+1 attempt, wait retry_after, stop step)
   | re-arm              | claim (before any fetch)
   | (enqueue,           v
   |  only from      SENDING ---- re-check fails ----> CANCELLED --+
   |  CANCELLED)         |                                         |
   |                     | fetch                                   |
   |                     +---- 2xx ----------------------> SENT    |
   |                     +---- 400 / other 4xx / 3xx ----> FAILED  |
   |                     +---- 6th 429 ------------------> FAILED  |
   |                     +---- 5xx / timeout / network --> DELIVERY_UNKNOWN
   |                     +---- lease expired (next run's sweep) -> DELIVERY_UNKNOWN
   +---------------------------------------------------------------+
```

### The gate (enqueue)

A listing is a candidate only when every one of these holds (`CANDIDATE_PREDICATE`, which the
re-check uses word for word):

- The listing is `validity = 'VALID'` and has a non-null `model_key`. Under MAXIMUM_PRICE the drain
  marks an un-normalized CA$0 listing DEAL. That listing has no model, so this gate keeps it off
  Discord. It can still appear on the dashboard.
- Its task is `COMPLETE`, `verdict = 'DEAL'`, and was judged at the current `search_settings`
  revision.
- `listings.last_seen_at >= now - NOTIFY_FRESH_SECONDS`. That constant is `HEARTBEAT_SECONDS` (6 h)
  plus 1 h, because an unchanged listing refreshes `last_seen_at` at most once per heartbeat.
- The dashboard's selection includes it. The selection is the stored watch list run through the
  server's own `invert`, bound into the same `json_each` predicate as `GET /api/verdicts`, in storage
  ids (`case_fan`, not `case_fans`). A type watched without a catalog model means every model of
  that type. An empty watch list means nothing.
- It was collected in the saved market: `listings.market_key` equals the key `marketKey()` builds
  from the `watch_market` row (`readSavedMarketKey`, the same term `GET /api/verdicts` filters on).
  Nothing deletes from `listings`, so without this a fresh DEAL from the market the user just moved
  away from would still alert. No market row binds NULL, which matches nothing. At re-check, a
  claimed row whose market is no longer the saved one is cancelled (N-m).
- **Enqueue only:** the task was judged within the last day (`t.evaluated_at >= now -
  NOTIFY_RECENT_EVALUATION_SECONDS`, 86,400 s). This makes alerts "new deals from now on" rather
  than a dump of every fresh DEAL when sending is first turned on. It gates on the *judgment*, not
  on `listings.first_seen_at`. A price drop re-queues the task and the drain re-judges it, so a price
  drop on a listing first seen weeks ago still alerts, and a row cancelled by that price change
  still re-arms. A `first_seen_at` gate was measured to break that path (mutation R6 turns N8 red).
  A settings change re-judges every task, so deals under a new rule do alert. The cost: a row
  cancelled as stale or un-watched does not re-arm once its judgment is more than a day old. The
  same holds for a row cancelled because the saved market moved: if the user moves back to that
  market, the row does not re-arm once its judgment is more than a day old. The
  same holds for a DEAL judged while its type was not watched: if the user starts watching that
  type more than a day later, it never alerts, which matches "new deals from now on". The
  re-check does not apply this gate, so a row that waits longer than a day (for example, during a
  webhook outage) is still sent (N7d).
- No non-CANCELLED row exists for that listing. The `NOT EXISTS` runs before `LIMIT 20`, so already
  SENT deals can never fill the window and starve a new one.

**Only CANCELLED re-arms.** SENT is final, per PLAN.md §6. DELIVERY_UNKNOWN and FAILED wait for a
human. A re-armed row starts fresh, with attempts 0, no backoff and a new `created_at`.

### The send loop

Each step does at most 5 rows, one at a time:
1. Claim one due PENDING row. That is a single
   `UPDATE ... WHERE rowid = (SELECT ... LIMIT 1) RETURNING`, with a fresh lease token and a lease
   of `now + 600`.
2. Re-check it.
3. Fetch.
4. Write the result. The write is fenced on the rowid and the token.

If a result write throws, only that row stays SENDING. The rows behind it are still PENDING, and
the step's retry sends them.

**Re-check cancels, and never holds.** Any failure of the predicate means CANCELLED, with no fetch.
The causes are:
- the price changed, so the task was re-queued and is not COMPLETE
- the task is no longer a DEAL
- the revision moved
- the listing went stale
- it is no longer watched

A cancelled row comes back through the enqueue re-arm once the listing qualifies again. It then
sends at the price the drain just judged.

**Why a retried step can't resend.** The step retries once, with the same `now`. A row is SENDING
before its fetch. The retry's claim takes only PENDING rows, and its sweep takes only rows with
`lease_expires_at < now`, which for `now + 600` is false. So the retry cannot touch a row the first
execution left in flight. The next run (now + 1800) sweeps it to DELIVERY_UNKNOWN, never back to
PENDING. The notify step does not check the monitor lock, because the claim is what makes it safe.

## Failure table

| Discord answer | Row becomes | attempts | Step | Why |
|---|---|---|---|---|
| 2xx (`?wait=true`, so 200) | SENT; `sent_at`, `sent_price_cents` set; `last_error` cleared | +1 | continues | acknowledged |
| 429 | PENDING, `next_attempt_at = now + ceil(retry_after)` | +1 | **stops** | `retry_after` comes from the body (float seconds) or the `Retry-After` header. If unreadable it is 60 s, and it is capped at a day. |
| 429, sixth time for this arming | FAILED, `rate-limited:attempts-exhausted` | +1 | stops | bounded retries |
| any response with `X-RateLimit-Remaining: 0` | as its status says | | **stops** after recording | respects the bucket |
| 401 / 403 / 404 | PENDING, `last_error = webhook-rejected:<status>` | **unchanged** | **stops** | The webhook was deleted or its token is wrong, so the row is not at fault. This is one probe per run, at most 48 a day. |
| 400, other 4xx, 3xx | FAILED, `refused:<status>[:<discord code>]` | +1 | continues | This message was refused, and resending it would be refused again. Redirects are not followed. |
| 5xx | DELIVERY_UNKNOWN, `server-error:<status>` | +1 | **stops** | Discord may have posted it. A rare lost alert is better than a duplicate. |
| timeout (10 s) / network error | DELIVERY_UNKNOWN, `timeout` / `network-error` | +1 | **stops** | as for 5xx |
| run died between claim and result | DELIVERY_UNKNOWN (next run's sweep) | unchanged | | as for 5xx |

Every fetch outcome writes `last_attempt_at`.

**The message.** It is plain `content` of at most 2000 characters, with `flags: 4`
(SUPPRESS_EMBEDS) and `allowed_mentions: {parse: []}` on every request. It contains:
- the model and current price
- the deal rule
- the average and discount, recomputed from the current `model_stats` aggregate excluding the
  listing itself, and shown only at 5 or more references, as on the dashboard
- the reference count
- the market radius and location
- "last seen Xh ago"
- the title, cut to 200 characters
- the link

In the title and location, whitespace and newlines collapse to single spaces, every `://` gets a
zero-width space after its colon, and `` \ * _ ~ | > [ ] ( ) ` # `` are backslash-escaped. The
`://` break matters because Discord autolinks a bare `https://...` however it is escaped, and
`flags: 4` suppresses only the preview, not the link. After the break, the id-built listing link is
the only URL in the message (N14, N14b). **The link is built from `listing_id`**, in the
collector's `buildListingUrl` shape, and never from the stored `url`, which whoever holds the
collector token controls.

**Logging.** Each step logs exactly one counts-only line:
`notify state=on enqueued=1 sent=1 unknown=0 cancelled=0 failed=0 rate_limited=0 rejected=0 swept=0 unrecorded=0`.
It never includes the URL, a title or a token. The line includes `unrecorded=N`, the number of
result writes that changed 0 rows. Each of those also logs one
`notify result write changes=0 outcome=<kind>` warning (see the runbook).

**The webhook URL that is sent** is rebuilt from the validated parse (origin and path), never taken
from the raw secret. A secret ending in `?` or `#` passes validation, and sent raw it would become
`.../x??wait=true`, which Discord answers with 204.

## Workers Free budget

| Limit | Free | This step, worst case |
|---|---|---|
| CPU per invocation | 10 ms | p95 **0.195 ms** for a 5-row step (Node, capture-and-replay, `cpuClock`; N17) |
| D1 queries per invocation | 50 | **19**: sweep 1, watch-list read 1, saved-market read 1, enqueue 1, then 5 × (claim, re-check, result or cancel) |
| Subrequests per invocation | 50 | 5 fetches to Discord |
| Steps per instance | 1,024 | +1 (`notify`) |
| Discord POSTs per day | | 5 per run × 48 runs = 240 at most. A rejected webhook costs 1 probe per run. |

**Reads.** The enqueue scans every evaluation task once per run, because no index serves its
predicate. This has been measured twice:

| Fixture | Rows read at 500 / 2,000 / 10,000 tasks | Per run |
|---|---|---|
| Review's | 603 / 2,309 | about 1.15× the corpus |
| This PR's, after the evaluation gate (2 % DEALs) | 503 / 2,003 / 10,003 | about 1.0× the corpus |

Using the larger coefficient: **≈ 1.15 × corpus per run, ≈ 55 × corpus per day** (48 runs). At a
10,000-task corpus that is ≈ 0.55M reads a day, 11 % of D1 Free's 5M. Re-check this if the corpus
grows past about 50,000 tasks.

## Runbook

**Is it on?** Run `npx wrangler tail marketplace-deal-finder-api --format json` across one monitor
run, and look for the `notify state=...` line. `GET /api/status` → `notifications.state` says the
same thing.

**A DELIVERY_UNKNOWN row.** Look in the Discord channel first. If the message is there, do nothing.
If it is missing, resend it manually:

```sql
-- in /Users/leozhang/Marketplace-Deal-Finder:
-- npx wrangler d1 execute marketplace-deal-finder-db --remote --command "<this>"
UPDATE notifications SET status='PENDING' WHERE listing_id=?;
```

The next run re-checks the row and sends it if it still qualifies, or cancels it if it no longer
does.

**A DELIVERY_UNKNOWN row may have been delivered.** Besides 5xx, timeouts and lost runs, an
overlapping run can do this. If run B's sweep reaches a SENDING row while run A's fetch for it is
still in flight, the row becomes DELIVERY_UNKNOWN. A's fenced result write then matches nothing,
even if Discord accepted the message. This never causes a duplicate on its own. A's counts line
shows `unrecorded=1` and the warning `notify result write changes=0 outcome=sent`. This is why the
manual resend above always starts with checking the channel.

**List what needs a look:**
`SELECT listing_id, status, attempts, last_error, last_attempt_at FROM notifications WHERE status IN ('DELIVERY_UNKNOWN','FAILED') ORDER BY updated_at DESC;`

**`webhook-rejected`.** The webhook was deleted or its URL changed. Create a new webhook, run
`secret put` again with the new URL (below), and the next run's probe clears the state.

**Turn it off.** Run `npx wrangler secret delete NOTIFICATIONS --name marketplace-deal-finder-api`.
The step goes inert at the next run. Rows stay where they are, and PENDING rows send once the
switch is back on.

## Enable procedure

**Order matters:** migration 0007 must be applied before the Worker that contains this code is
deployed with the switch on. A deploy that lands first is harmless while the state is inert.

**The user does these steps** (the webhook URL is a credential, and creating it needs the user's
Discord account):

1. In Discord: Server Settings → Integrations → Webhooks → New Webhook → set a name and pick the
   channel → Copy Webhook URL → Save Changes. This click-path has not been verified against the
   current Discord UI. What matters is the end state: you hold a URL that looks like
   `https://discord.com/api/webhooks/<digits>/<token>`.
2. In `/Users/leozhang/Marketplace-Deal-Finder`, run
   `npx wrangler secret put DISCORD_WEBHOOK_URL --name marketplace-deal-finder-api` and paste the URL
   at the interactive prompt. Never pipe it.
3. Run `npx wrangler secret list --name marketplace-deal-finder-api`. `DISCORD_WEBHOOK_URL` should be
   listed.

**Always pass `--name`.** Run from another directory, wrangler targets a different Worker or
offers to create one, and still reports success.

The dashboard's Collection panel should then read **"Discord alerts: off (webhook ready)"**. The
`notify state=off` log line and `GET /api/status` say the same thing.

**The agent then enables sending.** It does this only once at least 10 models have
`model_stats.count >= 5` and at least one evidence verdict exists:

1. **Preview what the first runs would send.** This query is read-only. It is the enqueue predicate
   with the watch-list selection left out, so the count is an upper bound. `25200` is
   `NOTIFY_FRESH_SECONDS` and `86400` is `NOTIFY_RECENT_EVALUATION_SECONDS`. It reads the
   `notifications` table, so it fails with "no such table" until migration 0007 is applied. Run it
   in `/Users/leozhang/Marketplace-Deal-Finder`:

   ```sh
   npx wrangler d1 execute marketplace-deal-finder-db --remote --command "SELECT COUNT(*) AS would_enqueue FROM listings l JOIN evaluation_tasks t ON t.source = l.source AND t.listing_id = l.listing_id JOIN search_settings ss ON ss.id = 1 WHERE l.validity = 'VALID' AND l.model_key IS NOT NULL AND t.status = 'COMPLETE' AND t.verdict = 'DEAL' AND t.evaluated_revision = ss.current_revision AND l.last_seen_at >= CAST(strftime('%s','now') AS INTEGER) - 25200 AND t.evaluated_at >= CAST(strftime('%s','now') AS INTEGER) - 86400 AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.source = l.source AND n.listing_id = l.listing_id AND n.status <> 'CANCELLED')"
   ```

   The result is one row, `would_enqueue: N`. At most 20 are enqueued and 5 sent per run, so N
   alerts take about N / 5 runs (30 minutes each) to drain. If N is more than the user wants at
   once, stop and ask before going on. The query was checked against a local D1. Its remote output
   has the same shape.
2. Confirm that the user's `secret put` created a new deployment, with
   `npx wrangler deployments list --name marketplace-deal-finder-api`. Then confirm that the next
   `monitor_runs` row and the daily cleanup still land.
3. Run
   `printf on > <file> && npx wrangler secret put NOTIFICATIONS --name marketplace-deal-finder-api < <file> && rm <file>`.
   Use a file redirect, not a pipe.
4. Verify with `npx wrangler tail marketplace-deal-finder-api --format json` across one run, looking
   for the counts line with `state=on`.
5. Fallback: `npx wrangler deploy` from a clean `origin/master` worktree.
