# Facebook Marketplace Deal Finder — System Design

## 1. Scope

This version is intentionally small:

- **1 user**
- **Facebook Marketplace only**
- Runs **24/7**
- Checks every **30 minutes**
- User may monitor any of 9 PC component categories
- Each component search requests the **15 newest listings**
- Cloudflare Free stack: Pages, Workers, Workflows, Cron Triggers, D1
- Firebase Authentication for Google sign-in
- No purchased domain or Cloudflare Zero Trust subscription
- Discord webhook notifications
- No browser fallback in this phase

Supported categories: `CPU`, `CPU Cooler`, `Motherboard`, `RAM`, `Storage`, `GPU`, `PSU`, `Case`, `Case Fans`.

The goal is **fresh deal discovery**, not exhaustive crawling.

---

## 2. High-Level Architecture

```text
User
  |
  v
Cloudflare Pages
  |
  v
Firebase Authentication
Google sign-in
  |
  v
Cloudflare Worker API
  |
  +-----------------------------+
  |                             |
  v                             v
D1 Database               Cron #1: every 30 min
                                |
                                v
                         Monitoring Workflow
                                |
                                v
                       Facebook HTTP Provider
                                |
                                v
                      15 newest / component
                                |
                                v
                         Normalize + Persist
                                |
                                v
                        Update Model Totals
                                |
                                v
                          Evaluate Deals
                                |
                                v
                         Discord Notifications


Cron #2: daily at noon
        |
        v
 Cleanup Workflow
        |
        v
 Remove stale observations
 + subtract them from model totals
```

We use **2 of Cloudflare's 5 Cron Trigger slots**.

---

## 3. Limits We Design Around

Cloudflare Free currently provides:

- Workers: **100,000 requests/day**
- Workers/Cron: **10 ms CPU per invocation**
- Workflows: **10 ms CPU per step**
- Workflows: **3,000 steps/day**
- Cron Triggers: **5/account**
- D1: **5,000,000 rows read/day**
- D1: **100,000 rows written/day**
- D1: **500 MB per Free database**
- D1: **5 GB total included storage**

Network/database waiting does not count as active Worker CPU time.

Sources:

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workflows/reference/limits/
- https://developers.cloudflare.com/workflows/reference/pricing/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/

---

## 4. Cron #1 — Monitoring Every 30 Minutes

```cron
*/30 * * * *
```

This runs **48 times/day**.

The Cron itself only starts a Monitoring Workflow.

### Workflow

```text
1. Acquire run lock + load current search revision
2. Bootstrap Facebook session/request metadata once
3. For each selected component:
      search the 15 newest listings
      normalize and persist results
      update running model totals
      create evaluation tasks
4. Evaluate pending candidates
5. Send qualifying Discord alerts
6. Finalize run + release lock
```

Only one routine monitoring Workflow may own monitoring state at a time.

---

## 5. Facebook Searching

For every selected component category, perform **one Facebook query**.

Example:

```text
Selected:
GPU
CPU
RAM

Every 30 minutes:

Facebook GPU search -> newest 15
Facebook CPU search -> newest 15
Facebook RAM search -> newest 15
```

Selecting many models does **not** create one request per model.

`GPU -> All Models` still produces one GPU search.

The Facebook provider must demonstrate a reliable newest/freshest ordering before production use.

A valid search returning nothing is:

```text
SOURCE_EMPTY
```

and requires no evaluation work.

---

## 6. Listing Processing

Each returned listing is normalized into:

```text
listing_id
component_type
model_key
variant_key
title
price_cents
location
url
last_seen_at
content_hash
```

Facebook condition labels are **not used in price aggregation** because they are too inconsistent.

Clearly invalid pricing references are still excluded, such as:

- broken / for-parts listings
- wanted ads
- trade-only listings
- fake or placeholder prices
- wrongly identified models
- bundles that cannot be priced correctly

Each listing is classified as:

```text
NEW
CHANGED
UNCHANGED
```

### NEW

- Insert listing/observation.
- Add its valid price to the model aggregate.
- Create a pending evaluation.

### CHANGED PRICE

- Replace the stored price.
- Subtract the old price from the aggregate.
- Add the new price.
- Create a new evaluation if needed.

### UNCHANGED

- Refresh `last_seen_at`.
- Do not change aggregate count or total.
- Do not normally reevaluate.

---

## 7. Running Model Price Aggregates

Normal evaluation does **not** scan historical listings.

D1 keeps:

```text
model_stats
-----------
market_key
model_key
variant_key
count
total_price_cents
```

We do **not** store the average.

```text
average_price = total_price_cents / count
```

### `market_key`

Pricing must not mix unrelated regions.

`market_key` represents the current:

```text
location + search radius
```

Changing location/radius creates a different market aggregate.

### Candidate Evaluation

All current-scan valid observations are added to the aggregate before evaluation.

For a candidate already included in the aggregate:

```text
reference_count = count - 1
reference_total = total_price_cents - candidate_price

reference_average =
    reference_total / reference_count
```

This prevents a listing from affecting its own benchmark while still allowing other listings from the same scan to contribute.

If there are too few comparable observations, the candidate remains pending.

---

## 8. Evaluation Work

Each new or relevantly changed listing receives a durable:

```text
PENDING evaluation task
```

Changing filters creates a new:

```text
search_revision
```

An unchanged listing is reevaluated if it has **not been evaluated under the current revision**.

Previously sent notification IDs are never cleared by search changes.

Start with:

```text
EVALUATION_BATCH_SIZE = 15
```

This matches one component's maximum discovery window.

Because pricing is now a constant-time aggregate lookup, this should be cheap, but production telemetry decides the final batch size.

Target:

```text
p95 CPU < 8 ms
hard limit = 10 ms
```

Unfinished evaluation tasks remain in D1 for the next run.

---

## 9. Database Design

Use **one D1 database initially**.

Core tables:

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

`price_observations` and `model_stats` stay in the same D1 so aggregate changes and observation changes can be atomic.

D1 `db.batch()` is transactional: if one statement fails, the sequence is rolled back.

Source:

- https://developers.cloudflare.com/d1/worker-api/d1-database/#batch

---

## 10. Cron #2 — Daily Cleanup

Run once per day at **12:00 PM**.

```text
Daily cleanup
     |
     v
Find stale observations
     |
     v
Group by market/model/variant
     |
     v
Subtract expired prices from total_price_cents
     |
     v
Subtract expired rows from count
     |
     v
Delete stale observations
```

An observation is stale when its last real Facebook sighting is older than seven days.

Because cleanup runs once daily, the practical rolling window is approximately:

```text
7 to 8 days
```

This approximation is intentional.

Cleanup must update `model_stats` and delete observations atomically.

Cleanup is processed in small bounded Workflow batches to stay below the 10 ms CPU target.

---

## 11. Notification Safety

Qualifying listings create a persistent notification record before Discord is called.

States:

```text
PENDING
SENDING
SENT
DELIVERY_UNKNOWN
```

A successful notification permanently stores the Facebook listing ID.

The same listing is therefore not normally alerted twice.

An ambiguous Discord connection result becomes:

```text
DELIVERY_UNKNOWN
```

instead of being blindly resent.

---

## 12. Failure Handling

### Facebook request fails

- Retry a bounded number of times.
- If it still fails, mark the run degraded.
- Keep existing D1 data unchanged.
- Try again on the next 30-minute run.

### D1 write fails

- Do not evaluate data that was not persisted.
- Retry the idempotent write step.
- Rediscovery is safe because listing IDs are deduplicated.

### Workflow budget is exhausted

Priority:

```text
1. Discover newest listings
2. Persist observations
3. Update aggregates
4. Evaluate candidates
5. Send alerts
```

Unfinished evaluation/notification work stays in D1.

### Search changes mid-run

- The current run keeps its original `search_revision`.
- New settings create a new revision.
- The next run uses the new revision.

---

## 13. Expected Step Usage

Let:

```text
C = selected component categories
1 <= C <= 9
```

A conservative scan uses roughly:

```text
3 fixed steps
+
3 steps per component
```

Per component:

```text
1 search step
1 persist/aggregate step
1 evaluation step when needed
```

Worst initial scan with all 9 categories:

```text
3 + (3 * 9)
≈ 30 steps
```

At 48 runs/day:

```text
30 * 48
= 1,440 steps/day
```

This leaves substantial room below the current **3,000 Workflow steps/day** for notifications, retries, and daily cleanup.

Normal operation should use fewer evaluation steps because most returned listings will already be known.

---

## 14. Initial Constants

```text
CHECK_INTERVAL_MINUTES = 30
LATEST_LISTINGS_PER_COMPONENT = 15

EVALUATION_BATCH_SIZE = 15

REFERENCE_AGE_DAYS = 7
CLEANUP_TIME = 12:00 PM

TARGET_STEP_CPU_MS = 8
HARD_STEP_CPU_MS = 10

MAX_NETWORK_RETRIES = 2
```

---

## 15. Final Flow

```text
Every 30 minutes
      |
      v
Load search revision
      |
      v
Bootstrap Facebook
      |
      v
Search newest 15 for each selected component
      |
      v
Normalize + persist observations
      |
      v
Update count + total_price_cents per model
      |
      v
Evaluate new/changed/current-revision candidates
using aggregate minus candidate's own contribution
      |
      v
Send qualifying Discord alerts
      |
      v
Finish


Every day at noon
      |
      v
Find observations older than 7 days
      |
      v
Subtract their prices/counts from model_stats
      |
      v
Delete stale rows
```

## 16. Design Principles

1. Search for **fresh listings**, not the entire marketplace.
2. One Facebook query per selected component, not per model.
3. Store only `count` and `total_price_cents`; derive the average.
4. Never scan seven days of history during normal evaluation.
5. A listing never contributes to its own comparison average.
6. Keep aggregate updates and observation changes atomic.
7. Persist unfinished work so a step limit cannot lose a listing.
8. Daily cleanup prevents unbounded database growth.
9. Search revisions make filter changes deterministic.
10. Keep CPU-heavy Workflow steps below an 8 ms practical target.
