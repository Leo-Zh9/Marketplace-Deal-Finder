# The collector and the listings ingest path

## Why collection does not run on Cloudflare

Facebook Marketplace **cannot be collected from Cloudflare.** Measured with identical code from
two egress points one minute apart:

| | a residential IP | Cloudflare (`wrangler dev --remote`) |
|---|---|---|
| HTTP status | 200 | 200 |
| bytes | 633,015 | 473,552 |
| **listing blocks** | **10** | **0** |
| shell markers (`CometMarketplaceSearchContentContainer` / `MarketplaceFilterField` / `marketplace_seo_page`) | 19 / 14 / 2 | **0 / 0 / 0** |
| login-wall markers | 0 | **2** |

Facebook serves Cloudflare's ranges a login page **at HTTP 200**, so a request that "succeeds"
returns no listings. A VPS is the same class of datacenter IP. So the fetch moves to the
operator's machine and **everything else stays on Cloudflare exactly as built**:

```
the operator's Mac (residential IP)        Cloudflare  (UNCHANGED)
  collector: fetch -> parse  --POST-->  /api/listings -> recordSightings -> aggregate
                                        evaluation, monitoring, cleanup, telemetry
```

The accepted trade-off: **no new listings while the Mac is asleep.** The scheduled Cloudflare
work keeps running regardless.

---

## The wire contract

```jsonc
POST /api/listings
Content-Type: application/json
X-Collector-Token: <the secret>
// and NO Origin header

{ "source": "facebook-marketplace",
  "componentType": "gpu",
  "market": { "latitude": 43.5123, "longitude": -79.8765, "radiusKm": 18 },
  "listings": [
    { "listingId": "1807946430653887",
      "title": "For trade: MSI RTX 3060 Ventus 2X 12GB for an Intel Arc B580 12gb",
      "priceText": "CA$0",
      "locationText": "Markdale, Ontario",
      "url": "https://www.facebook.com/marketplace/item/1807946430653887" } ] }
```

**Five fields per listing, and that is the whole list.** Each one maps to a stored column.
**`priceText` and `locationText` may be `null`** (or absent); the other three may not. The source
genuinely omits a price or a location on real listings, `listings.price_cents` and
`listings.location_text` are already nullable, and refusing such a listing would refuse the
**whole batch** — one price-less listing anywhere on the page would store nothing, on every run,
until it aged off. An empty string is still refused: the parser emits `null`, never `""`.

| field | who decides it |
|---|---|
| `listingId`, `title`, `url` | the wire, validated, required |
| `locationText` | the wire, validated, **nullable** |
| `componentType` | the envelope, checked against an exhaustive set with `Object.hasOwn` |
| `priceCents` | **the server**, from `priceText` (see the grammar below), which is **nullable** |
| `modelKey`, `variantKey` | **the server**, hardcoded `null` |
| `validity` | **the server**, hardcoded `"VALID"` |
| `observedAt` | **the server**, from the request clock |

There is no field on this wire for `priceCents`, `modelKey`, `variantKey`, `validity` or
`observedAt`, and **unknown keys are refused, not dropped** — at ALL THREE levels: the
envelope, each listing, and `market`. A batch carrying one is a `400 INVALID_LISTINGS` naming the
field, and nothing is written. (`market` was the level that was missed: the handler reconstructs
`{latitude, longitude, radiusKm}` explicitly, so a `market.currency` or `market.radiusMiles` used
to be accepted with a 200 and thrown away. It is now refused like the other two.) `creationTime` is absent too: the collector sorts and slices with it and then discards
it, because no column stores it.

`source` stays opaque: shape-validated against `/^[a-z0-9][a-z0-9-]{0,63}$/` and never
enumerated. (JavaScript's `$` does not match before a trailing newline, so `"facebook\n"` is
refused. The same regex ported to Python would accept it.)

`market` is client-supplied and server-validated, because `search_revisions` stores only the
evaluation mode and its thresholds. `radiusKm` must round to at least 1: `marketKey` throws
below that, and `recordSightings` computes it **outside** its per-listing try/catch, so an
unvalidated `0.4` would reject the whole call as a 503 instead of a 400.

### The response

```json
{ "received": 4, "stored": 4,
  "outcomes":      { "NEW": 4, "CHANGED": 0, "UNCHANGED": 0, "FAILED": 0 },
  "contributions": { "recorded": 0, "restored": 0, "removed": 0, "none": 0,
                     "skipped-no-price": 0, "skipped-no-model": 4, "skipped-invalid": 0 },
  "pricesUnparsed": 0,
  "usage": { "rowsRead": 8, "rowsWritten": 12 } }
```

Every key is always present, at 0 when it did not happen. `received` counts what was sent and
`stored` counts what `recordSightings` returned, so its last-wins de-duplication of a repeated
`listingId` is **observable without being reimplemented**. `200`, not `201`: this is an upsert.

**A failed listing's error string never crosses the wire.** It is `console.warn`ed with the
listing id for `wrangler tail`; a caller holding only a bearer secret must not learn the schema
from a failure.

**`skipped-no-model` is the signal to watch.** While `modelKey` is hardcoded null, every
non-contributing listing reports it — `skipped-no-price` is structurally unreachable, because
`recordSightings` tests the model key first. When normalization lands, `skipped-no-model` going
to zero is how you will know it works.

### Status codes

| code | status | means |
|---|---|---|
| `CORS_ORIGIN_DENIED` | 403 | the request carried an `Origin` header. Any origin, including an allowed one |
| `COLLECTOR_CONFIG_MISSING` | 503 | `COLLECTOR_TOKEN` is not set on the Worker |
| `COLLECTOR_CONFIG_INVALID` | 503 | it is set but shorter than 32 characters |
| `AUTH_TOKEN_MISSING` / `AUTH_TOKEN_INVALID` | 401 | no `X-Collector-Token`, or the wrong one |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | the body is not `application/json` |
| `PAYLOAD_TOO_LARGE` | 413 | over 128 KiB, declared or measured |
| `INVALID_JSON` | 400 | the body is not a JSON object |
| `INVALID_LISTINGS` | 400 | a field is wrong or unknown; `error.field` names it |
| `INGEST_EMPTY_BATCH` / `INGEST_BATCH_TOO_LARGE` | 400 | zero listings, or more than 100 |
| `DATABASE_UNAVAILABLE` | 503 | no `DB` binding |
| `INGEST_STORAGE_FAILED` | 503 | the write failed — see "a total write outage" below |
| `AUTH_CONFIG_MISSING` | 503 | **`ALLOWED_ORIGINS` is unset.** Not a collector problem |
| `AUTH_CONFIG_INVALID` | 503 | **`ALLOWED_ORIGINS` is malformed.** Not a collector problem |

The last two are easy to meet and easy to misread: `readAllowedOrigins` runs on every `/api/*`
request, **before** the ingest branch, so a Worker with no `ALLOWED_ORIGINS` answers
`503 AUTH_CONFIG_MISSING` here even with a perfectly good collector token. Measured.

The two configuration 503s are **distinct from** `AUTH_CONFIG_MISSING` / `AUTH_CONFIG_INVALID`,
which already mean an unset `ALLOWED_ORIGINS` or `FIREBASE_PROJECT_ID`. Three different fixes
behind one code sends an operator to the wrong one.

Anyone can elicit those 503s, including a caller with no token at all. That is accepted: they
say only that the route is unconfigured, and unconfigured means there is no credential to guess.
The **request**-level 401s stay shared with the Firebase path on purpose, so a prober cannot tell
which credential system it is probing.

---

## The price grammar

```
/^[A-Za-z$€£¥₹\s]*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?$/
```

Integer arithmetic only — `parseFloat("1234.56") * 100` is `123455.99999999999`.

| accepted | cents | | refused |
|---|---|---|---|
| `CA$0` | **0** | | `Free` |
| `CA$3,000` | 300000 | | `CA$1.5`, `CA$1.234` |
| `$1,234.56` | 123456 | | `1,23,456`, `CA$1,2345` |
| `£7.50` | 750 | | `CA$3,000 or best offer`, `3000CAD` |
| `CA$1,000,000` | 100000000 | | `CA$1,000,001` (over the cap) |
| | | | `CA$-5`, `-CA$5`, `CA$−5` (all three sign forms) |
| | | | `NaN`, `Infinity`, `__proto__`, `CA$<script>` |

**The currency prefix is an explicit allowlist, not `[^0-9]*`.** With `[^0-9]*` all three sign
forms parse as **500** — the minus sign is eaten as "currency". That was a real defect in a draft
of this module, measured out.

**`CA$0` is zero, never null.** Facebook renders a genuinely free item that way and one is in the
live data; PR #6 exists because a `$0` listing reached the benchmark. The rule that keeps it out
of the benchmark is `recordSightings`' `priceCents > 0`, one layer down. **`Free` is null, not
zero** — inventing an amount from a word is the same class of guess.

**Two known loosenesses, named rather than fixed:** the letter class means `"USD5"` and `"e5"`
parse as five dollars (it is what accepts `CA$`, `US$`, `EUR`), and `"CA$0,000"` parses as 0.
Neither can produce a wrong non-zero amount and neither is reachable from a generated
`formatted_amount`. **A future provider with a free-text price field would mis-parse silently**
(`"Best offer 500"` → 50000); validate at that provider.

An unparseable price is `null`, not a rejection: the listing is real and is stored with
`price_cents NULL`. The count is surfaced by `pricesUnparsed`.

---

## What a leak of the collector token would let an attacker do

> A leaked `COLLECTOR_TOKEN` lets an attacker insert rows into `listings` and enqueue
> `evaluation_tasks` under any `source`, `market` and `componentType` they choose, and — for any
> `(source, listingId)` they can guess — **overwrite every mutable column of an existing listing
> row**: `title`, `url`, `location_text`, `price_cents`, `component_type`, `market_key`,
> `content_hash`, **`model_key` (to NULL)**, **`variant_key` (to `''`)**, **`validity` (to
> `VALID`)** and **`last_seen_at` (to now)**. Measured, all eleven on one request.
> `first_seen_at` is the one column that survives.
>
> Three of those matter more than the rest. **`last_seen_at` defeats staleness**, so a leaked
> token can keep any row alive past `cleanupStaleObservations` indefinitely. **`market_key` is
> the column `model_stats` is partitioned by.** And **`validity` is the mirror of `model_key`**:
> `dealRules.decide` sends `INVALID_REFERENCE` straight to `NOT_DEAL / COMPLETE`, so flipping it
> back to `VALID` returns a permanently-rejected row to the evaluation path — and once
> normalization lands, `validity === "VALID"` is one of the three conjuncts that let a listing
> contribute to the benchmark, where `model_key → NULL` removes one. It also lets them burn D1
> write quota.
>
> It lets them read **no settings, no evaluation results, no aggregates and no user identity**,
> and not even the error text of a failed write. What it CAN read is narrow and worth stating
> exactly, because an absolute claim here would be false: the response tells a caller **whether a
> `(source, listingId)` it guesses already exists** — an unknown id answers `NEW` with
> `usage.rowsRead: 0`, a known one answers `CHANGED` with `rowsRead: 2` — and **whether a guess
> at that row's contents is exact**, because `UNCHANGED` is returned only when the content hash
> matches, and that probe is non-destructive. Measured. The marginal harm is small, since the
> same token can already overwrite those rows outright. It cannot reach
> `/api/settings` or `/api/auth/session` — those routes never look at the header it carries.
> It cannot be used from a browser, from any origin, even a permitted one. And because the route
> sets `modelKey: null` itself and the wire format has no field for a model key, **no request to
> this route can insert a row into `price_observations` or increase a `model_stats` row**: in
> this slice the price benchmark is structurally out of reach.

Two riders:

- **The structural-benchmark property expires** the moment normalization makes ingest produce a
  non-null `modelKey`. That mitigation belongs to the normalization slice and must not be
  assumed to exist.
- **The route can already *decrease* a contribution.** Re-posting a known `(source, listingId)`
  that currently contributes takes `recordSightings`' `removed` path. That is unreachable
  today and is deliberately exercised as the end-to-end control, so the next slice cannot change
  it without noticing.

### The credential boundary

`authenticateRequest` admits exactly two identities — a loopback-only development identity and a
Firebase ID token on the allowlist. The collector is a **third** identity and is deliberately not
one of them:

- the check lives in **one branch** of `handleRequest`, before `authenticateRequest`, and
  `authenticateRequest` is not edited by a single line;
- it returns `{ ok: true }`, **not an identity**, so it cannot flow into `/api/auth/session`;
- it uses a **custom header**, never `Authorization`, so it is not parsed by the bearer path on
  any other route;
- the route **refuses any request carrying an `Origin` header at all**, so no ingest response can
  ever carry `Access-Control-Allow-Origin`;
- `/api/listings` is deliberately **absent from `ROUTE_METHODS`**, which is the advertised
  browser surface. Adding it would make `OPTIONS /api/listings` answer 204 advertising
  `POST, OPTIONS` — a real browser channel — **while every existing test still passed**.
  `worker/index.test.ts` X6c is the only guard on that, and it must not be "tidied up".
- the token is compared by hashing both sides to 32-byte SHA-256 digests and XOR-ing, so neither
  the length nor the content of the presented value steers the loop. That pins the
  *construction*; no test here measures wall-clock timing and none claims to.

`COLLECTOR_TOKEN` lives on its own `CollectorEnvironment` type. **That is a tripwire, not a
prohibition**: the naive `environment.COLLECTOR_TOKEN` inside an `authenticateRequest`-shaped
function does not compile, but three casts and a one-word parameter widening all do.
`worker/index.test.ts` **X4** is the enforcement. Do not delete it as redundant.

---

## Running the collector

```bash
COLLECTOR_API_BASE=https://your-worker.workers.dev \
COLLECTOR_TOKEN=... \
COLLECTOR_COMPONENT_TYPE=gpu \
COLLECTOR_LOCATION=toronto \
COLLECTOR_QUERY='graphics card' \
COLLECTOR_LATITUDE=43.5123 COLLECTOR_LONGITUDE=-79.8765 COLLECTOR_RADIUS_KM=18 \
npm run collect
```

| variable | required | default |
|---|---|---|
| `COLLECTOR_API_BASE` | yes | — |
| `COLLECTOR_TOKEN` | yes | — |
| `COLLECTOR_COMPONENT_TYPE` | yes | — |
| `COLLECTOR_LOCATION` | yes | — a URL path segment, `^[a-z0-9]+(-[a-z0-9]+)*$` |
| `COLLECTOR_QUERY` | yes | — |
| `COLLECTOR_LATITUDE` / `COLLECTOR_LONGITUDE` / `COLLECTOR_RADIUS_KM` | yes | — |
| `COLLECTOR_SOURCE` | no | `facebook-marketplace` |
| `COLLECTOR_LIMIT` | no | 15 |
| `COLLECTOR_DAYS_SINCE_LISTED` | no | 7 |
| `COLLECTOR_HTML_FILE` | no | unset means fetch live; a path parses that file instead |
| `COLLECTOR_DRY_RUN` | no | unset. Any value parses and prints and **never posts** |

**Defaults exist only where a wrong value cannot corrupt data.** `source`, the component type,
the coordinates and the radius have none: each of them scopes a stored row or an aggregate.

It prints one line of JSON on stdout and exits.

| exit | meaning |
|---|---|
| **0** | listings parsed, the POST returned 200, **and the Worker reported zero FAILED** |
| 2 | a required variable is missing. Nothing was fetched |
| 3 | `SOURCE_EMPTY` — nothing posted. Normal on a quiet day; see the alarm note below |
| 4 | `PROVIDER_FAILURE` — the page changed shape. **A human must look.** Nothing posted |
| 5 | transient: the source was unavailable or rate-limited, or the POST failed with 5xx or a network error. The next run is the retry |
| 6 | the POST was refused with a 4xx, or returned 200 while the Worker reported `FAILED > 0` |

**A repeated exit 5 across runs is a persistent server-side failure, not a transient one** —
measured: a one-listing batch whose only write fails answers 503 and lands on 5, so a *total*
write outage carries the quieter code and would otherwise retry silently forever. Check
`wrangler tail`.

**A repeated exit 3 is also worth looking at.** The four evidence markers are field names in one
GraphQL response and are not independent: a single wholesale rename could remove all four at the
same time as the listing anchor, and the collector would report an empty market forever. One
response cannot rule that out. The residual defence is an alarm on N consecutive empty runs,
which needs cross-run state and **is not built**.

### Schedule

**Every 30 minutes**, matching the monitoring cron. It is a one-shot process, not a daemon: one
request to the source, one POST, then it exits — no pagination, no cursor following, no retry of
either request, no internal loop. **A documented schedule is a weaker guard than a mechanism**,
and it was chosen over a marker file or a lock because that is state on a laptop the operator can
and will delete. The real exposure of a runaway is **Facebook**, not Cloudflare: 1,440
requests/day from one residential IP is where a block comes from. D1-side, every write is
idempotent, so a runaway wastes quota and does not corrupt.

No launchd plist is shipped. Building a daemon is how a laptop loop starts.

### Setting and rotating the token

```bash
openssl rand -hex 32                     # 64 characters; the Worker refuses anything under 32
npx wrangler secret put COLLECTOR_TOKEN  # interactively, never piped
npx wrangler secret list                 # verify it is there
```

The secret is re-read from the environment on every request, so rotating it takes effect on the
next call: set the new value, then update the collector's environment. Revoking is
`wrangler secret delete COLLECTOR_TOKEN`, after which the route answers 503 to everyone.

**Until `wrangler secret put COLLECTOR_TOKEN` has been run against production, the deployed route
answers `503 COLLECTOR_CONFIG_MISSING` to every request.** That is correct and intended: the
branch is dead until the secret exists. `wrangler.jsonc` and `wrangler.local.jsonc` deliberately
define no value — committing one would put a credential-shaped string in the repo *and* make
`npm run dev:worker` silently accept ingest.

**`wrangler tail` does not leak this header.** Measured against the deployed Worker with two
canary values (a custom header and an `Authorization` bearer): neither appears in the output, and
tail emits no request headers at all.

---

## A total write outage, and what each layer reports

Measured before this slice existed: a D1 whose classification read succeeds and whose per-listing
writes all fail returned

```
200 {"received":3,"stored":3,"outcomes":{...,"FAILED":3},"pricesUnparsed":0,...}
```

with **zero rows written**, and the collector exited 0. `stored` counts failures. So the route
now answers **503 `INGEST_STORAGE_FAILED` when every listing failed**, and the collector exits 6
whenever `outcomes.FAILED > 0`.

A **partial** failure still returns 200 with truthful counts. Refusing the whole batch would
discard the rows that did land, and `recordSightings`' deliberate "never let one poisoned listing
abort a scan" is a property this route must not undo.

---

## The evaluation consequence — read this before changing the settings mode

This is the first thing that ever puts rows into `evaluation_tasks` in production, and the
existing 30-minute monitoring cron drains them immediately. `dealRules.decide` runs the
maximum-price leg **before** the evidence gate, so it needs no model key:

| settings mode | what the drain emits for un-normalized listings |
|---|---|
| `DISCOUNT` | all `NEEDS_REVIEW / insufficient-evidence` — safe |
| **`MAXIMUM_PRICE`** | **`DEAL / within-maximum / COMPLETE` for every listing at or below the maximum — including a `CA$0` listing** |
| `BOTH` | `NOT_DEAL` above the maximum, `NEEDS_REVIEW / insufficient-evidence` below it — safe |

All three rows measured against the real `evaluateBatch` and the real `dealRules`.

**Until normalization lands, leave the evaluation mode on `DISCOUNT` or `BOTH`, not
`MAXIMUM_PRICE`.** Alerting is deferred, so today a `DEAL` verdict changes a database column and
nothing else — but the notification channel is the next thing being built, and the most
DEAL-looking row in the database would be the free listing this project was already bitten by.

`decide`'s ordering is **not** changed here. Gating the maximum-price leg on a non-null model key
is the evaluation layer's contract and needs its own adversarial pass.

---

## The parser, and how a blind parse stays loud

The collector reads the listing objects embedded in the page's Relay payload: find
`"listing":{"__typename":"GroupCommerceProductItem"`, brace-scan the object honouring string
escapes, `JSON.parse` it, validate `id`, `marketplace_listing_title` and `creation_time`. That
reads `object.id` rather than "the first `id` after the typename", which dissolves by
construction the hazard that every block contains a **second, nested photo `id`**.

Three detectors keep an empty answer honest:

- **evidence markers** — `GroupCommerceProductItem`, `marketplace_listing_title`, `listing_price`,
  `__isMarketplaceListingRenderable`. Measured 120 / 24 / 72 / 24 on a populated capture and
  **0 / 0 / 0 / 0** on a real empty one. They are a **boolean, never a count**: `listing_price`
  occurs 72 times for 24 listings because `min_listing_price` contains it as a substring, so any
  ratio built on them would be a fabricated number.
- **shell markers** — `CometMarketplaceSearchContentContainer`, `MarketplaceFilterField`,
  `marketplace_seo_page`. Measured **identical** on both captures (19 / 14 / 2).
- **counters** — `unparsedBlocks` and `rejectedBlocks`.

Measured and **rejected**: `captcha` occurs 24 times on a perfectly healthy page, so a
string-search captcha detector is a permanent false positive.

```
1. unparsedBlocks > 0   -> PROVIDER_FAILURE  block-unparseable
2. rejectedBlocks > 0   -> PROVIDER_FAILURE  listing-schema-changed
3. acceptedBlocks > 0   -> SUCCESS           ok
4. evidencePresent      -> PROVIDER_FAILURE  parser-blind
5. !shellPresent        -> UNAVAILABLE       unrecognized-page
6. otherwise            -> SOURCE_EMPTY      no-results
```

Two orderings are deliberate. **Any anomaly fails the whole page and posts nothing**, including
the case where five of six blocks parsed: partial data flowing into a running aggregate is slow,
silent corruption, and the three required fields are present on 24/24 captured blocks. And
**accepted listings outrank the shell check**, so a rename of Facebook's internal module names
gives a wrong telemetry label rather than a permanent self-inflicted blackout.

The request sends **seven measured headers**; dropping the `Sec-Fetch-*` set reproduces an HTTP
400. The exact `User-Agent` is the one value no test can pin — a wrong one surfaces as a clean
`UNAVAILABLE / unrecognized-page`, not a crash.

### The committed fixtures

`collector/testing/fixtures/facebookSearchPage.html` holds **6 of the capture's 24 listing edges,
verbatim**, and `facebookSearchEmpty.html` is built from the real empty capture. The only edit
inside a kept edge is the photo `uri`, which carried an expiring signed CDN token and was ~60% of
the bytes; **the escaped `\/` sequences and the nested photo `id` are preserved**, because that
nested id is the hazard the fixture exists to kill. Both files carry their provenance in an HTML
comment, and every derived variant in `collector/testing/fixtures.ts` is one string operation on a
real capture, so what makes a variant different is visible on one line.
