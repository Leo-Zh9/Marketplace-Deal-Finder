# Phase 3D — Pricing and evaluation: the CPU measurement and the row budget

The evaluation layer lives in `worker/evaluation/`. It reads the running aggregate 3C maintains,
excludes the candidate from its own benchmark, applies the deal rules, and drives
`evaluation_tasks` durably. It owns no settings table — settings and the search revision are
parameters of the `evaluateBatch` call, and 3E supplies them.

## Applying the migration

```bash
npm run db:migrate:local   # .wrangler/state, offline, safe to repeat
npm run db:migrate         # --remote: writes to the real database
```

`db:migrate:local` against `0002_evaluation_tasks.sql` reports `9 commands executed successfully`
(the eight statements in the file plus wrangler's own `d1_migrations` bookkeeping insert).

0002 is additive only: five `ALTER TABLE … ADD COLUMN` and three `CREATE INDEX`. There is no
`CREATE TABLE`, no `DROP`, no `UPDATE` and no `DELETE`, so it cannot lose data and needs no
down-migration — `QUEUE_TASK` names its columns explicitly, so 3C code is unaffected by the new
columns. `worker/storage/schema.test.ts` asserts that shape against the file itself, not only
against the applied result: a destructive statement would still leave a fresh database looking
correct while destroying a deployed one.

## The CPU measurement

**Required target: p95 CPU < 8 ms on a 15-listing batch.**

### What the harness is, and why it is not the obvious thing

`createTestDatabase()` hands the Node test process a **proxy**: every `prepare`, `bind` and `all`
is an HTTP round trip to workerd. Measured directly, one 15-candidate batch is ~120 ms wall and
~27 ms of Node CPU, and instrumenting the awaits attributes only ~9 ms of that to D1 — the rest is
proxy machinery that does not exist in a Worker. Reporting that as "CPU" would fail a gate the code
passes by three orders of magnitude.

So `worker/evaluation/evaluationCpu.test.ts` captures, then replays:

1. Run `evaluateBatch` once against the real D1 over a realistic fixture — one market, 60
   contributing observations, 15 claimed candidates, a few thousand rows in `evaluation_tasks` —
   and capture the exact result rows D1 returns.
2. Replay those captured rows through a small in-process `D1Database`-shaped stub, and time
   `evaluateBatch` over 3,000 samples after an 800-sample warm-up.
3. What counts as CPU: everything `evaluateBatch` does that is not waiting on D1 — SQL string
   construction, bind-argument marshalling, result mapping, `decide`, statement construction. That
   is Cloudflare's own definition; CPU time excludes I/O wait.

The replay stub is **not a second database seam**. It executes no SQL and owns no schema; its data
comes from the real seam in step 1, and it lives inside the CPU test file so it cannot be mistaken
for one.

The captured batch is the **pessimistic** shape, not the steady state: the 15 candidates are spread
so that all four claim statements run (5 `PENDING`, 4 expired `PROCESSING`, 3 stale-revision
`COMPLETE`, 3 `NEEDS_REVIEW`), plus one candidate read and one completion batch. The steady state
fills entirely in tier 1 and issues three round trips.

### The numbers

Measured on this repository at batch size 15, printed on every test run:

| | value |
|---|---|
| p50 | 0.0074 ms |
| p95 | **0.0134 ms** |
| p99 | 0.0175 ms |
| max | 1.83 ms |

That is roughly **600× under the 8 ms budget**. The figures move by a few microseconds run to run;
the test prints them and asserts only `p95 < 8`. Batch size stays at `EVALUATION_BATCH_SIZE = 15`;
no degradation to 10 / 5 / 1 was needed.

**Honest limitation.** The stub does not pay the real D1 binding's `prepare`/`bind` cost or the
deserialisation of the response, which a real Worker does. Both are bounded by a 15-row result; at
this headroom the conclusion survives them.

## The row budget

CPU is only half of it: the claim must not read a number of rows that grows with the corpus. Every
figure below is measured by a test in `evaluationCpu.test.ts`, not asserted from a plan.

| scenario | rows read |
|---|---|
| C1 — whole call, steady state: 15 `PENDING` inside 20,000 tasks | 165 |
| C1b — claim only, 20,000 `PENDING` sharing one `created_at` | 90 |
| C2 — whole call, post-bump: 200 / 5,000 / 20,000 tasks all eligible | 141 / 141 / 141 |
| C2b — whole call, 15 stale tasks behind 20,000 settled ones | 142 |
| C3 — claim only, 20,000 `NEEDS_REVIEW` sharing one `evaluated_at` | 101 |

C1's 165 decomposes as 90 (tier 1 claim) + 60 (candidate read) + 15 (completion batch), and C1
asserts it exactly rather than only under a ceiling: every other figure here is a ceiling, and a
ceiling is only as honest as the `usage` accounting behind it.

Each claim-only figure is **identical at 200, 5,000 and 20,000 rows** — that flatness, not the
constant, is the property. The constants are this miniflare build's accounting, which charges an
`UPDATE … RETURNING` for the index maintenance of its own write (90 rows for a 15-row claim whose
select reads 15).

The post-bump figure is flat at 100× the eligible-set size. That is the property the design is
built around, because a revision bump is the documented recovery path for a bad verdict and it
makes *every* task eligible at once.

### The three shapes that cost the design something

Each of these was built and measured; the numbers are from this repository's test database.

**A single claim statement with a `CASE` in the `ORDER BY`.** It works. It costs `rows_read ≈
2 · |eligible|`, because an `ORDER BY` cannot ride a `MULTI-INDEX OR`: `EXPLAIN` reports
`USE TEMP B-TREE FOR ORDER BY`, so the entire eligible set is materialised and sorted to pick 15.
Measured at 200 eligible: **521 rows** against the tiered form's 141, and it grows from there.

**`evaluated_revision IS NOT ?` in place of tier 4's three range terms.** The two select a provably
identical set, but `IS NOT` is not indexable. With every task eligible the difference is invisible —
both read 90 rows, because the first 15 index entries touched all match. Put the eligible rows
*behind* a large block at a lower revision and it appears: **20,015 rows against 16**.

**`source` factored out of tier 4's `OR` group.** Written as `WHERE source=?1 AND (… OR … OR …)`,
SQLite abandons the `MULTI-INDEX OR` — `EXPLAIN` degrades from three covering ranges to
`SEARCH … USING COVERING INDEX evaluation_tasks_revision (source=?)`, still covering but seeking on
`source` alone and then walking. Same fixture: **20,015 rows against 16**. `source=?1` is repeated
inside every `OR` term for this reason and must stay there.

**A narrower `evaluation_tasks_queue`.** Dropping `created_at, listing_id` — or the whole index —
is invisible in the steady state, because 15 `PENDING` rows sort for free, and invisible to a
missing-index check, because `evaluation_tasks_attempt` and `evaluation_tasks_revision` both begin
`(source, status)` and serve the seek. It shows up on the shape a first full scan actually has:
20,000 tasks queued by one scan, all sharing one `created_at`. Then the tie group is the corpus —
**40,075 rows against 90**, with `EXPLAIN` reporting `USE TEMP B-TREE FOR ORDER BY`. That is C1b,
and it is why `listing_id` is the fourth column of the index.

## The parts most likely to be "simplified" back into a defect

- **The four tiers run 1, 2, 4, 3 — finite work before infinite work.** Tier 3 (`NEEDS_REVIEW`) is
  unbounded and perpetual by design; tier 4 (stale revision) is finite. With tier 3 third, tier 4
  gets `batchSize − alreadyClaimed`, which is zero whenever `|NEEDS_REVIEW| ≥ batchSize`, and the
  stale set is never claimed at all.
- **The tier loop breaks only when the batch is full**, never because a tier returned zero rows. In
  the ordinary steady state nothing is `PENDING`, so an early return on tier 1 would disable
  expired-lease recovery, evidence re-checks and revision bumps simultaneously.
- **Tier 3 orders by `evaluated_at`, which every completion writes.** Nothing advances `created_at`
  for a task that stays in the queue, so ordering by it returns the same 15 rows forever.
- **`lease_token` is a fresh UUID per claim.** The lease *value* cannot serve as the fence: a
  requeue between two claims at the same instant gives both claimants the same lease, and the stale
  verdict wins.
- **Validity fails closed.** `validity` is TEXT and 3C stores whatever the caller passed, so
  anything that is not exactly `"VALID"` is not a deal.
- **Money is never divided.** `P·C·10000 ≤ T·(10000−bp)` in `BigInt`. The only rounding anywhere is
  `Math.round(percent * 100)` on the threshold parameter.

## Status versus verdict

They are orthogonal and must stay so: **verdict is the answer; status is whether 3D has more work
to do.** `status = 'NEEDS_REVIEW'` is reserved for the single outcome where retrying can change the
answer with no input change — `insufficient-evidence`, where more observations arrive on their own.
Every other outcome, *including the verdict* `NEEDS_REVIEW`, is `COMPLETE`, because only an input
change can move it and every input change already re-opens the task: a listing change through
`recordSightings`' `QUEUE_TASK`, a settings change through tier 4.

Two reasons park a task at `NEEDS_REVIEW` rather than completing it, and they are deliberately
distinct. `insufficient-evidence` means the market is young and more observations will cure it.
`invalid-reference-total` means the aggregate itself is malformed — a `total_price_cents` that is
not a safe integer, which `model_stats`' INTEGER *affinity* permits — and nothing cures that on its
own. Both rotate in tier 3, so both self-heal if the aggregate is ever repaired (a `model_stats`
change never requeues a listing, so tier 3 is the only way back), but only the second one tells you
a model is stuck rather than merely waiting. A negative `reference_total_cents` parks the same way
rather than producing `NOT_DEAL`: it cannot yield a false `DEAL`, but ruling on it would mark a
listing "not a deal" forever on the strength of a drifted aggregate.

A `validity='NEEDS_REVIEW'` or `invalid-reference` task re-opens when **3B re-classifies the listing
on a later sighting** — that works only because `validity` is inside `contentHash`. A direct
database edit of `listings.validity` does **not** re-open it: the stored `content_hash` is
unchanged, the next sighting classifies `UNCHANGED`, and the task stays `COMPLETE` forever. The
supported lever for forcing a re-evaluation is a revision bump, not an `UPDATE listings`.

## Recovering from a bad verdict

3D writes nothing that a verdict is derived from. Its only writes are to `evaluation_tasks`
(`status`, `verdict`, `evaluated_revision`, `evaluated_at`, `lease_expires_at`, `lease_token`);
`listings`, `price_observations` and `model_stats` are read-only to it. So: deploy the fix and
**bump `searchRevision`**. Every `COMPLETE` task becomes eligible again through tier 4, with no
destructive write, no lost verdict history and no re-notification of anything Phase 4 has already
recorded.

`verdict` and `evaluated_at` are on the row, so "what did we decide, and when" is one query.

A verdict the fence rejects is never committed and never reported as an outcome: `evaluateBatch`
returns `outcomes` and `discarded` as **separate arrays**, so a caller cannot act on a rejected
verdict by forgetting to filter. `discarded` is populated whenever the task changed between the
candidate read and the completion — a price change requeueing the row mid-call is the ordinary
cause — and test E15c drives exactly that window.

**The honest caveat.** A recompute is faithful only against the aggregate as it stands. `model_stats`
is a running aggregate over a 7-day window, so a recompute a week later gives a *different* answer,
not the same one — correct for today's market, not a reconstruction of last Tuesday's. There is no
historical price table to replay from.

## Known preconditions and carry-overs

- **One task per listing, not one per (listing, search).** `evaluation_tasks`' primary key is
  `(source, listing_id)`. A future multi-search system would need a different key, and SQLite cannot
  alter a primary key. Named here so it is a known precondition rather than a discovery.
- **The exclusion rule depends on 3C's ledger.** It is true only while `recordSightings` and
  `cleanupStaleObservations` keep the observation row and the aggregate in lockstep. 3C's own
  doc has a drift-detection section, which means 3C already anticipates they can diverge. No test
  3D can write catches that, because the test would have to assume the invariant it is checking.
- **`evaluation_tasks` grows with `listings`, which has no retention policy.** Every claim tier is
  O(batchSize) in rows read at any table size, so growth costs storage rather than time.
- **Tier 3 rotates**, so a large `NEEDS_REVIEW` population is re-examined round-robin rather than
  not at all. The time to revisit any one task grows linearly with the population; if that ever
  becomes a problem the right lever is a re-check interval on `evaluated_at`, not a change to the
  ordering.
- **The frontend's `EvaluationStatus` uses `"NOT_A_DEAL"` while 3D's `Verdict` uses `"NOT_DEAL"`.**
  Phase 5 owns that mapping.
