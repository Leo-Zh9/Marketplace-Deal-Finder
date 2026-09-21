# Phase 3E-b — the run lock, the monitoring Cron, the Monitoring Workflow and run telemetry

3E-a shipped the daily cleanup Cron and the `search_settings` / `search_revisions` pair. 3E-b
is the other half: the `*/30 * * * *` Cron, `monitor_lock`, the Monitoring Workflow and the
`monitor_runs` log.

**What this PR actually changes about the system.** Before it, `cleanupStaleObservations` (via
`runCleanup`) was the only merged function with a non-test caller. Everything in
`worker/storage/` and `worker/evaluation/` was dead code in production. This gives
`loadCurrentSettings` and `evaluateBatch` their first production callers — and it is the first
time anything scheduled can write to `listings` or `evaluation_tasks`.

Collection (spec steps 3–4) is **parked**. It is a declared seam, `worker/scheduling/collection.ts`,
and the loop that will drive it already exists and already runs — over an empty array.

## The spec's seven steps, and where each one is

| Spec step | Where |
|---|---|
| 1. Acquire run lock | `monitorLock.ts`, `ACQUIRE_LOCK` |
| 2. Load current search revision / settings | `search/settings.ts`, `loadCurrentSettings` |
| 3. Bootstrap the source once | **parked** — `collection.ts` |
| 4. For each component: retrieve / normalize / persist / aggregate / queue | **parked** — `collection.ts` |
| 5. Drain evaluation tasks | `runMonitor.ts`, `discoverSources` + `evaluateBatch` |
| 6. Finalize run | `monitorRuns.ts`, `recordMonitorRun` |
| 7. Release lock | `monitorLock.ts`, `releaseStatement` — in the SAME `db.batch` as step 6 |

## The lock

`monitor_lock` is a singleton row with `CHECK (id = 1)`. The fencing token is
**`event.instanceId`** — the platform's, not the payload's. It is stable across a step retry and
an instance replay, which is what makes acquisition re-entrant for a run's own retries, and a
hand-written `wrangler workflows trigger` gets its own fresh id rather than a chance to choose
one.

**A crashed run is freed by the lease and by nothing else.** There is no supervisor and no
alerting until Phase 4. `ACQUIRE_LOCK`'s predicate is `expires_at <= ?now`, so the ceiling is
**inclusive**: a crashed run holding a lease of exactly the Cron period is still displaced by the
next fire. Measured, crashed at `T`, next fire at `T+1800`:

| lease | next fire acquires? |
|---|---|
| 900 | yes |
| 1500 | yes |
| 1799 | yes |
| **1800** | **yes** |
| **1801** | **no** |
| 2000 | no |

The whole interval `(0, 1800]` costs **zero skipped fires**, so `MONITOR_LOCK_SECONDS = 1500`
takes the headroom with 300 s of cushion rather than depending on hitting the boundary exactly.
The cushion is not decorative: **`now` is `controller.scheduledTime`, so cron delivery delay is
subtracted from the lease** — a run delivered five minutes late is protected for 1,200 s.

**`LOCK_HELD` carries no expiry term, on purpose.** `now` is frozen for the whole run and a
run's own `expires_at` is `now + lockSeconds` with `lockSeconds >= 1`, so the term would be
unreachable by construction — and it would be *wrong*: a run whose lease lapsed but whose lock
nobody has taken would discard its work over a contention that never happened. The lease is
enforced at `ACQUIRE_LOCK`, where the contender's `now` is a later instant, and nowhere else.

**The lock is advisory.** `monitorLockHeld` and the work that follows it are two D1 round trips
with a real window between them, and `step.do` guarantees at-most-once, not indivisibility. It
bounds wasted work and gives `LOCK_LOST` somewhere to be reported. The only atomicity primitive
is a single `db.batch`. The drain does not need the lock for correctness at all —
`evaluateBatch` fences every completion on a per-claim `lease_token` and its claim is one atomic
`UPDATE … RETURNING`, so two concurrent drains claim disjoint sets.

## No settings is a first-class state, not an error

`search_settings` is **empty in production** and there is no endpoint to create a revision until
Phase 5. `loadCurrentSettings` therefore returns `null`, and a run that throws on it is a silent
failure every 30 minutes.

The run records `status: 'NO_SETTINGS'`, releases, and **does not default to revision 0**.
Defaulting only bites later: a drain under a fabricated revision 0, followed by an operator
bootstrapping their own revision 0, leaves every task it touched `COMPLETE` at the current
revision — ineligible under all four claim tiers, carrying a verdict computed from settings
nobody chose, and unrecoverable without a manual revision bump.

## The drain

**Sources are discovered from `evaluation_tasks` itself**, which is self-bootstrapping: a source
exists exactly when it has tasks. No config and no literal, so nothing here is source-specific.

Discovery is a seek loop (`MIN(source)`, then `MIN(source) WHERE source > ?`), not
`SELECT DISTINCT source`. Measured:

| fixture | `SELECT DISTINCT source` | seek loop |
|---|---|---|
| 1 source × 20,000 tasks | 20,000 rows read | 2 rows / 2 statements |
| 3 sources × 5,000 tasks | 15,000 rows read | 4 rows / 4 statements |
| empty table | 1 | 1 row / 1 statement |

Flat in table size versus linear — at 48 runs/day over 20,000 tasks, `DISTINCT` would cost
960,000 rows read per day to learn one source name.

**The budget.**

```
DRAIN_STEPS            = 3
BATCHES_PER_DRAIN_STEP = 2                                    ->  6 batches x 15 = 90 tasks/run
MAX_DRAIN_SOURCES      = DRAIN_STEPS * BATCHES_PER_DRAIN_STEP ->  6
```

`MAX_DRAIN_SOURCES` is **derived, not chosen**. With the cap equal to the batch budget,
`sources.length <= MAX_DRAIN_SOURCES <= totalBatches`, so every discovered source receives at
least one batch. That is arithmetic and it cannot be violated, which is why there is no
assertion beside it. Starvation is therefore unreachable in production **by construction**, and
reachable only through the test-only `maxSources` option — where it is reported **by report**,
as `undrainedSources`. Beyond the cap, `sources_truncated` and the overflow name say the list
was incomplete.

**Why more than one batch per step, when `runCleanup` pins `BATCHES_PER_STEP = 1`.** Cleanup's
granule cost is unbounded — superlinear in the stale set, 443,301 rows for one 25-group batch —
so a budget checked at a coarser granule bounds nothing. The drain's granule is bounded and
flat: 141 rows for the tiered claim at 200, 5,000 and 20,000 eligible alike, and a full 15-task
batch measures 150 read / 120 written, a partial 121/80, an empty-queue batch 14/0 — the read
figure moving with **how many claim tiers run** (measured: 135 when tier 1 alone fills the batch,
146 across all four), not with fixture size, and the writes being exactly 120 in every fixture
measured. The writes are the side that binds. **A bounded
granule is safe to multiply.** That asymmetry is the whole justification and is the first thing
to re-check if either constant moves.

**The write allowance is what binds, not the read allowance.** `rows_written` includes index
entries, so 120 written for 15 completions is 8 per task:

```
worst case per run = 6 x (15 x 8)  =    720 rows written
per day (48 runs)                  = 34,560          ->  34.6% of D1's 100,000/day
```

and it is why `DRAIN_STEPS` is 3 and not 4: at 8 batches/run that is 46,080/day, and collection
has not spent anything yet. The worst case is the **steady state**, not an outlier — tier 3
(`NEEDS_REVIEW`) is unconditionally eligible on every call by design.

**The lease token carries a fresh UUID per claim:**
`${runId}:${stepIndex}:${batchIndex}:${crypto.randomUUID()}`.

3D's fence is a contract about freshness **per claim**, not per run, and `MONITOR_STEP_CONFIG`
retries once — so a drain step body executes **twice at the same step and batch index**. Without
the UUID both mint an identical token, and measured on one fixture with a requeue between the
two claims: the **stale** completion applies (`changes: 1`), the fresh one is discarded
(`changes: 0`), `NOT_DEAL` is stored where `DEAL` was computed, and the row becomes a fixed
point — `COMPLETE` at the current revision, ineligible under all four tiers. That is 3D's exact
bug one layer up. The prefix earns its place separately: a stranded `PROCESSING` row names the
run, step and batch that stranded it.

**Failure policy.**

| situation | response |
|---|---|
| `discarded` entries (the fence rejected a completion) | **not a failure.** Counted into `discardedCount`; the run continues. Throwing would retry the step and re-claim for nothing |
| `reason === 'evaluation-error'` (a per-candidate `decide` throw, caught inside `evaluateBatch`) | the task completes as `COMPLETE` / verdict `NEEDS_REVIEW`; counted into **`monitor_runs.evaluation_error_count`**. It does **not** move `status`, so no `console.warn` fires for it and the instance output expires — the column is the only durable evidence a `decide` bug leaves |
| `evaluateBatch` itself throws | the step body throws and the platform retries. Claimed rows are stranded `PROCESSING` and are recovered **at the next fire**, not inside this run — `now` is frozen, so tier 2's `lease_expires_at <= now` cannot match a lease this run just wrote |
| retries exhausted | caught at the orchestrator: `stepFailures += 1`, the message is recorded, the drain stops, status `DEGRADED`, **and finalize still runs, so the lock is always released** |

There is no poison-task loop: `evaluateBatch` catches per-candidate failures internally, so the
only throws are D1-level or validation-level and neither is task-specific.

The drain stops for a source when a batch reports **`claimed === 0`** — the conjunction of all
four tiers. Note the asymmetry with `evaluateBatch`'s *internal* tier loop, which must never
break on a zero tier.

## Telemetry

One row per run in `monitor_runs`, written at finalize inside the same `db.batch` as the prune
and the fenced release. `MONITOR_RUN_RETENTION = 336` is 7 days × 48 runs, matching
`STALE_AFTER_SECONDS`. This PR creates the table, so bounding its growth is this PR's job —
unlike `listings` and `evaluation_tasks`, which still grow unbounded and are nobody's yet.

Three timestamps, not two: `scheduled_at` is `params.now`, `started_at` and `finished_at` are
wall clock captured inside the memoized step bodies. Without `scheduled_at` you cannot tell a
slow run from a late Cron — and the gap between them is also **the amount of lease the run had
already spent before it started**.

**`rows_read` / `rows_written` in the row exclude the finalize batch that writes it** — a
constant offset of about 5 read / 4 written. The value returned in the instance output includes
it. Nothing can record the cost of its own write.

`retry_count` is not recorded, for the reason 3E-a documented for `CleanupRun.usage`: a retried
step body's work never returns, so nothing inside the Workflow can count it. `step_failures` —
steps that exhausted their retries and were caught — is what is observable from inside;
`wrangler workflows instances describe` holds true per-step attempt counts. CPU is likewise not
captured: there is no CPU API inside a step body.

**There is no `CHECK` on `status`.** 0003 checks `mode` because a bad mode makes
`validateSettings` throw on every call; nothing branches on `monitor_runs.status`. The status set
will grow — the spec already names `SOURCE_EMPTY`, unreachable while collection is parked — and
SQLite can neither add nor drop a `CHECK` in place.

The queries an operator actually runs:

```sql
-- Is it healthy?
SELECT status, COUNT(*) AS runs, MAX(finished_at) AS latest
  FROM monitor_runs GROUP BY status ORDER BY runs DESC;

-- What did the last ten runs do?
SELECT run_id, status, sources, sources_truncated, claimed_count, evaluation_count,
       evaluation_error_count, discarded_count, batches, steps_used, step_failures,
       rows_read, rows_written, errors
  FROM monitor_runs ORDER BY run_seq DESC LIMIT 10;

-- Is `decide` throwing? A nonzero count is a CODE BUG and moves no status, so nothing else
-- in the system will tell you.
SELECT SUM(evaluation_error_count) AS decide_failures FROM monitor_runs;

-- Anything stranded mid-claim? The token names the run, step and batch that stranded it.
SELECT source, listing_id, lease_token FROM evaluation_tasks WHERE status = 'PROCESSING';
```

Every non-`OK` run also writes one `console.warn` line, as does any run whose source list was
truncated.

### The deferred `(market_key, model_key, variant_key)` index

**This PR's telemetry cannot produce the number that decides it, and this section says so
rather than implying it can.** That index removes the re-walk in `cleanupStaleObservations`,
whose cost is superlinear in the stale set of `price_observations` — and `price_observations`
has no production writer while collection is parked. So `monitor_runs.rows_read` will read as
the flat figures above and say nothing about a stale set that does not exist.

The number that decides it is `CleanupRun.usage.rowsRead` measured against a real
`price_observations` count: **cleanup's telemetry, not monitoring's.** The index is not added.

## Deploy runbook

**Order matters, and getting it wrong fails silently once every 30 minutes.**

```bash
# 1. Offline first: catches a Workflow class that is not exported from worker/index.ts,
#    a renamed class, and a malformed cron.
npx wrangler deploy --dry-run

# 2. Migration FIRST, against the real database. 0004 is additive: two CREATE TABLEs and
#    one seed INSERT, no ALTER, no DROP.
npm run db:migrate

# 3. Bootstrap revision 0 BEFORE enabling the cron, or every run records NO_SETTINGS.
#    There is no settings endpoint until Phase 5; this hand-written statement is the only
#    way to create a revision, and 0003's CHECKs are what stop it creating a bad one.
npx wrangler d1 execute marketplace-deal-finder-db --remote --command \
  "INSERT INTO search_revisions VALUES (0,'MAXIMUM_PRICE',NULL,60000,unixepoch()); \
   INSERT INTO search_settings VALUES (1,0);"

# 4. Only now the second trigger and the second binding.
npx wrangler deploy

# 5. Confirm within 30 minutes.
npx wrangler workflows instances list marketplace-deal-finder-monitor

# 6. 24 hours later. If LOCK_LOST appears, production step latency is eating the lease:
#    the remaining move is MONITOR_LOCK_SECONDS = 1800 exactly, and beyond that the design
#    is wrong rather than the constant.
npx wrangler d1 execute marketplace-deal-finder-db --remote --command \
  "SELECT status, COUNT(*) FROM monitor_runs GROUP BY status;"
```

## Reversibility — at 3am, fastest first

1. **Dashboard → Workers → Settings → Triggers → delete the `*/30 * * * *` entry.** Seconds, no
   deploy. The daily cleanup cron is a separate entry and is unaffected.

2. **The lock as its own kill switch.** No deploy, no dashboard — the only off-switch that works
   when the dashboard is the thing that is down:

   ```sql
   INSERT INTO monitor_lock (id, run_id, acquired_at, expires_at)
   VALUES (1, 'HOLD', unixepoch(), unixepoch() + 31536000)
   ON CONFLICT(id) DO UPDATE SET run_id='HOLD', acquired_at=excluded.acquired_at,
                                 expires_at=excluded.expires_at;
   ```

   Every subsequent run reports `SKIPPED_LOCKED` and mutates nothing but its own telemetry row.
   Undo: `UPDATE monitor_lock SET expires_at=0, run_id='' WHERE id=1;`

   **It is an UPSERT and not a bare `UPDATE`, and that is measured, not stylistic.** Against an
   empty `monitor_lock` a bare `UPDATE … WHERE id=1` reports `changes: 0`, leaves the table
   empty, and the next run acquires normally — and `wrangler d1 execute` does not print
   `changes`, so it reads as success. 0004 also **seeds** `(1, '', 0, 0)` so even the bare form
   works. Two independent fixes for one window; both are taken.

3. Remove `"*/30 * * * *"` from `wrangler.jsonc` and redeploy.

4. An instance in flight:
   `npx wrangler workflows instances terminate marketplace-deal-finder-monitor <id>`. The lock
   frees itself 1,500 s after that run acquired it; option 2 frees it now.

**Worst case against real production data.** A monitoring run writes `monitor_lock` (one row),
`monitor_runs` (one row plus the prune of its own table) and `evaluation_tasks` (claims and
completions). **`listings`, `price_observations` and `model_stats` are read only** —
`evaluateBatch`'s only writes are the four `CLAIM_*` statements and `COMPLETE_TASK`, all against
`evaluation_tasks`, and the candidate read is a `SELECT`. `listings.first_seen_at`, the one
irreversible loss in the system, is unreachable.

A wrong `now` cannot cause a deletion — the drain has no cutoff. It would set a wrong
`lease_expires_at`; a far-future value strands tasks until then and is blocked by the same two
guards `runCleanup` uses, and a far-past value is harmless because `evaluateBatch` computes
`leaseExpiresAt = now + leaseSeconds` from the same `now`.

Recovery from a corrupt telemetry table: `DELETE FROM monitor_runs;` — it drives nothing.

## Known risks

**The lease's LOWER bound has no behavioural consequence reachable from a cron fire.**
`ACQUIRE_LOCK`'s predicate is `expires_at <= ?now`, and every contender this system can produce
is a cron fire at `T + 1800k`, so for every lease in `[1, 1800]` the predicate is identically
true: 900 and 1500 are indistinguishable on every cron-reachable path. A redelivery and a step
retry carry the same `scheduledTime`, and `LOCK_HELD` has no expiry term, so a short lease never
self-aborts either. Separating them needs an off-schedule trigger the runbook does not teach.
**1500 is not safer than 900; 900 is dominated, not wrong** — only the UPPER bound has a
consequence, and that is what the measured table above pins.

**The one most likely to be wrong: production Workflow step wall-clock latency versus the
lease.** If Cloudflare queues steps for minutes, a run can still be alive when the next fire's
`now` passes `acquired_at + 1500`; the next run steals the lock and the first aborts at its next
fence check. Self-announcing and non-corrupting — the aborting run reports `LOCK_LOST` before
writing — and the pattern appears in `monitor_runs` within 30 minutes of deploy. Cron delivery
delay eats into the same margin.

**The 17:00 UTC collision.** `0 17 * * *` and `*/30 * * * *` both fire at 17:00, so cleanup and
monitoring run concurrently once a day. The fine-grained hazard is not constructible — the
candidate read is one statement and cleanup's mutation unit is one `db.batch`, and an
interleaving of claim → full cleanup → candidate read → completion produced identical reference
figures and an identical verdict. What is real is coarser: cleanup runs up to 32 steps, each its
own batch, so a drain can land between granules and see a half-swept market. That verdict is then
`COMPLETE` at the current revision and re-derivable only by a manual revision bump. **That is
3D's accepted design, not new risk from this PR**, and the spec pins both expressions so the
collision is named rather than avoided.

**`monitor_runs` fills with `NO_SETTINGS` until someone runs the bootstrap.** By design, bounded
by retention at 336 rows, and `previousStatus` makes it obvious from any single instance output.

**Two things this design does not claim.** `SOURCE_EMPTY` and a `degraded` collection outcome are
unreachable while `COLLECTION_STEPS` is empty — the status exists in the type and the branch
exists in the loop, but nothing in production can produce either yet. And two concurrent
`recordSightings` calls have not been verified safe; the lock is what makes the question moot
while collection is parked.
