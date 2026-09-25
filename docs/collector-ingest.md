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
| `modelKey`, `variantKey` | **the server**, derived from the title against `src/data/catalog.ts` (`variantKey` is `null` for every component type in this slice) |
| `validity` | **the server**, from the same rule |
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
  "contributions": { "recorded": 1, "restored": 0, "removed": 0, "none": 0,
                     "skipped-no-price": 0, "skipped-no-model": 1, "skipped-invalid": 2 },
  "pricesUnparsed": 0,
  "usage": { "rowsRead": 3, "rowsWritten": 33 } }
```

Copied from a real `npm run e2e:local` run over the committed four-listing fixture, not composed
by hand. One of those four is a standalone catalog GPU at a positive price; the others are a
trade-only ad, a whole gaming PC whose title names a real GPU, and a GTX 1080 Ti the catalog does
not list.

Every key is always present, at 0 when it did not happen. `received` counts what was sent and
`stored` counts what `recordSightings` returned, so its last-wins de-duplication of a repeated
`listingId` is **observable without being reimplemented**. `200`, not `201`: this is an upsert.

**A failed listing's error string never crosses the wire.** It is `console.warn`ed with the
listing id for `wrangler tail`; a caller holding only a bearer secret must not learn the schema
from a failure.

**What each contribution key means now that normalization runs.** `recordSightings` reports
exactly one per stored listing, and it tests `validity` first, then the model key, then the
price:

| key | means |
|---|---|
| `recorded` / `restored` | the listing entered the benchmark; `restored` means its observation had been deleted and was recreated |
| `removed` | it used to contribute and no longer does — a re-sighting whose model key, market or price changed, or whose validity stopped being `VALID` |
| `none` | `UNCHANGED`: nothing about it moved |
| `skipped-invalid` | the rule refused it: wrong component, whole system, trade-only, for parts, a wanted ad, an unknown quantity, an ambiguous `CA$0`, or a title at the token cap |
| `skipped-no-model` | the rule accepted it as the right component and could not name it — a real component the catalog does not list |
| `skipped-no-price` | **newly reachable in this slice.** A listing that resolved to a catalog model and whose `priceText` did not parse. It was structurally unreachable only while `modelKey` was always null |

**`skipped-no-model` DOES NOT MEASURE CATALOG COVERAGE, and reading it that way undercounts by
about 3x.** Measured over the 15 live listings from one real GPU search:
`{skipped-invalid: 13, skipped-no-model: 1, recorded: 1}`. Three real, standalone, working GPUs
the catalog lacks are in that set, and only one of them (`AMD Radeon™ RX 6800 XT …`) reaches
`skipped-no-model`. `Gigabyte vision 3060ti (white)` and `Selling My 4070 TI` carry no
`rtx`/`gtx`/`geforce`/`radeon` token and no catalog match, so the rule declines to guess and they
land in `component-unconfirmed` → `NEEDS_REVIEW` → `skipped-invalid`.

**How the coverage number IS obtained, since no counter is being added for it.** The response
shape is not this slice's to grow. The number stays obtainable without one, because `validity`,
`title`, `price_cents` and `component_type` are all stored columns on `listings`:

```sql
-- lower bound: listings the rule accepted as the right component but could not identify
SELECT COUNT(*) FROM listings WHERE validity = 'VALID' AND model_key IS NULL;

-- upper bound: everything the rule declined but did not reject outright
-- (component-unconfirmed + unknown-quantity + ambiguous-zero-price + title-too-long, which SQL
--  cannot separate because the rule's `reason` is deliberately not stored)
SELECT COUNT(*) FROM listings WHERE validity = 'NEEDS_REVIEW';
```

**Neither single query is the number.** The exact figure needs the reason, and the reason is
recomputable rather than stored: `normalizeListing` is a pure function of `(title, priceCents,
componentType)` and all three are columns, so

```sql
SELECT title, price_cents, component_type FROM listings WHERE validity <> 'INVALID_REFERENCE';
```

replayed through that function offline yields the per-reason breakdown exactly. That is a read
plus a script, not a production code change, and it is the instrument whoever answers the catalog
question should use.

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

## How a title becomes a model key

Normalization runs **in the Worker**, inside `handlePostListings`, not in the collector. If the
collector sent `modelKey`, a leaked token would set it to *any string* and `validity` to `VALID`
directly, minting `model_stats` rows under keys no catalog model has. Server-side, the attacker's
levers reduce to `title` and `priceText` — which they already control — and the rule is one rule
for every client, testable offline.

`worker/normalize/catalogIndex.ts` owns the tokens and the match; `worker/normalize/normalizeListing.ts`
owns what a listing *is*. Both are pure functions of `(title, priceCents, componentType)`.

### Tokens, and a cap that fails closed

Lower-case, split on every non-alphanumeric character, then split each run at its letter/digit
boundaries — so `"rtx5080"`, `"RTX 5080"` and `"RTX-5080"` tokenize alike. There is deliberately
**no `normalize("NFKD")`**: measured, `"RTX™".toLowerCase().normalize("NFKD")` is `"rtxTM"`,
because U+2122 decomposes to an upper-case `TM`, and 0 of the 176 catalog names contain a
non-ASCII character anyway.

The tokenizer stops at **64 tokens**. A title that reaches that bound *may* have been truncated,
so it is answered `NEEDS_REVIEW` with a null key **before any other rule runs** — it is not
silently shortened. Every one of the six disqualifier classes lives in the title text a
truncation would discard, and a legal 146-character title can carry a catalog model with its
`gaming pc` beyond the cut. Measured: the longest catalog model is 11 tokens and the longest of
the 15 live titles is 18, so nothing real is near the bound.

### The match: a prefix trie per component type, and three guards

Each component type gets a trie built once at module load from its catalog names, plus every
suffix obtained by dropping a leading `geforce`/`nvidia`/`radeon`/`amd`/`intel` — 176 models,
199 entry points. Series words (`rtx`, `rx`, `gtx`, `arc`) are **not** droppable: a bare `5080`
in the trie would match Dell's OptiPlex 5080. The cost is that `"Selling my 4070 Super"` is a
miss, and a miss is safe.

Each start position is walked greedily, and a hit is admissible only if all three guards pass:

**Rule 8 asks what the word `free` is attached to, and that is deliberate rather than a list.** A
denylist of the other thing — shipping, pickup, delivery — was built and replaced: it needed
patching twice inside one review round, because the tokenizer splits `pick up` into two tokens,
and a word list cannot tell `"free … pick up only"` — a free card collected in person — from
`"free pick up"`. Requiring the token after `free` to be the item closes the family with nothing
to maintain. Its errors land in the safe direction by construction: a free listing cannot reach a
benchmark at all (`recordSightings` requires `priceCents > 0`), so refusing one costs no reference
and only removes a spurious `DEAL`.

| guard | rule | what it prevents |
|---|---|---|
| deepest terminal | take the deepest complete name, not the first | `RM850x Shift` collapsing into `RM850x` |
| no extension | the walk must not continue past the last complete name | `"Noctua NH-D15 G3"` → `NH-D15` |
| end of run | the last matched token must end its character run | `"Ryzen 7 7700X3D"` → `Ryzen 7 7700X` |
| no SKU suffix | the next token is not one of thirteen variant words (`ti`, `super`, `xt`, `xtx`, `gre`, `redux`, `le`, `chromax`, `rgb`, `d`, `ii`, `touch`, `argb`) | `"RTX 5070 Ti Super"` → `RTX 5070 Ti` |

Two or more distinct models in one title is a refusal, not a choice.

### The twelve rules, in order — first match wins

```
0.  capped title      the tokenizer returned 64 tokens                      -> NEEDS_REVIEW
1.  wanted ad         wtb, want to buy, wanted, looking for, iso, ...       -> INVALID_REFERENCE
2.  trade only        for trade, trade only, swap, trading, ...             -> INVALID_REFERENCE
3.  broken / parts    for parts, not working, damaged, as is, ...           -> INVALID_REFERENCE
4.  whole system      a system brand or product line, or an uncovered whole-unit
                      token (pc, tower, build, rig, laptop, notebook,
                      desktop, ...)                                         -> INVALID_REFERENCE
5.  foreign parts     another component type is evidenced                   -> INVALID_REFERENCE
6.  multiple models   two catalog models of the declared type               -> INVALID_REFERENCE
7.  unknown quantity  lot of / bundle / pcs / two / three / both, a `pack`
                      token, or an `Nx` multiplier in the first two tokens
                      or the last two                                       -> NEEDS_REVIEW
8.  placeholder zero  price 0 and nothing says the ITEM is free: `free` must
                      LEAD the title and the NEXT token must belong to the
                      item -- a marker phrase, or the matched model itself   -> NEEDS_REVIEW
9.  unconfirmed       no catalog match and no marker for the declared type  -> NEEDS_REVIEW
10. unmatched         the right component, not in the catalog   -> VALID, modelKey null
11. matched           exactly one catalog model                 -> VALID, that model
```

Rule 4 is neutralised by a marker of the **declared** type, so `"Lian Li Lancool 216 PC Case"`
under a `case` search is a case and not a PC. Rule 7's `pack` is **not**: a fan pack really is a
pack, on the one component type where Arctic, Noctua and Corsair all sell in 3- and 5-packs.

**Rule 4's whole-unit tokens include `laptop`, `notebook` and `desktop`.** `desktop` was
excluded at first because the bare token fires on the catalog's own product wording —
`"AMD Ryzen 7 9800X3D Desktop Processor"`, `"Kingston Fury Beast 32GB DDR4 desktop memory"` —
and that argument stopped being true once `MARKERS.cpu` gained `desktop processor` and
`MARKERS.ram` gained `desktop memory`: those phrases **cover** the word exactly as `pc case`
already covers `pc`. Both titles resolve to their catalog models, and `"Dell Desktop GeForce RTX
4060"` — a CA$1,100 prebuilt that was writing itself into the 4060 benchmark — is refused.

**That question has a general answer, so it is not re-asked each round.** A marker can only
neutralise a **whole-unit token**: `systemEvidence` is the single place coverage is consulted,
while `SYSTEM_PHRASES`, `MULTIPLE`, `MULTI_UNIT` and both multiplier predicates are checked
unconditionally. Measured over the other seven words excluded on a collision argument — `dual`,
`x 2`, `x 3`, `aorus`, `nitro`, `predator`, `katana` — **none is marker-dissolvable**, on two
independent grounds: none sits in a marker-neutralised vocabulary, and no marker phrase contains
any of them. Their collisions are with catalog model names and with component product lines,
which a marker cannot dissolve by construction.

**Eight system-only product lines** (`razer blade`, `legion`, `omen`, `victus`, `zephyrus`,
`xps`, `ideapad`, `pavilion`) are the second detector for a machine whose title names no
whole-unit word at all, such as `"Razer Blade 16 RTX 5080"`. **Four brand candidates were refused
on measured collisions:** `aorus` (5 catalog motherboards, and Gigabyte's GPU line), `nitro`
(`Sapphire Nitro+` is a mainstream AMD board-partner GPU line), `predator` (Acer sells Predator
RAM and NVMe drives) and `katana` (`Scythe Katana` is a mainstream tower CPU cooler) — the last
of these was **admitted for a round and caught on re-review**, because the corpus guarding these
words held a title for every *rejected* word and none for any *accepted* one, so it could only
ever confirm a refusal. It now carries a row for each accepted word too.

**Rule 7's multiplier is POSITIONAL, at both ends, and the bound is the whole design.** An `Nx`
within the **first two** tokens and an `x2` in the **last two** are counts. The first two rather
than the first one because a single verb before the quantity is this marketplace's house style —
`"Selling My 4070 TI"` is one of the 15 real listings, and `"Selling 2x GeForce RTX 5080"` was
storing twice the unit price as one card's price.

An `Nx`-**anywhere** form is not shippable, and the two rejections behind that have **different
evidence that must not be quoted for each other**. As a *phrase*, `x 2` matches the catalog name
`WD Black SN850X 2TB` and `x 3` matches 8 X3D CPUs. As an *unbounded predicate*, it fires on
`"Ryzen 5 9600X processor"` and five other X-suffixed CPUs, on all four X-suffixed Corsair PSUs
once any word follows, and on `"MSI RTX 5080 Ventus 3X OC"`, a real cooler designation — every one
of those at index 2 or beyond, which is exactly where the bound stops. `dual` was refused too:
`ASUS Dual` is a real board-partner cooler line.

**Quantity needs no schema change and gets none.** `recordSightings` computes its aggregates with
an implicit quantity of 1, so a `quantity` column nothing reads would be a lie in the schema.
Rule 7 handles it by refusing to contribute.

**Price is never a classification signal.** A CA$2,000 listing may be a PC or an RTX 5090; the
live 5080 is CA$3,000. Any threshold would be a fabricated number.

### What is proven, and what is not

- **176/176** catalog names, declared as their own component type, resolve to themselves.
- **0 of 1,408** cross-type pairs produce a `VALID` result carrying a model key.
- **10** sub-phrase overlaps exist across the eighteen vocabularies, all of them known and
  pinned; an eleventh fails the suite.
- CPU, measured in Node on a development machine rather than in workerd — the same caveat
  `worker/evaluation/evaluationCpu.test.ts` carries, and re-measured after the vocabularies grew:
  **p95 0.22 ms** for a 15-listing window, and **p95 3.3 ms** (3.29–3.36 over three consecutive
  runs) for the worst legal batch — 100 listings × 300-character titles one token under the cap,
  which is the expensive side of it, since a title that *hits* the cap short-circuits at rule 0
  and costs 0.21 ms. The repo's own invariant is p95 < 8 ms, and the test asserts against it
  rather than against these figures.

### The residuals, named — and the corpora they are measured from

**Every figure below is measured from a corpus committed in
`worker/normalize/normalizeListing.test.ts`** — `STANDALONE_COMPONENTS` (28 titles),
`WHOLE_MACHINES` (30), `BOARD_PARTNER_TITLES` (6), `ACCEPTED_BRAND_WORD_TITLES` (8),
`FREE_PHRASINGS` (17) and `SKU_SUFFIX_PHRASINGS` (20).

**These are not the corpora the earlier figures came from, and the numbers are not continuous
with them.** The previous "3 of 24" and "1 of 29" were quoted from sets that lived only in a
scratch directory and could not be re-derived by anyone reading the repo. The 24-title set was
recoverable and is committed verbatim — its true figure is **4**, because the earlier count
omitted one decline. **The 29-title set was not recoverable, so "29 of 30" below is measured
against a NEW corpus built for this pass**, covering the machine shapes the old set missed:
titles carrying only a laptop word, or only a product line. Do not read it as the old number
having improved by one. That old set's gap is how a laptop's whole price reached a GPU benchmark.

1. **`"Corsair RM850x 2021"` still pools into `Corsair RM850x`.** Year-suffixed revisions are an
   unbounded class; enumerating years would prove the suffix list open-ended rather than close it.
2. **One machine in thirty still reads as a standalone GPU.** `"MINT custom x17 R2 Flagship
   Ecosystem - RTX 5080 (16GB)"` — a laptop with the whole-unit word, the system brand and the
   foreign-component marker all stripped out. Its live counterpart is caught twice over.
3. **Two multi-unit forms are still uncaught, both in the INFLATING direction.**
   `"Selling my 2x RTX 5080"` — **two** words before the count, where the predicate reaches one —
   and `"Dual GeForce RTX 5080"`, where `dual` collides with the `ASUS Dual` product line and so
   can never be a count word here. Both put N units' price into a one-unit benchmark, which makes
   genuine listings look like deals. The second is a **permanent** residual rather than an
   oversight; the first would cost the collisions listed above to close.
4. **8 of 28 realistic standalone-component titles are declined** that a human would accept:
   three from the token `build` or the phrase `gaming PC`; one from the deliberate choice that a
   fan pack really is a pack; three from the quantity words (`"two months old"`,
   `"fits both AM4 and AM5"`, and `"32GB 2x16"`, which PLAN.md:54 calls one kit); and one from the
   multiplier bound (`"AMD 9600X processor"` — a bare SKU with one word in front of it). Every one
   costs a lost reference, never a wrong one. **The figure has moved twice and both moves are the
   point:** it was reported as 3 when it was 4, and the four quantity shapes were simply not in
   the corpus until the vocabulary that declines them was reviewed.
5. **A model name truncated to `<letters> x <digits>`** — `"G.Skill Flare X5"` with nothing after
   it — reads as a trailing count. A lost reference, in the safe direction.
6. **A genuinely free item is `NEEDS_REVIEW` whenever anything sits between `free` and the item**
   — `"Free to a good home GeForce RTX 5080"`, or the same phrase written tail-first. Rule 8
   requires the token after a leading `free` to be the item. A free listing cannot reach a
   benchmark in any case, so this costs a `DEAL` verdict rather than a reference.
   `FREE_PHRASINGS` (17 real phrasings) is the committed corpus that keeps the family
   re-measurable; it found two live defects on its first run.
7. **Seven real SKU-variant phrasings still pool into their base model** — a year suffix
   (`RM850x 2021`), a form factor (`Focus GX-850 ATX 3.0`), an `A-RGB` that tokenizes as two
   words, `North XL TG`, a `DDR5 EXPO` kit, `SF1000 Platinum` and `4000D Airflow Core`. Each is a
   word deliberately NOT added to the suffix list, for a reason stated per row in
   `SKU_SUFFIX_PHRASINGS`: it is a form factor, or a feature the catalog entry already has, or a
   word that may name the catalog entry itself rather than a variant of it. **This is the
   money-losing direction** — two different products averaged together — and it is the residual
   that is measured rather than closed. The corpus found ten mis-pools in twenty titles when it
   was written cold; three were closed by adding `ii`, `touch` and `argb`.
8. **A component pulled from a machine of an admitted brand line** — `"RTX 4070 pulled from a
   Razer Blade 16"` — is refused as a whole system. Correct for a laptop part, which is a
   different product from its desktop namesake; a lost reference for a desktop part.
   `ACCEPTED_BRAND_WORD_TITLES` carries one row per admitted word.

Residuals 1, 2, 3 and 5 are pinned as expected-to-behave-this-way rows in `ACCEPTED_EXPOSURE`,
and 4, 6, 7 and 8 are pinned by the corpora named above, so the next one is visible rather than
discovered in an aggregate.

---

## What a leak of the collector token would let an attacker do

> A leaked `COLLECTOR_TOKEN` lets an attacker insert rows into `listings` and enqueue
> `evaluation_tasks` under any `source`, `market` and `componentType` they choose, and — for any
> `(source, listingId)` they can guess — overwrite every mutable column of an existing listing
> row. `first_seen_at` is the one column that survives.
>
> **The structural protection this paragraph used to claim is gone, and this is the slice that
> spent it.** PR #13's plan predicted it: "no request to this route can insert a row into
> `price_observations` or increase a `model_stats` row" was true only while `model_key` was
> hardcoded `NULL`. Normalization now derives it, so **a leaked token can create a
> `price_observations` row and increase a `model_stats` row**, by posting a title the server's
> own rule resolves to a catalog model together with a positive price.
>
> What the server still decides: `model_key` is not a wire field and cannot be chosen directly —
> it is one of the 176 names in `src/data/catalog.ts` or `NULL`, and only a title the rule
> resolves to that model produces it. `variant_key` is written as `''` by `recordSightings`'
> `normalizeVariantKey`. `validity` comes from the same rule, so a listing the rule refuses
> cannot be marked `VALID`, and `model_key IS NOT NULL` implies `validity = 'VALID'`.
> `price_cents` is still computed by the server from `priceText`.
>
> **What that leaves is the real exposure, stated plainly: a leaked token can move a model's
> benchmark.** `model_stats` holds only `(count, total_price_cents)` — **an untrimmed running
> mean. There is no outlier filter anywhere in the Worker; PLAN.md section 4 specifies an IQR
> trim and it is not built.** One fabricated row added to a pool of `count` genuine ones shifts
> the average by **`1/(count + 1)`** of the gap between the fabricated price and the current
> mean, and `MINIMUM_REFERENCE_COUNT = 5` is the only bar. The route can also still *decrease* a
> contribution by re-posting a known id, which the e2e exercises as its control.
>
> It still reads no settings, no evaluation results, no user identity, and not even the error
> text of a failed write. **What it can read has grown, and an absolute claim here would be
> false.** As before, the response tells a caller whether a `(source, listingId)` it guesses
> already exists, and whether a guess at that row's contents is exact, because `UNCHANGED` is
> returned only on a content-hash match. **New in this slice: `contributions` now distinguishes
> `recorded` / `restored` / `removed`, which were structurally unreachable while every row
> reported `skipped-no-model` — so the response now also tells a caller whether a guessed
> `(source, listingId)` is currently contributing to a benchmark.** The `rowsRead` figures the
> previous version of this paragraph quoted are not carried over: once a listing contributes, the
> CHANGED path runs three more statements, and no one has measured what `usage.rowsRead` reports
> then. It cannot reach `/api/settings` or `/api/auth/session`, and cannot be used from a
> browser, from any origin.
>
> The mitigation is now the token's secrecy, rotation and `wrangler tail` visibility — not the
> shape of the route.

One rider:

- **The route can already *decrease* a contribution.** Re-posting a known `(source, listingId)`
  that currently contributes takes `recordSightings`' `removed` path. It is deliberately
  exercised as the end-to-end control, which **moved to listing `1812246723463464`** — a real
  GPU the catalog does not list, so the rule answers `VALID` with a null key — because
  `915010494744438` now contributes on its own and can no longer stand in for a listing whose
  contribution must disappear.

The rider this block used to carry first — that the structural-benchmark property *expires* when
normalization lands — is spent, not deleted: the paragraph above is what replaced it.

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
maximum-price leg **before** the evidence gate, so it needs no model key — and normalization
narrows what that leg can see, without closing it:

| the listing | before normalization | now |
|---|---|---|
| wrong component, whole system, trade-only, for parts, a wanted ad | reached the drain as `VALID` | `INVALID_REFERENCE` → `NOT_DEAL / COMPLETE`, before any rule runs |
| an **ambiguous** `CA$0` — nothing in the title says the item is free | `DEAL / within-maximum` under `MAXIMUM_PRICE` | `NEEDS_REVIEW`, so it is not a `DEAL` |
| an **explicitly free** `CA$0` — the title leads with `free`, or says `free to a good home` | `DEAL / within-maximum` | **unchanged: still `DEAL / within-maximum`.** It is `VALID` at a zero price, and `decide` runs the maximum-price leg before the evidence gate |
| a real component **the catalog does not list**, priced under the maximum | `DEAL / within-maximum` | **unchanged: still `DEAL / within-maximum`** — it is `VALID` with a null model key |

**Do not read row 2 as "a `CA$0` listing can no longer be a `DEAL`".** It cannot be one *while
the title is ambiguous*. `parsePriceText` returns `0` for `"CA$0"` — which is how Facebook renders
a genuinely free item — and `null` for the word `"Free"`, so a real zero does reach the rule, and
an explicitly free one is still `VALID` at `0`. Rows 3 and 4 are the two ways a `DEAL` verdict
still comes out of a zero or a low price on no benchmark evidence.

**Leave the evaluation mode on `DISCOUNT` or `BOTH`, not `MAXIMUM_PRICE`.** The instruction
stands, and rows 3 and 4 are why: the catalog is current-generation only and most real supply is
older, so a genuine but uncatalogued card under the maximum still reads as a deal on no evidence
at all, and a free listing reads as the best deal in the database. Alerting is deferred, so today
a `DEAL` verdict changes a database column and nothing else — but the notification channel is the
next thing being built, and the free listing is the row PR #6 exists because of.

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
