# Phase 3E-a — the daily cleanup Cron, its Workflow, and search settings

3E-a is the half of Phase 3E that needs no data source: the `search_settings` /
`search_revisions` pair that 3C and 3D both deferred, and the daily Cron that drives
3C's `cleanupStaleObservations` through a Cloudflare Workflow. The monitoring Cron,
the Monitoring Workflow, `monitor_lock` and run telemetry are 3E-b's, and none of
them exists yet.

## The Cron is UTC, and "local noon" is not satisfiable

The spec asks for a run "once per day at noon", conceptually `0 12 * * *`, and says
deployment must translate the intended local noon correctly. **It cannot be
translated correctly, because Cloudflare Cron triggers are UTC with no timezone
field and no DST handling.** No fixed expression is local noon year-round.

```jsonc
"triggers": { "crons": ["0 17 * * *"] }
```

**The assumption, named as an assumption: the operator's local timezone is
America/Toronto.** The repository states no timezone anywhere — grep finds no
`timezone`, no `America/`, no `EST`, no `EDT`. The only signal is that
`Waterloo, ON` / `43.4643, -80.5204` is the product's example search location in
`PHASE_1_FRONTEND_PROTOTYPE.md` and `PHASE_5_FRONTEND_BACKEND_INTEGRATION.md`. That
is an inference. If it is wrong, the expression is a one-character change.

Pinned to EST (UTC−5), `0 17 * * *` fires at **12:00 local in winter and 13:00 local
in summer**. EST is chosen deliberately so the drift is always later, never earlier
into the morning.

**This is not an off-peak slot, and nothing in this design claims it is.** 12:00/13:00
local is the busiest hour available, and the run carries a burst of between 16,009
rows read (3C's measured steady state) and ~1.4M (the effective cap below). Nothing
about stale cleanup depends on the wall-clock hour — the requirement with real
semantics is *once per day at a fixed, predictable instant* — so if the burst should
land overnight instead, `0 7 * * *` is 02:00 local and is a one-character change.

## The granule, the budget, and the effective cap

`cleanupStaleObservations` is already bounded and idempotent: `CLEAN_A` and `CLEAN_B`
share one `db.batch` and one predicate, and the amounts are computed by subqueries at
execution time, so a re-run matches nothing and subtracts nothing. The Workflow adds
**bounding and continuation only** — it contributes nothing to correctness under retry.

Cost is superlinear in the size of the stale set, because only `last_seen_at` is
indexed and every group re-walks the expired range. Derived from 3C's measured
figures in `docs/phase-3c-storage.md`:

| Regime | rows read per group | one granule (≤ 25 groups) | effective cap |
|---|---|---|---|
| Steady state (100 stale / 200 groups) | ~160 | ~4,000 | ~1,004,000 |
| Mass expiry (3,000 stale / 200 groups) | ~4,600 | ~115,000 | ~1,115,000 |
| Mass expiry at 400 groups | ~16,600 | ~415,000 | ~1,415,000 |

**The two rows in `docs/phase-3c-storage.md`'s cleanup table are not the same shape
and must not be compared directly:** its steady-state row is one observation per
group, its mass-expiry row is fifteen. The per-group column above is the figure that
is comparable.

The constants live in `worker/scheduling/runCleanup.ts`:

```
GROUPS_PER_BATCH = 25        BATCHES_PER_STEP  = 1
MAX_STEPS        = 32        ROWS_READ_BUDGET  = 1,000,000
```

`BATCHES_PER_STEP = 1` is the point. The budget is checked **after** a step returns,
so the effective cap is always `budget + one granule` — and a granule whose own cost
is unbounded bounds nothing. At one batch per step, the overshoot is at most the
worst-case granule in the table above. Against D1's 5,000,000 reads/day this leaves
the daily cleanup at roughly 28% of the budget in its worst measured shape.

`MAX_STEPS = 32` caps a single instance at 800 groups. Hitting it is not data loss:
the rows stay stale, the run reports `stoppedBecause: "step-cap"` with
`remaining: true`, and tomorrow's Cron finishes them.

**The lever, if the granule turns out not to be enough:** a
`(market_key, model_key, variant_key)` index on `price_observations`, which removes
the re-walk entirely at the cost of one extra row written per observation insert. It
is **deliberately not taken in 3E-a**: nothing writes to `price_observations` in
production yet (3A/3B collection is parked), so the stale-set size its value depends
on cannot be measured. 3E-b's telemetry is what should decide it.

## Deploy runbook

**Order matters, and getting it wrong fails silently once a day.** If the cron is
deployed before the tables exist, every step throws `no such table`, burns its two
retries, errors the instance, and does it again tomorrow — with no alerting, because
alerting is Phase 4.

```bash
# 1. Check the config offline first: this catches a renamed Workflow class,
#    a class that is not exported from worker/index.ts, and a malformed cron.
npx wrangler deploy --dry-run

# 2. Migrations FIRST, against the real database.
npm run db:migrate          # applies 0001, 0002, 0003 -- wrangler skips applied ones

# 3. Only then the deploy that introduces the trigger and the Workflow binding.
npx wrangler deploy
```

`scheduled.test.ts` S3 already asserts offline that `wrangler.jsonc`'s cron matches
`CLEANUP_CRON` and that its `class_name` is a real export of `worker/index.ts`. The
dry run stays in this runbook because it additionally proves wrangler's own bundler
agrees with the config.

## Bootstrapping revision 0

**No migration seeds a settings row, and there is no HTTP endpoint for settings yet —
that is Phase 5.** A freshly migrated database therefore has
`loadCurrentSettings(db) → { settings: null }`, and **`null` settings is a state 3E-b's
evaluation drain must handle**, not an impossible one.

Until Phase 5 ships a form, the first revision is written by hand. The two statements
go in **one** `d1 execute` call so they land in one transaction: the foreign key
requires the revision row to exist before anything points at it, and the reverse order
raises `FOREIGN KEY constraint failed` and rolls the whole batch back.

```bash
npx wrangler d1 execute marketplace-deal-finder-db --remote --command "
INSERT INTO search_revisions (revision, mode, minimum_discount_percent, maximum_price_cents, created_at)
  VALUES (0, 'DISCOUNT', 20, NULL, unixepoch());
INSERT INTO search_settings (id, current_revision) VALUES (1, 0);
"
```

## What the revision log records, and what a settings form must know

`updateSearchSettings` validates with 3D's merged `validateSettings` **before any
write**, compares **projections** rather than raw input, and stores the **projection**.
So:

- `4.35` and `4.350000000000001` are the same 435 basis points and do not bump the
  revision; `4.36` does.
- `maximumPriceCents` is inert under `DISCOUNT`, so changing it there does not bump —
  it cannot alter a single verdict.
- The stored percent is the one that was *applied*: `4.356` is stored as `4.36`.

**For whoever builds the Phase 5 settings form:** a value that was inert when it was
saved is not in the row. After saving `DISCOUNT` with `maximumPriceCents: 50000`, both
the stored row and `loadCurrentSettings` hold `null` for it — so a form that
repopulates from the current settings and then switches the mode to `BOTH` starts from
an **empty** maximum-price field, not from 50000. That is the correct trade (the
revision log audits what was applied, not what was typed), but it has to be designed
around rather than discovered.

## Exactly one active search

`search_settings` carries `CHECK (id = 1)`. One active search is already a property of
the merged schema, not a new limitation: `price_observations` and `evaluation_tasks`
are both `PRIMARY KEY (source, listing_id)`, so one listing has one observation row
carrying one `market_key` and one task row carrying one `evaluated_revision`. A second
concurrent overlapping search would make a listing's contribution *move* between
markets and its verdict flap. The CHECK does not create that limitation — it refuses
the state loudly instead of letting it happen quietly. Supporting multiple searches
means re-keying the two largest tables, which SQLite cannot do in place.

## The off switch, and what can go wrong

In order of speed:

1. **Dashboard → Workers → Settings → Triggers → delete the Cron.** Seconds, no deploy.
2. Delete `triggers.crons` from `wrangler.jsonc` and redeploy.
3. A run already in flight:
   `npx wrangler workflows instances terminate marketplace-deal-finder-cleanup <id>`.
   Safe by construction: the unit of commitment is one group's `CLEAN_A` + `CLEAN_B`.

**Blast radius.** The Workflow can only delete from `price_observations`, decrement
`model_stats`, and sweep `count = 0` rows. It cannot touch `listings` or
`evaluation_tasks`, and `listings.first_seen_at` — the one irreversible loss in the
system — is unreachable from it.

**The catastrophic case is a wrong cutoff, and the payload is one field, guarded.**
`CleanupParams` is `{ now }` and nothing else, so a hand-written
`wrangler workflows trigger '<json>'` payload cannot set a tuning value: an unexpected
key is **inert**, not merely rejected. `now` itself must be a safe integer in
`[1e9, 1e11]`, which rejects milliseconds, microseconds and nanoseconds. What is left
is editing the module constants, which is a code change under review.

**How a wrong cutoff would be noticed.** There is no alerting — Phase 4 owns it, and
telemetry is 3E-b's. Today: `CleanupRun` is the instance output, readable with
`npx wrangler workflows instances describe marketplace-deal-finder-cleanup <id>`, and
it carries `cutoff`, so a wrong cutoff is visible without a database query.
`docs/phase-3c-storage.md`'s drift query is the operational check. **This is a manual
detection path and this document does not pretend otherwise.**

**Recovery.** `docs/phase-3c-storage.md` already gives the SQL to rebuild
`price_observations` from `listings` — with its **mandatory**
`last_seen_at >= :now - 7*86400` filter — and `model_stats` from that. Four
statements, no code.

## What was measured, and where the local runner stops being evidence

| Claim | How it was established |
|---|---|
| Workflows run locally | miniflare 5's `workflows` plugin; a real `WorkflowEntrypoint` ran, with the D1 the test process holds |
| `scheduled()` drivable in-process | `(await mf.getWorker()).scheduled({ cron, scheduledTime })` → `{ outcome: "ok" }`, real `controller.cron` delivered |
| Step durability | only the failing step re-runs, memoized **by name** — which is why step names are `cleanup-${index}` |
| Default retry ladder | 6 body executions over ~31s; `CLEANUP_STEP_CONFIG` overrides it to 2 |
| Per-instance step limit | 10,000 **(local** — miniflare's `DEFAULT_STEP_LIMIT`; Cloudflare's documented figure may be smaller, and `MAX_STEPS = 32` is far under either) |
| `NonRetryableError` lives in | `cloudflare:workflows`, **not** `cloudflare:workers` |
| Types | `Workflow<T>` and `ScheduledController` are global; `WorkflowEvent`, `WorkflowStep` and `WorkflowStepConfig` are **not** — they come from `cloudflare:workers` |
| D1 | `PRAGMA foreign_keys = 1`; CHECK constraints fire; a failing statement rolls the **whole batch** back; parent-then-child in one batch satisfies an FK |
| wrangler | `deploy --dry-run` accepts this config offline in ~0.6s and errors when the Workflow class is not exported |

**The honest limit: every Workflow claim above is measured against miniflare 5's
*alpha* local runner, not production Workflows.** Step memoization, the retry ladder
and the step limit are all local facts. Closing that would take a deploy to a staging
Worker plus `wrangler workflows instances describe`.

It is acceptable because `runCleanup`'s correctness does not depend on step semantics.
Idempotence lives in `cleanupStaleObservations`' SQL, which 3C measured against D1. If
production's memoization or retry ladder diverges, the consequence is **repeated work**
— a step body re-running and subtracting nothing — **not wrong data**. The step
boundary is a cost-control and resume device, not a correctness device, and a
divergence costs one day's larger-than-expected read bill, visible in
`CleanupRun.usage`.

## How this is tested

`worker/testing/workerBundle.ts` bundles the real `worker/index.ts` with vite (already
a devDependency), hosts it in Miniflare with a D1 and a `workflows` binding, applies
the real migrations through the same `applyMigrations` the other seam uses, and
returns a `fire(cron, seconds)`. `cleanupWorkflow.test.ts` drives the whole chain
through it — cron string → `scheduled()` → `create()` → real `WorkflowEntrypoint` →
real `step.do` → real `cleanupStaleObservations` → real D1.

A Node test cannot import a module with a runtime `cloudflare:workers` import, and
wrangler requires the Workflow class to be exported from the main entry — which
`worker/index.test.ts` imports. `vite.config.ts` therefore carries a `test.alias` (and
only a `test.alias`) mapping `cloudflare:workers` to `worker/testing/cloudflareWorkers.ts`.
The frontend build, `tsc` and eslint never see it, and neither does the deployed
bundle. `worker/scheduling/cleanupWorkflow.ts` holds **no logic** precisely so nothing
a Node test can reach ever runs against that stub.
