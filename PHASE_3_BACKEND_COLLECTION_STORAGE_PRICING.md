# Phase 3 — Facebook Collection, Storage, Pricing, and Scheduled Monitoring

## Goal

Build and validate the entire backend pipeline before connecting it to the frontend.

This is the highest-risk phase of the project and should be completed incrementally:

- **3A — Collection**
- **3B — Normalization**
- **3C — Storage**
- **3D — Pricing and Evaluation**
- **3E — Scheduled Monitoring**

Do not build all five parts at once.

Each subphase has a clear acceptance gate.

---

# 3A — Collection

## Goal

Prove that the deployed Cloudflare environment can reliably retrieve recent Facebook Marketplace listings.

Start with exactly:

```text
1 component: GPU
1 location
1 radius
15 newest listings
```

Do not begin with all nine categories.

---

## Collection Flow

```text
Cloudflare Worker / Workflow
        |
        v
Bootstrap Facebook web session/request metadata
        |
        v
Construct Marketplace search request
        |
        v
Request newest GPU listings
        |
        v
Receive structured response
        |
        v
Return raw listing objects
```

The provider is a custom HTTP provider, not a browser.

No Playwright/browser fallback is part of this phase.

---

## Provider Responsibilities

Conceptually:

```ts
interface FacebookProvider {
  bootstrap(): Promise<FacebookSession>;
  search(query: FacebookSearchQuery): Promise<FacebookSearchResult>;
}
```

Search input must contain at least:

```text
component
location
radius
limit = 15
```

The provider must demonstrate a reliable newest/freshest ordering before production launch.

If recent listings cannot reliably be surfaced, the monitoring system is not considered viable even if requests technically succeed.

---

## Provider Result States

Use explicit outcomes:

```text
SUCCESS
SOURCE_EMPTY
PROVIDER_FAILURE
RATE_LIMITED
UNAVAILABLE
```

A valid response with zero listings is:

```text
SOURCE_EMPTY
```

not an error.

---

## Failure Handling

Handle:

- timeout;
- connection reset;
- transient 5xx;
- 429/rate limiting;
- malformed response;
- changed response schema.

Initial retry policy:

```text
MAX_NETWORK_RETRIES = 2
```

Retries must be bounded.

If Facebook returns an explicit CAPTCHA, checkpoint, or block, mark the provider unavailable rather than attempting to bypass it.

---

## 3A Acceptance Gate

Do not proceed to 3B until:

- GPU search works from deployed Cloudflare infrastructure;
- the same query succeeds repeatedly;
- newest/fresh ordering is demonstrated;
- location/radius behavior is understood;
- result count can be bounded to 15;
- zero results are distinguishable from provider failure;
- connection failures are handled cleanly;
- schema/block failures are detectable.

---

# 3B — Normalization

## Goal

Convert Facebook-specific responses into a stable application format.

The rest of the backend must never depend directly on Facebook's raw response structure.

---

## Normalized Listing Contract

Initial contract:

```ts
interface Listing {
  listingId: string;

  componentType:
    | "cpu"
    | "cpu_cooler"
    | "motherboard"
    | "ram"
    | "storage"
    | "gpu"
    | "psu"
    | "case"
    | "case_fan";

  modelKey: string | null;
  variantKey: string | null;

  title: string;
  priceCents: number | null;

  locationText: string | null;
  url: string;

  observedAt: string;
}
```

Facebook condition labels are not required for price aggregation.

---

## Invalid Price References

Exclude clearly invalid references such as:

```text
broken / for parts
wanted ads
trade-only listings
placeholder/fake prices
incorrectly classified components
mixed bundles that cannot be priced correctly
```

Do not guess when evidence is insufficient.

Suggested classification:

```text
VALID
NEEDS_REVIEW
INVALID_REFERENCE
```

Only `VALID` observations should contribute to running model totals.

---

## Model Identification

Start simple using aliases and canonical keys.

Example:

```text
"4070 super"
"rtx4070s"
"RTX 4070 Super"

-> RTX_4070_SUPER
```

Keep value-affecting variants distinct when practical.

Examples:

```text
RTX 4070 != RTX 4070 Super
Ryzen 7 7800X3D != Ryzen 7 7700X
```

If identification is uncertain:

```text
modelKey = null
```

and do not allow the listing to poison a model aggregate.

---

## Expand to All Nine Categories

Only after GPU normalization is stable, expand category-by-category.

Suggested progression:

```text
GPU
CPU
RAM
Storage
Motherboard
PSU
CPU Cooler
Case
Case Fans
```

The exact order is flexible.

Do not assume one parser/classifier works equally well for every category.

---

## Performance Requirement

The normal result window is 15 listings.

Target:

```text
p95 CPU < 8 ms
```

Hard constraint:

```text
10 ms per Workflow step
```

If 15-result parsing cannot fit:

- simplify parsing;
- reduce work in the step;
- split acquisition and heavier normalization;
- reduce batch size if required.

Correctness must not depend on a specific batch size.

---

## 3B Acceptance Gate

Proceed when:

- all required fields are extracted;
- invalid price references are excluded;
- aliases map consistently;
- unknown models do not enter aggregates;
- all nine categories have representative fixtures;
- 15-result normalization is measured against the CPU target.

---

# 3C — Storage

## Goal

Persist listing state safely in Cloudflare D1.

Use **one D1 database initially** so listing changes and aggregate updates can be atomic.

---

## Core Tables

```text
search_settings
search_revisions

listings
price_observations
model_stats

evaluation_tasks
notifications

monitor_lock
```

---

## `listings`

Stores current logical listing state.

Suggested fields:

```text
listing_id PRIMARY KEY
component_type
model_key
variant_key
title
price_cents
location_text
url
content_hash
first_seen_at
last_seen_at
```

---

## `price_observations`

Stores the current price observation that contributes to the running model aggregate.

One Facebook listing contributes at most one current price.

Suggested fields:

```text
listing_id PRIMARY KEY
market_key
model_key
variant_key
price_cents
last_seen_at
```

---

## `model_stats`

Stores the running aggregate.

Only store:

```text
market_key
model_key
variant_key
count
total_price_cents
```

Do **not** store average.

Derive when needed:

```text
average_price = total_price_cents / count
```

---

## `market_key`

Aggregates must not mix unrelated search regions.

`market_key` represents:

```text
location + search radius
```

Implementation may hash a canonical representation.

Example conceptual input:

```text
43.4643,-80.5204|25km
```

Changing location/radius therefore moves evaluation to a different market aggregate.

---

## Deduplication

Listing identity:

```text
facebook listing_id
```

Each sighting becomes:

```text
NEW
CHANGED
UNCHANGED
```

### NEW

Atomic operation:

```text
insert listing
insert price observation
increment model_stats.count
add price to model_stats.total_price_cents
create PENDING evaluation task
```

### PRICE CHANGED

Atomic operation:

```text
update listing
replace price observation
model_stats.total_price_cents -= old_price
model_stats.total_price_cents += new_price
count unchanged
```

### UNCHANGED

```text
refresh last_seen_at
do not change count
do not add price again
```

---

## Atomicity

Observation and aggregate changes must succeed together.

Never allow:

```text
aggregate changed
but observation did not
```

or:

```text
observation changed
but aggregate did not
```

Use transactional D1 batching.

All write paths must be idempotent and safe to retry.

---

## Daily Cleanup Logic

Implement the cleanup logic during 3C even though scheduling is activated in 3E.

Stale definition:

```text
last_seen_at older than 7 days
```

Since cleanup later runs once daily at noon, practical reference lifetime is approximately:

```text
7–8 days
```

For stale observations:

```text
find expired observations
      |
      v
group by market/model/variant
      |
      v
subtract expired prices from total_price_cents
      |
      v
decrement count
      |
      v
delete stale observations
```

The aggregate adjustment and deletion must be atomic per bounded batch.

Do not delete long-lived notification identities merely because price observations expire.

---

## Storage Tests

Test:

1. first sighting;
2. unchanged duplicate sighting;
3. price increase;
4. price decrease;
5. stale expiration;
6. cleanup retry;
7. transaction failure;
8. unknown model;
9. invalid reference;
10. same model in two different `market_key` values.

---

## 3C Acceptance Gate

Proceed when:

- duplicates do not inflate `count`;
- changed prices replace old contributions correctly;
- unchanged listings do not double-count;
- cleanup subtracts exactly once;
- failed transactions roll back;
- repeated runs remain idempotent;
- D1 usage is measurable.

---

# 3D — Pricing and Evaluation

## Goal

Evaluate listings using fast per-model running aggregates rather than scanning historical rows during every deal calculation.

---

## Running Aggregate

For each:

```text
market_key
model_key
variant_key
```

D1 stores:

```text
count
total_price_cents
```

Derived:

```text
average = total_price_cents / count
```

---

## Excluding the Candidate From Its Own Benchmark

Current-scan observations are persisted before evaluation.

If the candidate is already included in the aggregate:

```text
reference_count = count - 1
reference_total = total_price_cents - candidate_price
reference_average = reference_total / reference_count
```

This prevents a listing from lowering/raising the benchmark used to judge itself while still allowing other listings from the same scan to contribute.

---

## Minimum Pricing Evidence

Initial rule:

```text
minimum 5 comparable listings
```

If:

```text
reference_count < 5
```

then discount-based evaluation returns:

```text
NEEDS_REVIEW
```

and remains pending until more market observations exist.

Maximum-price mode can still work without market history.

---

## Deal Rules

### Discount

Let:

```text
D = minimum discount / 100
M = reference average
P = candidate price
```

Deal when:

```text
P <= M * (1 - D)
```

### Maximum Price

Deal when:

```text
P <= configured maximum
```

No market average required.

### Both

Require both conditions.

---

## Durable Evaluation Tasks

Use:

```text
evaluation_tasks
```

Statuses:

```text
PENDING
PROCESSING
COMPLETE
NEEDS_REVIEW
```

New or relevantly changed listings receive pending tasks.

Unfinished evaluation work must survive Workflow step limits and failures.

---

## Search Revisions

Changing search settings creates:

```text
search_revision = previous + 1
```

An unchanged listing becomes eligible again when:

```text
not evaluated under current revision
```

Example:

```text
Revision 1:
max price = $200

Revision 2:
max price = $300
```

An unchanged $250 listing must be reconsidered under revision 2.

Previously successful notification identities remain preserved.

---

## Evaluation Batch Size

Start with:

```text
EVALUATION_BATCH_SIZE = 15
```

This matches one component's maximum discovery window.

Because pricing uses a constant-time aggregate lookup, 15 candidates may fit easily.

But batch size is a performance knob, not a correctness rule.

Required target:

```text
p95 CPU < 8 ms
```

If 15 approaches the limit:

```text
15 -> 10 -> 5 -> 1
```

Pending tasks preserve correctness across steps.

---

## 3D Acceptance Gate

Proceed when:

- running averages match expected test values;
- candidate exclusion is mathematically correct;
- maximum-price mode works without market data;
- search revisions trigger reevaluation;
- insufficient pricing evidence stays pending;
- task retries do not duplicate results;
- evaluation CPU is measured with realistic 15-listing batches.

---

# 3E — Scheduled Monitoring

## Goal

Turn the proven collection/storage/evaluation pipeline into an unattended 24/7 monitoring service.

---

## Cron #1 — Monitoring

Schedule:

```cron
*/30 * * * *
```

Runs:

```text
48 times/day
```

The Cron should only start a Monitoring Workflow.

---

## Monitoring Workflow

```text
1. Acquire run lock
2. Load current search revision/settings
3. Bootstrap Facebook once
4. For each selected component:
      retrieve newest 15
      normalize
      persist
      update aggregates
      create evaluation tasks
5. Drain evaluation tasks
6. Finalize run
7. Release lock
```

Discord is added in Phase 4.

---

## Approximate Step Budget

Let:

```text
C = selected component categories
1 <= C <= 9
```

Conservative design target:

```text
~3 fixed steps
+
~3 steps/component
```

For all 9:

```text
~30 steps/run
```

At 48 runs/day:

```text
~1,440 steps/day
```

This leaves margin under the current 3,000 Workflow-step Free allocation.

This is a planning estimate only; production telemetry is authoritative.

---

## Run Lock

Prevent overlapping routine scans.

If a previous monitoring run still owns the lock:

```text
skip competing state mutation
```

Prefer one consistent run over two overlapping aggregate/evaluation writes.

---

## Cron #2 — Daily Cleanup

Run once per day at noon.

Conceptually:

```cron
0 12 * * *
```

Cloudflare Cron scheduling uses UTC, so deployment must translate the intended local noon correctly.

Cleanup Workflow:

```text
find stale observations
      |
      v
process bounded batch
      |
      v
subtract model totals/counts
      |
      v
delete stale observations
```

If too many rows exist for one step, continue in bounded Workflow steps.

---

## Failure Recovery

### Facebook unavailable

- mark run degraded;
- do not modify aggregate state based on missing data;
- retry on next scheduled run.

### Workflow interruption

- durable/idempotent steps resume safely;
- unfinished evaluation tasks remain stored.

### D1 unavailable

- do not evaluate data that failed to persist;
- preserve old state;
- retry later.

### No listings

```text
SOURCE_EMPTY
```

No downstream evaluation required.

### Too much work

Priority:

```text
1. fresh discovery
2. persistence
3. aggregate correctness
4. pending evaluations
```

Persist unfinished work for later.

---

## Monitoring Telemetry

Record at minimum:

```text
run_id
started_at
finished_at
status
selected_components
facebook_request_count
result_count
new_count
changed_count
unchanged_count
evaluation_count
workflow_steps_used
errors
retry_count
```

Also capture D1 rows read/written and CPU measurements where available.

---

# Phase 3 Final Acceptance Criteria

Phase 3 is complete only when the backend works without the frontend:

```text
Facebook
  -> normalize
  -> D1
  -> running aggregate
  -> evaluation
  -> every 30 minutes
  -> daily cleanup
```

Specifically:

- Facebook works repeatedly from Cloudflare;
- newest/fresh ordering is proven;
- all 9 categories are supported;
- newest 15 results can be processed;
- duplicates do not inflate aggregates;
- price changes update aggregates correctly;
- stale observations clean up correctly;
- current search revision is respected;
- pending evaluations survive failures/runs;
- step CPU remains within measured limits;
- daily Workflow/D1 usage remains comfortably inside Free limits;
- outages do not corrupt state.

---

## Deliverable

A headless production-style backend that can continuously monitor Facebook Marketplace and produce reliable evaluation records in D1 without any frontend dependency.
