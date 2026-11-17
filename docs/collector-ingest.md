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
  collector: --GET--------------------> /api/watch-targets   (what to hunt, and where)
             per target: fetch -> parse
                        --POST--------> /api/listings -> recordSightings -> aggregate
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
| `componentType` | the envelope, checked against an exhaustive set with `Object.hasOwn` — and that is **which search found the listing**, not what is stored: the stored `component_type` is the type **the server** resolves from the title, falling back to the envelope's (see [the type comes from the title](#the-type-comes-from-the-title-when-the-title-proves-it)) |
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
trade-only ad, a whole gaming PC whose title names a real GPU, and a GTX 980 Ti the catalog does
not list.

**That last title is load-bearing, and it has already been changed once.** It was a GTX 1080 Ti
until `src/data/catalog.ts` was extended two generations back, at which point it matched a
catalog model and took seven `npm run e2e:local` assertions down with it — including the removal
control, whose seed `INSERT` then collided with the row the listing writes for itself, so the
control could not be seeded at all rather than merely reporting a different number. It is the
only fixture listing that is `VALID` with a null model key, so the control has nowhere else to
live. Maxwell (GTX 900) is now the only generation left that keeps it uncatalogued: **do not add
GTX 900 cards to the catalog without rewriting that block of `scripts/e2e-local.sh` first.**
`GENERATION_TITLES` in `worker/normalize/normalizeListing.test.ts` pins the same title, so the
13-second suite says so before the expensive gate does.

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
| `removed` | it used to contribute and no longer does — a re-sighting whose model key, market or price changed, or whose validity stopped being `VALID`. A catalogued listing re-sighted by a search of another type no longer lands here — that used to be the dominant source of this key. The last case of it, a real part whose title carries an accessory word, is gone too: the accessory refusal is now a property of the title, so it is refused under every search (see [the accessory rule](#the-type-comes-from-the-title-when-the-title-proves-it)) |
| `none` | `UNCHANGED`: nothing about it moved |
| `skipped-invalid` | the rule refused it: wrong component, whole system, trade-only, for parts, a wanted ad, an accessory, an unknown quantity, an ambiguous `CA$0`, or a title at the token cap |
| `skipped-no-model` | the rule accepted it as the right component and could not name it — a real component the catalog does not list |
| `skipped-no-price` | **newly reachable in this slice.** A listing that resolved to a catalog model and whose `priceText` did not parse. It was structurally unreachable only while `modelKey` was always null |

**`skipped-no-model` DOES NOT MEASURE CATALOG COVERAGE, and the catalog slice made that sharper
rather than softer.** Re-measured over the same 15 live listings from one real GPU search, now
against the 336-name catalog: `{skipped-invalid: 13, recorded: 2}` — **`skipped-no-model` is
now 0**. It was `{skipped-invalid: 13, skipped-no-model: 1, recorded: 1}` when the catalog held
176 names, and the single row that used to sit in `skipped-no-model` was `AMD Radeon™ RX 6800
XT …`, which is now catalogued and recorded.

A counter that reads 0 while real, standalone, uncatalogued GPUs are in the batch is exactly why
it is not a coverage meter. Two of them are still there: `Gigabyte vision 3060ti (white)` and
`Selling My 4070 TI` carry no `rtx`/`gtx`/`geforce`/`radeon` token and no catalog match, so the
rule declines to guess and they land in `component-unconfirmed` → `NEEDS_REVIEW` →
`skipped-invalid`, never in `skipped-no-model`.

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

replayed through that function offline yields the per-reason breakdown exactly. **The stored
`component_type` is the resolved one, and replaying it is exact rather than approximate**: the
resolution depends on the title alone when it fires and returns its input when it does not, so
`normalizeListing` over a stored row's own type returns that row's own classification. That is a read
plus a script, not a production code change, and it is the instrument whoever answers the catalog
question should use.

**The script exists: `scripts/replay-normalization.ts`.** Offline, plain `node`, no network:

```sh
npx wrangler d1 execute marketplace-deal-finder-db --remote --json \
  --command "SELECT listing_id,title,price_cents,component_type,validity,model_key FROM listings" \
  > listings.json
node scripts/replay-normalization.ts listings.json
```

It runs every row through **the checked-out commit's** `normalizeListing` under its stored
`component_type` and prints (a) the per-reason breakdown, (b) yield — distinct `listing_id`s
carrying a model key, stored versus this commit, (c) every row whose key, validity or type this
commit would change, with its title, so **every gained key is hand-checked before a rule change
ships**, and (d) the unkeyed components (`model-unmatched`, `component-unconfirmed`,
`unknown-quantity`) to hand-label into catalog candidates. A row whose stored type is outside the
nine is listed, not replayed. The logic lives in `worker/normalize/replay.ts`; the script is
covered by `npm run check` through `scripts/replay-normalization.test.ts`, which runs it as a real
`node` process over a committed export (`worker/normalize/testing/d1ListingsExport.json`).

**And the yield measured against labels: `worker/normalize/liveCorpus.test.ts`.** The replay
says what a commit WOULD change; it cannot say whether a key is RIGHT, because production rows
carry no labels. The live corpus can: 141 real titles from two pulls of the nine production
searches, each hand-labelled as one catalogued component (with its model), one uncatalogued
component, or not a standalone component, and each run under every search that returned it.
Two hard gates — **0 wrong keys** (a keyed title carries its label's model and type under every
search) and **no non-component keyed** — and a pinned floor: on master `404677e`, **36**
standalone components, **13** catalogued, **9 of 13** keyed under every search. Part 2 raised it
to **11 of 13** with two match rules (below) and names the two remaining misses in the test. A
rule change that should raise yield moves that floor on purpose; one that lowers it, or keys
anything wrongly, goes red. PR 2.4 moved it by catalog rather than by rule: **12 of 14**, because
`Ryzen 7 3800X` entered the catalog and its one corpus title moved from uncatalogued to catalogued.

**How a model earns a catalog entry: replay frequency, at least 3 distinct `listing_id`s.** Every
row in section (d) of the replay is hand-labelled to a candidate SKU at the catalog's own
granularity, or to "generic / not a catalogable model". A candidate is added only when **3 or more
distinct `listing_id`s** name it; reposts are not merged (PLAN §3), and the bar is the only thing
that moves the "two generations back" boundary. Generic spec-only RAM and storage (`"Ram DDR4
16gb"`, `"WD 1TB NVMe"`) is not catalogued: it names no SKU. On the 1,475-row production export
of 2026-11-16 the 458 rows of (d) cleared the bar for **one** model (`Ryzen 7 3800X`, 3 ids; yield
79 → 82). Eight more candidates had 2 ids each and were not added. Of the 458 rows, 43% are not PC
parts at all (mostly the `power supply` search), 15% are whole machines or devices, 7% are
generic spec-only RAM/SSD/HDD, and the remaining PC parts are spread across ~90 SKUs that each
appear once.

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
because U+2122 decomposes to an upper-case `TM`, and 0 of the 337 catalog names contain a
non-ASCII character anyway.

The tokenizer stops at **64 tokens**. A title that reaches that bound *may* have been truncated,
so it is answered `NEEDS_REVIEW` with a null key **before any other rule runs** — it is not
silently shortened. Every one of the six disqualifier classes lives in the title text a
truncation would discard, and a legal 146-character title can carry a catalog model with its
`gaming pc` beyond the cut. Measured: the longest catalog model is 11 tokens and the longest of
the 15 live titles is 18, so nothing real is near the bound.

### The match: a prefix trie per component type, and three guards

Each component type gets a trie built once at module load from its catalog names, plus every
suffix obtained by dropping a leading `geforce`/`nvidia`/`radeon`/`amd`/`intel`/`core` — 337
models, 424 entry points (the names plus 87 vendor-stripped cores: geforce 43, radeon 20,
intel 5, core 19). Series words (`rtx`, `rx`, `gtx`, `arc`) are **not** droppable: a bare `5080`
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

**Two ways a seller's wording differs from a catalog name are bridged, and both only ADD matches
(Part 2, measured against the live corpus: +2 keyed, 0 wrong keys):**

- **MSI's tier word is optional inside a name.** `mag`, `mpg` and `meg` may be left out —
  `"MSI B850 Tomahawk Max Wifi"` is `MSI MAG B850 Tomahawk MAX WiFi`. 13 catalog names carry one,
  each still matches in full, and 0 of the 13 extra entry points equals any other name. ASUS
  `ROG Strix` / `TUF`, Gigabyte `Aorus` and MSI `PRO` are **not** optional: each names a board
  whose model number a cheaper sibling shares, so dropping it is how two prices pool.
- **A two-module kit spec right after the capacity is stepped over.** `"G.SKILL Ripjaws V 16GB
  (2x8GB) DDR4"` is `G.Skill Ripjaws V 16GB DDR4` — but only when there are **2** modules and
  2 × size = capacity. A `32GB (4x8GB)` kit is a different pool from the two-module kit the name
  means and stays unmatched, as does a spec that does not multiply out.

### The type comes from the title when the title proves it

`listings` is keyed `(source, listing_id)` and holds **one** `component_type`, and Facebook
returns the same listing to searches of different types. Classified under the search's type, a
catalogued listing flipped on every run: `VALID` with its model under its own search,
`INVALID_REFERENCE` / `wrong-component` under the other. Each flip removed its price
contribution, the next restored it, and both re-queued evaluation. **Measured in the October
production log: 167 `removed` and 170 `restored` events against only 38 `recorded`.** By
construction (`recordSightings` contributes only `VALID` + model + positive price, and removes
only when a stored contribution stops being desired), every one of those was a model-matched
cross-type flip.

**The rule, applied before rules 1–11:** if **exactly one** type is evidenced (by a marker or a
catalog model) **and that type has a catalog model match**, the listing is classified — and
stored — under that type, unless the title reads as an accessory (below). Otherwise it is
classified under the envelope's type, exactly as before. The rules below then run under the resolved type; `normalizeListing` returns it, and the
ingest route stores it and hashes it into `content_hash`. Both clauses are load-bearing and each
has a test that goes red without it: the model clause stops a single marker word retyping a
listing (`TR-m*`), and *exactly one* stops a two-type bundle landing under whichever type is
listed first (`TR-2`, which asserts the type and the reason, because the mutant is `INVALID`
too). There is deliberately **no** "the declared type is not evidenced" clause: when the single
evidenced type is the declared one, resolving to it changes nothing, so the clause is an
equivalent mutant.

**What reads the stored type, checked:** the dashboard's server-side component filter
(`worker/api/verdicts.ts` `WHERE_MARKET_AND_SELECTION`) now shows a card found by a cpu search under gpu,
which is the point; the `(component_type, model_key)` pair stays consistent with the catalog,
because a model key is only ever produced from the resolved type's own index; evaluation does
not read the column; and the watch list is a different table. **No migration**: existing rows
converge on their next sighting, as a `CHANGED` re-write.

**The residual, stated honestly.** A cross-type title evidenced by a **marker only** still flips
between `VALID` with a null key and `INVALID_REFERENCE` across searches — measured over the
132-id live sample (217 sightings from nine searches), **4 ids** when this was written:
`"MSI B850 Tomahawk Max Wifi Motherboard Only"`, `"Ram DDR4 16gb 2x8gb 3000MHz"`,
`"5-Bay Hard Drive Station"` and a Microsoft Surface Pro whose only marker is `SSD`. **Part 2 took
the first off the list**: with MSI's inner `MAG` droppable, that board now names its catalog model,
resolves to `motherboard` from every search, and is keyed — **3 ids** remain. They carry no key, so **no aggregate ever moves**. Their
stored validity is whichever search saw them last, and **each flip re-queues evaluation**:
`recordSightings` queues a task on `NEW`, when the contribution changes, and when the stored
validity or asking price changes — the last term exists for exactly these listings, which have no
contribution on either side. So the verdict follows the stored validity. The cost is measured: a
flip writes 4 rows to queue the task and 8 to judge it again, against 1 for the listing row
alone. (Before that term existed, the verdict went stale relative to the stored validity.) **A wider, quieter
version of the same thing:** 30 of the 132 ids have a stored row that depends on which search saw
them last — the 4 above plus 26 whole machines, bundles and unconfirmed titles that are refused
under every search but evidence no single catalogued type, so they fall back to the search's type
and `component_type` (and so `content_hash`) alternates. Each such sighting is a `CHANGED` row
re-write with the same refusal and no re-queue; none carries a key. **The same sample contains no
model-matched cross-type id at all**
(the production log's flips came from other listings on other days), so the sample measures the
residual, not the fix; `L16` and the two-type block of `scripts/e2e-local.sh` measure the fix.

**An accessory is refused under every search.** An accessory search returns accessories that
name the part they fit — `"12VHPWR cable for RTX 4090"` from a psu search evidences one type
(gpu) with a catalog model — and the resolution alone stored each one as a `VALID` reference for
that part: a CA$15–90 observation in the model's mean, and once 5 references exist the accessory
itself a `DEAL`. There is no outlier trim, so one CA$20 box among five CA$2,000 references moves
the mean about 16%. So a title that carries an `ACCESSORY` phrase (`cable(s)`, `adapter`,
`bracket`, `waterblock` / `water block`, `backplate`, `riser`, `mount(ing)`, `shroud`,
`thermal pad(s)`, `fan(s)`, `replacement`, `box`, `holder`, `stand`) or reads
`for <catalog model>` — `for` directly before a matched model of any type, never a bare `for`,
because `"for sale"` is everywhere — is refused `NEEDS_REVIEW` / `accessory` (rule 3b below),
**whichever search found it**, and keeps the search's type: a refused row is not filed under
the type of the part it fits.

**Why every search (PR 2.3).** PR #21 applied the refusal only when the resolution would
**change** the type, and that scope left two defects, both now closed:

- **The same-type hole is closed.** `"GPU support bracket RTX 4090"` from a **gpu** search was a
  `VALID` RTX 4090 reference. It is now `accessory` under every search (`AX-r`).
- **The flip is gone, by construction.** A real part whose title carries an accessory word was
  `VALID` with its model under its own search and `accessory` under a foreign one, so each
  re-sighting removed, then restored, its contribution and re-queued evaluation. The rule now
  reads the title alone — the search's type is not an input to it — so validity, reason and key
  are the same under all nine searches (`AX-s`, and every `ACCESSORY_EVERYWHERE` row is asserted
  under all nine).

**The exemptions, and only these.**

- **`fan` / `fans` when the title itself evidences `case_fan`** (a marker or a catalog model) —
  a case fan is a fan, and five catalog names carry the word (`Lian Li UNI FAN SL120 V2`, …), so
  without it T11 goes red. It is keyed on the **title**, not on the search: keyed on the search it
  would refuse the Lian Li fan from a gpu search and admit `"RTX 3080 FE fan"` from a case_fan
  search as an RTX 3080. A title that evidences case_fan **and** another type is refused by rule 5
  anyway, so the exemption can only ever let a pure fan through. `"RTX 3080 replacement fan
  92mm"` and `"GPU fan PWM 4pin replacement for RTX 3070"` evidence only gpu and stay refused;
  `"Arctic P12 PWM case fan for RTX 4090 build"` evidences two types and stays refused.
- **`open box`** — a sale condition, not a box. The live case is `"ASUS PRIME Z270-A ATX
  Motherboard – New, Never Used, Open Box"`. Any other `box` in the same title still counts.

**Deliberately NOT exempt.** No inclusion-clause grammar (`with` / `w/` / `includes`):
`"EK Quantum Vector RTX 3080 w/ backplate"` is a waterblock that names none, and an exemption for
what follows `with` would key it as an RTX 3080. And never `box`, `original box`, `backplate`,
`waterblock` or `cable`: `"RTX 4090 original box"` is an empty-box sale. No own-words for coolers,
cases or PSUs either — each would reopen a wrong key (`"Noctua NH-D15 fan"` is a replacement fan,
`"Corsair RM850x cable kit"` is cables).

**The accepted losses, by phrase.** Real parts now refused under every search, pinned in
`ACCEPTED_EXPOSURE`. Each is a lost reference, never a wrong one:

- `"... with all cables"` — `"Corsair RM850x Shift power supply with all cables"` (psu, `AX-c`,
  which was `VALID` under #21)
- `"... with 2 fans"` — `"Noctua NH-D15 with 2 fans"` (cpu_cooler)
- `"... with backplate"` — a GPU sold with its backplate
- `"... new in box"` — a GPU sold boxed
- `"... triple fan"` / `"... dual fan"` — a GPU's cooler descriptor

**An exemption is added only when the production replay measures real parts lost to that exact
phrase** — not because a phrase reads as plausible. **The one candidate family, pre-named:**
fan-count descriptors (`dual` / `triple` / `twin fan`). If it ever ships it must come with pinning
rows keeping `"RTX 3080 triple fan shroud"` and `"RTX 3080 triple fan replacement"` refused.

**The first production replay (1,408 stored listings, master 907d3d8) did exactly that, three
ways.** It found two wrong keys and one measured loss, and this is what each became:

- **`support` is out of `ACCESSORY`.** It was the only accessory word in three stored titles.
  Two were real PSUs, stored with keys, that master would have refused: Corsair's own `"RM1000x …
  ATX 3.1 Compliant – PCIe 5.1 Support"` and its RM850x twin. The third, a Jeep tailgate `"Power
  Lift Support"`, carries no key either way. No accessory was caught by `support` alone;
  `"GPU support bracket RTX 4090"` (`AX-r`) is still refused by `bracket`.
- **`buying`, `looking to buy` and `we buy` are wanted-ad words.** `"Buying RTX4090"` was keyed as
  a VALID RTX 4090 once the resolution let a cpu search reach it. Bare `buy` is not added, because
  `"buy now"` is sale phrasing.
- **Motherboard chipsets are motherboard evidence** (`CHIPSETS`, an explicit list).
  `"X570 Aorus Master + Ryzen 9 5950x"` names an uncatalogued board, so only cpu was evidenced and
  the bundle keyed as a Ryzen 9 5950X at the board-plus-CPU price. With the chipset counted, it
  evidences two types and is refused. `H510` is left out because it collides with the NZXT H510
  cases, and Intel Arc's `B570` / `B580` are cards, not chipsets. The cost is that a CPU whose
  title states its chipset compatibility is refused as `mixed-components`. That is a lost
  reference, never a wrong one.

After the fix, the replay reports 18 gained keys, and every one was hand-checked as correct.
No key is lost and the yield is 75 listings. The `RP-*` rows in `normalizeListing.test.ts` pin
each case.

**Measured over the 141-title live corpus (216 title × search sightings), before and after:
4 outcomes change, all on titles labelled not-a-component and all refused both before and
after, with no key on either side.** Three move from `INVALID_REFERENCE` to `NEEDS_REVIEW` /
`accessory` because rule 3b now runs ahead of rule 4 on them — a laptop charger `"AC Adapter"`
(cpu, was `whole-system`), a MacBook `"+ Original Box"` (gpu, was `whole-system`) and a Wi-Fi card
kit `"Complete in Box"` (motherboard, was `whole-system`) — and one `"Cable & Pipe Locator Kit"`
(psu) moves from `component-unconfirmed` to `accessory`. Both hard gates stay at 0 and the floor
stays at 11 of 13.

**And one consequence for `MAXIMUM_PRICE`.** A catalogued listing found only by a search of
another type used to be `INVALID_REFERENCE` → `NOT_DEAL`. It is now `VALID` with its model on
first sight, and `decide` runs the maximum-price leg before the evidence gate — so under
`MAXIMUM_PRICE` that first sighting can be a `DEAL / within-maximum` with no benchmark behind it,
the same mechanism as row 4 of [the evaluation table](#the-evaluation-consequence--read-this-before-changing-the-settings-mode).
Not addressed here; it belongs to the later parts that gate that leg.

### The twelve rules, in order — first match wins

```
0.  capped title      the tokenizer returned 64 tokens                      -> NEEDS_REVIEW
1.  wanted ad         wtb, want to buy, buying, we buy, looking for, ...    -> INVALID_REFERENCE
2.  trade only        for trade, trade only, swap, trading, ...             -> INVALID_REFERENCE
3.  broken / parts    for parts, not working, damaged, as is, ...           -> INVALID_REFERENCE
3b. accessory         under EVERY search: an accessory phrase (cable,
                      bracket, backplate, box, fan, ...) or `for <model>`;
                      fan exempt if the title evidences case_fan, `open
                      box` exempt; search's type kept                       -> NEEDS_REVIEW
4.  whole system      a system brand or product line, or an uncovered whole-unit
                      token (pc, tower, build, rig, laptop, notebook,
                      desktop, ...)                                         -> INVALID_REFERENCE
5.  foreign parts     another component type is evidenced                   -> INVALID_REFERENCE
6.  multiple models   two catalog models of the declared type               -> INVALID_REFERENCE
7.  unknown quantity  lot of / bundle / pcs / two / three / both / combo, a `pack`
                      token, or an `Nx` multiplier in the first two tokens
                      or the last two                                       -> NEEDS_REVIEW
8.  placeholder zero  price 0 and nothing says the ITEM is free: `free` must
                      LEAD the title and the NEXT token must belong to the
                      item -- a marker phrase, or the matched model itself   -> NEEDS_REVIEW
9.  unconfirmed       no catalog match and no marker for the declared type  -> NEEDS_REVIEW
10. unmatched         the right component, not in the catalog   -> VALID, modelKey null
11. matched           exactly one catalog model                 -> VALID, that model
```

Rule 4 is neutralised by a marker of the **declared** type — the resolved one, above — so
`"Lian Li Lancool 216 PC Case"` under a `case` search is a case and not a PC. Rule 7's `pack` is **not**: a fan pack really is a
pack, on the one component type where Arctic, Noctua and Corsair all sell in 3- and 5-packs.

**Rule 4's whole-unit tokens include `laptop`, `notebook` and `desktop`.** `desktop` was
excluded at first because the bare token fires on the catalog's own product wording —
`"AMD Ryzen 7 9800X3D Desktop Processor"`, `"Kingston Fury Beast 32GB DDR4 desktop memory"` —
and that argument stopped being true once `MARKERS.cpu` gained `desktop processor` and
`MARKERS.ram` gained `desktop memory`: those phrases **cover** the word exactly as `pc case`
already covers `pc`. Both titles resolve to their catalog models, and `"Dell Desktop GeForce RTX
4060"` — a CA$1,100 prebuilt that was writing itself into the 4060 benchmark — is refused.

**And coverage for `desktop` must TRAIL the model name, which is a second lesson from the same
repair.** Punctuation is stripped before matching, so a prebuilt's spec list tokenizes `desktop`
and `processor` adjacent — `"Dell Desktop | Processor: Core i9-14900K | 32GB | 1TB"` — and the
marker that exists to neutralise retail box wording was neutralising the very token that says the
listing is a whole machine. Measured, that title was stored `VALID / Core i9-14900K` at CA$1,500:
a whole prebuilt as the CPU benchmark, roughly 2× the real price, in the inflating direction. The
same shape reached RAM, and **pipe-delimited spec lists are the live data's own house style** — 2
of the 15 production listings are one. So `desktop` is neutralised only by a marker phrase that
starts at or after the end of a matched model's span: retail wording trails the product, a spec
list leads it. **Scoped to `desktop` alone** — the general rule regresses `"PC Case - Fractal
North"`, where `pc case` leads and the model follows, which is ordinary case phrasing.

**The named cost has two halves, because word order is the only signal available.** A title that
LEADS with the retail category is refused whether or not the catalog knows the model:
`"AMD Ryzen 5 4500 Desktop Processor"` (uncatalogued, so there is no span for the marker to
trail — the 5600 this example used to name is catalogued now, and T36g asserts that it matches) and `"Desktop Processor Core i9-14900K"` or `"Desktop Memory Corsair Vengeance 32GB DDR5"`
(catalogued, but the category leads). The second half is inherent: `"Desktop Processor: Core
i9-14900K"` is token-identical in shape to `"Desktop | Processor: Core i9-14900K"`, which is the
prebuilt the rule exists to refuse. Lost references, never wrong ones.

**The measurement that accompanied the `desktop` repair was blind to word order**, because every
collision title it tested puts the retail wording after the model. The corpora caught what the
targeted measurement could not; that has now happened three times in this slice.

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
on measured collisions:** `aorus` (8 catalog motherboards, and Gigabyte's GPU line), `nitro`
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

- **337/337** catalog names, declared as their own component type, resolve to themselves.
- **All 2,696** cross-type pairs (every catalog name declared as each of the eight other types)
  are refused or moved to the model's **own** type and keyed by one of that type's models; none
  is ever `VALID` with a key under a foreign type. Measured: all 2,696 resolve, because a bare
  catalog name evidences only its own type. The count is pinned, so a rule that resolves less
  goes red.
- **Every one of the nine per-type counts** is pinned, not just the total: a name typed into the
  wrong component block keeps the total at 337 and is invisible to everything else.
- **10** sub-phrase overlaps exist across the eighteen vocabularies, all of them known and
  pinned; an eleventh fails the suite.
- CPU, measured in Node on a development machine rather than in workerd — the same caveat
  `worker/evaluation/evaluationCpu.test.ts` carries, and re-measured after the vocabularies grew:
  **p95 0.21–0.23 ms** for a 15-listing window, and **p95 3.2–3.9 ms** (3.25–3.38 over four
  consecutive runs on one machine, 3.52 and 3.88 measured independently on another and on an adversarial
  title) for the worst legal batch — 100 listings × 300-character titles one token under the cap,
  which is the expensive side of it, since a title that *hits* the cap short-circuits at rule 0
  and costs 0.21 ms. **Read the spread, not the midpoint: 3.2–3.9 ms is dev-machine variance
  across two machines and two title shapes, not a precision this measurement supports.** The
  repo's own invariant is p95 < 8 ms and the test asserts against that, never against these
  figures. **The type resolution costs one change in the scan, in both directions:** it needs
  every type's model match, so a type evidenced by a marker now has its index walked too (the old
  evidence scan short-circuited there), while the declared type's index is walked once rather
  than twice. `T40c-r` runs the same worst legal batch declared under a type it does not
  evidence, so the resolution fires on all 100. Measured on one machine at load average 7–9,
  three runs of the file alone each: `T40c` p95 4.16–4.42 ms before the change and 4.37–4.96 ms
  after (p50 3.42–3.55 → 3.69–3.88), `T40c-r` p95 4.20–4.27 ms. Read that as "no material
  change, inside the noise of a loaded dev machine", not as a precise delta. **The accessory
  check adds work only on the resolving path** — an `ACCESSORY` phrase scan and one more span walk
  of the resolved type — and re-measured with it (load average 6–7, three runs): `T40c` p95
  4.33–4.93 ms, `T40c-r` p50 3.79–4.72 and p95 4.90–5.79 ms. Still under the 8 ms invariant, with
  less headroom on that path than before. After the second round of accessory words (load average
  7–11, three runs): `T40c` p95 3.95–5.64 ms, `T40c-r` p50 4.25–4.40 and p95 5.32–5.86 ms.
  **Part 2 won the headroom back.** Every vocabulary phrase was re-tokenized on every check of
  every listing, about a hundred times per title; `phraseTokens` now tokenizes each once per
  isolate. Measured on the same machine, the rule went from ~3.9 to ~2.8 ms per 100 resolving
  listings, and the file alone at load average 9–10 read `T40c` p95 2.85–3.57 ms and `T40c-r` p95
  3.38–3.73 ms, three runs each, with the two Part 2 match rules in place. Under the whole
  parallel suite the same tests had read 6.3–7.1 ms p95 before it.
  **PR 2.3 runs the accessory scan on every listing, not only a resolving one**, so `T40c` (a
  batch that does not resolve) now pays it too. Written as a span scan per phrase it cost about
  +0.4 ms p50 per 100 listings; it is now one allocation-free pass over the title against the
  phrases indexed by first token, and the `for <model>` check reuses the span walk the evidence
  scan already makes. Interleaved with master, the file alone, three runs each, load average
  6.6–7.0: master `T40c` p95 2.83–3.29 ms and `T40c-r` p95 3.28–3.75 ms; PR 2.3 `T40c` p95
  2.85–3.09 ms and `T40c-r` p95 2.53–2.67 ms. Inside the 7 ms working ceiling, the 8 ms budget
  and the Workers Free 10 ms limit. **Do not `Object.freeze` the phrase cache**: measured, it
  took `T40c` to p50 ~4.0 ms file-alone and past 8 ms p95 under the full parallel suite (see
  `phraseTokens`).

### The residuals, named — and the corpora they are measured from

**Every figure below is measured from a corpus committed in
`worker/normalize/normalizeListing.test.ts`** — `STANDALONE_COMPONENTS` (31 titles),
`WHOLE_MACHINES` (30), `BOARD_PARTNER_TITLES` (6), `ACCEPTED_BRAND_WORD_TITLES` (8),
`FREE_PHRASINGS` (19) and `SKU_SUFFIX_PHRASINGS` (21).

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
4. **11 of 31 realistic standalone-component titles are declined** that a human would accept:
   three from the token `build` or the phrase `gaming PC`; one from the deliberate choice that a
   fan pack really is a pack; three from the quantity words (`"two months old"`,
   `"fits both AM4 and AM5"`, and `"32GB 2x16"`, which PLAN.md:54 calls one kit); and one from the
   multiplier bound (`"AMD 9600X processor"` — a bare SKU with one word in front of it); and three
   from the `desktop <component>` retail phrasing in residual 8. Every one costs a lost reference,
   never a wrong one. **The figure has moved twice and both moves are the
   point:** it was reported as 3 when it was 4, and the four quantity shapes were simply not in
   the corpus until the vocabulary that declines them was reviewed.
5. **A model name truncated to `<letters> x <digits>`** — `"G.Skill Flare X5"` with nothing after
   it — reads as a trailing count. A lost reference, in the safe direction.
6. **A genuinely free item is `NEEDS_REVIEW` whenever anything sits between `free` and the item**
   — `"Free to a good home GeForce RTX 5080"`, or the same phrase written tail-first. Rule 8
   requires the token after a leading `free` to be the item. A free listing cannot reach a
   benchmark in any case, so this costs a `DEAL` verdict rather than a reference.
   `FREE_PHRASINGS` (19 real phrasings) is the committed corpus that keeps the family
   re-measurable; it found two live defects on its first run. **The free-accessory family it used
   to bound is closed:** `"Free graphics card box with GeForce RTX 5080"` and `"Free gpu support
   bracket with GeForce RTX 5080"` were `VALID` at CA$0 (a spurious `DEAL` under
   `MAXIMUM_PRICE`) while the accessory refusal was cross-type only; rule 3b now refuses both
   under every search, before rule 8 runs.
7. **Seven real SKU-variant phrasings still pool into their base model** — a year suffix
   (`RM850x 2021`), a form factor (`Focus GX-850 ATX 3.0`), an `A-RGB` that tokenizes as two
   words, `North XL TG`, a `DDR5 EXPO` kit, `SF1000 Platinum` and `4000D Airflow Core`. Each is a
   word deliberately NOT added to the suffix list, for a reason stated per row in
   `SKU_SUFFIX_PHRASINGS`: it is a form factor, or a feature the catalog entry already has, or a
   word that may name the catalog entry itself rather than a variant of it. **This is the
   money-losing direction** — two different products averaged together — and it is the residual
   that is measured rather than closed. The corpus found ten mis-pools in twenty titles when it
   was written cold; three were closed by adding `ii`, `touch` and `argb`.
8. **Ordinary `desktop <component>` retail phrasing is refused on seven of the nine types.**
   `"GeForce RTX 5080 desktop graphics card"`, `"Corsair RM850x desktop power supply"`,
   `"Samsung 990 Pro 2TB desktop SSD"` and the same shape on case, case_fan, cpu_cooler and
   motherboard. `desktop` is a whole-unit token on all nine types while the markers that
   neutralise it exist only on `cpu` and `ram`; `"desktop graphics card"` is how retail
   distinguishes a desktop GPU from a laptop one. This arrived with the `desktop` admission, not
   with the trailing rule, and `STANDALONE_COMPONENTS` held no instance of the family — so the
   cost figure could not see it and nothing went red. It now carries three.

   **Cheap and safe to close, measured rather than assumed:** adding `"desktop graphics card"` to
   `MARKERS.gpu` recovers the match while `"Dell Desktop | Graphics card: RTX 5080"` stays
   refused, because the trailing rule protects any future `desktop *` marker globally. The price
   is one marker phrase per type plus the overlap rows it adds to the vocabulary audit. Left
   undone deliberately: seven types' worth of new vocabulary is not a merge-time change.
9. **A component pulled from a machine of an admitted brand line** — `"RTX 4070 pulled from a
   Razer Blade 16"` — is refused as a whole system. Correct for a laptop part, which is a
   different product from its desktop namesake; a lost reference for a desktop part.
   `ACCEPTED_BRAND_WORD_TITLES` carries one row per admitted word.

Residuals 1, 2, 3 and 5 are pinned as expected-to-behave-this-way rows in `ACCEPTED_EXPOSURE`,
and 4, 6, 7, 8 and 9 are pinned by the corpora named above, so the next one is visible rather than
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
> it is one of the 337 names in `src/data/catalog.ts` or `NULL`, and only a title the rule
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
> **THE TOKEN IS NO LONGER WRITE-ONLY, AND THIS SLICE IS WHAT SPENT THAT.** It now also carries
> **`GET /api/watch-targets`**, so a leak additionally discloses **what the operator hunts and
> where**: every `component_type`, every `query` string, and a latitude/longitude to about 11 m.
> The seed centre is Nathan Phillips Square — a public downtown landmark, chosen so that a leak
> does not disclose the operator's home — and **the settings UI must preserve that property.**
> The read is strictly less privileged than the write the same token already bought, and a second
> secret with its own rotation was judged not worth it for a read of three rows; that is an
> accepted trade, named here rather than discovered from a leak.
>
> It still reads **no evaluation results, no user identity, no deal rules and no notification
> history**, and not even the error text of a failed write. It still cannot reach
> `/api/settings` or `/api/auth/session`. **What it can read has grown twice now, and an
> absolute claim here would be false.** As before, the response tells a caller whether a `(source, listingId)` it guesses
> already exists, and whether a guess at that row's contents is exact, because `UNCHANGED` is
> returned only on a content-hash match. **New in this slice: `contributions` now distinguishes
> `recorded` / `restored` / `removed`, which were structurally unreachable while every row
> reported `skipped-no-model` — so the response now also tells a caller whether a guessed
> `(source, listingId)` is currently contributing to a benchmark.** The `rowsRead` figures the
> previous version of this paragraph quoted are not carried over: once a listing contributes, the
> CHANGED path runs three more statements, and no one has measured what `usage.rowsRead` reports
> then. It cannot be used from a browser, from any origin — `/api/listings` **and**
> `/api/watch-targets` both refuse a request carrying any `Origin` at all, and neither is in
> `ROUTE_METHODS`, so neither advertises a preflight.
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

## The watch list — what to hunt, and where

```jsonc
GET /api/watch-targets
X-Collector-Token: <the collector secret>

200
{"market":{"location":"toronto","latitude":43.6532,"longitude":-79.3832,"radiusKm":25},
 "targets":[{"targetId":"cpu-toronto","componentType":"cpu","query":"cpu"},
            {"targetId":"gpu-toronto","componentType":"gpu","query":"graphics card"}]}
```

`targets` is ordered **by `target_id`**, so the run order is deterministic and testable.
`market` is **`null`** when the singleton row is absent — a reachable state (someone can `DELETE`
it), reported explicitly and never defaulted, because a default market would collect into the
wrong `market_key` silently.

**A target may carry its own market** (`targets[i].market`, same four fields), for the
multi-user Worker where each person searches their own area. The top-level `market` is then
present only when every target shares one, and `null` otherwise. The collector searches each
target in its own market and falls back to the top-level one only for a row with **no `market`
key at all** — which is every row today's Worker sends, so against it nothing changes:

- an own market is validated exactly like the top-level one; a malformed one (including
  `market: null` on the row) is **that target's exit 2**, never searched in the shared market
  and never a whole-run failure;
- a non-null top-level market is always validated; a `null` one is accepted only when every row
  carries its own, and otherwise is the same whole-run exit 2 as before (the error names how many
  targets lack a market when some do carry one);
- the cap, the refusal guard and its state file, the overlap check and the health post are
  unchanged. `collector/testing/fixtures/watchTargetsPerTargetMarket.json` is the wire, and
  `collector/runTargets.test.ts` M-1 runs it through the real fetcher and loop with no Worker.

It lives in `watch_market` and `watch_targets` (migration `0005`) and **deliberately not in
`search_revisions`.** That table is the append-only revision log and its revision number is
`evaluateBatch`'s staleness key: a bump re-opens **every** evaluation task in the corpus. Adding
"also watch RAM" says nothing about whether an already-judged GPU was a deal, so editing the
watch list must cost **zero verdicts**. A separate table makes that structural rather than
careful.

**`watch_market` is a `CHECK (id = 1)` singleton** — the same idiom, and the same reason, as
`search_settings` in `0003`. One market per run makes `market_key` constant by construction.
`radius_km` carries `typeof(radius_km) = 'integer'` alongside its range: SQLite `INTEGER` is
affinity, not a type, and without that term `12.5` stores as a REAL — the same trap that jammed
every settings `PUT` once already.

### Its auth is the collector credential, and why

`authenticateRequest` admits exactly two identities: a **loopback-only** development identity and
a **Firebase ID token on `APPROVED_EMAILS`**. A headless `node collector/main.ts` on the
operator's Mac reaching a public Worker is **neither**. The collector already holds and rotates
`COLLECTOR_TOKEN`; reading its own configuration is strictly **less** privileged than the write
that token already buys; and the two credential systems stay disjoint in both directions.

The route carries the ingest route's rules verbatim: **any `Origin` header at all is a 403**, it
is **absent from `ROUTE_METHODS`** (so `OPTIONS` never advertises a browser channel), a missing
`DB` binding is `503 DATABASE_UNAVAILABLE`, and a D1 failure is **`503
WATCH_TARGETS_STORAGE_FAILED`** — a code of its own, because three different fixes behind one
code sends an operator to the wrong one. Swallowing that failure and answering an empty list
would make an outage read as "there is nothing to hunt".

**What a leaked token can now also read:** the component types, the query strings and a lat/long
to about 11 m. The seed centre is Nathan Phillips Square — a public downtown landmark, chosen so
a leak does not disclose the operator's home, and **the settings UI must preserve that
property.**

---

## Running the collector

```bash
COLLECTOR_API_BASE=https://your-worker.workers.dev \
COLLECTOR_TOKEN=... \
npm run collect
```

**The component type, the query, the location, the coordinates and the radius are no longer
environment variables.** They come from `GET /api/watch-targets`, one search per target, in one
process.

| variable | required | default |
|---|---|---|
| `COLLECTOR_API_BASE` | yes | — |
| `COLLECTOR_TOKEN` | yes | — |
| `COLLECTOR_SOURCE` | no | `facebook-marketplace` |
| `COLLECTOR_LIMIT` | no | 15 |
| `COLLECTOR_DAYS_SINCE_LISTED` | no | 7 |
| `COLLECTOR_TARGET_DELAY_MS` | no | 60000. **Milliseconds BETWEEN targets.** A test-only seam, the same character as `COLLECTOR_HTML_FILE`: **setting it low in production is how the residential IP earns a login wall.** |
| `COLLECTOR_HTML_FILE` | no | unset means fetch live; a path parses that file instead |
| `COLLECTOR_DRY_RUN` | no | unset. Any value parses and prints and **never posts** |

**Defaults exist only where a wrong value cannot corrupt data.** `source` has none: it scopes
every stored row.

### One search per target, and the two guards on the burst

- **`MAX_TARGETS_PER_RUN = 9`, and it REFUSES rather than truncating.** Over the cap **nothing
  runs**, the run line reports `targets:<the count the server returned>` with an empty
  `exitCodes`, and the exit code is 2. A cap below the item count applied to an *ordered* list
  "would starve **the same** sources every run, forever" — `worker/scheduling/collection.ts`
  already states the rule for `MAX_DRAIN_SOURCES`. It is also what makes the daily request count
  a known bounded number: `targets × 48`, at most **432/day** at the cap.
- **60 s between targets**, not before the first and not after the last. **The justification is
  burst shape and only burst shape:** nine searches back to back is ~nine requests in nine
  seconds from one residential IP. **It does not change daily volume at all** — volume is
  `runs/day × targets`, in which the delay does not appear. **What number is actually safe has
  not been measured and is not invented here**; no request was made to Facebook in choosing it.
  If a block appears, lengthen the **cadence** (one plist edit), not the delay.
- **Both requests now time out at 10 s.** Measured before they did: a POST to a socket that
  accepts and never answers had not settled after 20 s, and a GET ran 12,005 ms. With N targets
  in one process a hung POST strands the remaining N−1 and a hung GET strands all N.

It prints **one line of JSON per target, as each finishes**, then **one run line**.

```
{"kind":"target","target":"gpu-toronto","componentType":"gpu","exitCode":0,"state":"SUCCESS",…}
{"kind":"target","target":"cpu-toronto","componentType":"cpu","exitCode":4,"state":"PROVIDER_FAILURE","reason":"parser-blind",…}
{"kind":"run","targets":2,"complete":false,"exitCode":4,"exitCodes":{"0":1,"4":1},"delayMs":60000,"dryRun":false}
```

Per-target lines are printed **as they happen**, so a process killed mid-run still leaves the
record of everything that completed.

**The run line's fields.** `targets` is **the count the server returned, never the count that
ran** — an operator whose cap fired needs to know they have 12 targets, not merely that the cap
is 9. `exitCodes` is the histogram. `complete` is `targets > 0 && every target exited 0`.
`delayMs` is the throttle actually used. `dryRun` is **not cosmetic**: a launchd environment file
with `COLLECTOR_DRY_RUN` set reports `complete:true, exitCode:0` **forever while collecting
nothing**, and it is the one field that distinguishes that state. `error` appears only on a
whole-run failure.

**The invariant, and it has two clauses:**

> `error !== undefined` ⟹ `exitCodes` is **empty**.
> `error === undefined` ⟹ `sum(Object.values(exitCodes)) === targets`.

The one-clause form ("the sum always equals `targets`") is **false**: the cap refusal and a null
market both report `targets:N` with an empty `exitCodes`. Reconciling it by redefining `targets`
as the count that *ran* is exactly how a silently dropped target starts reporting success.

**Every target in the returned list is attempted and none is ever removed from it.** A target
that fails validation, or whose `run()` throws, is that target's result at **exit 2** — it is not
filtered out.

| exit | meaning |
|---|---|
| **0** | listings parsed, the POST returned 200, **and the Worker reported zero FAILED** |
| 2 | a configuration error. Nothing self-heals: a required variable is missing, the watch list is empty or over the cap, the market is absent or unusable, a target row or its own market is unusable, or a negative/fractional target delay |
| 3 | `SOURCE_EMPTY` — nothing posted. Normal on a quiet day; **three in a row at one target latches an alarm** — see "The alarm" below |
| 4 | `PROVIDER_FAILURE` — the page changed shape. **A human must look.** Nothing posted |
| 5 | transient: the source was unavailable or rate-limited, the watch-list `GET` failed with 5xx/transport/timeout, or the POST failed with 5xx or a network error. The next run is the retry |
| 6 | the POST was refused with a 4xx, or returned 200 while the Worker reported `FAILED > 0`; or the watch-list `GET` answered 4xx or a 200 of the wrong shape |

**The process exits with the most severe per-target code**, by this precedence:

> **`2 > 6 > 4 > 5 > 3 > 0`**

`2` nothing self-heals; `6` the server refused or partially refused a **write**, so data is at
risk; `4` the source changed shape — a human must look, but nothing was posted; `5` the next run
is the retry; `3` normal on a quiet day. **`6 > 4` is a judgement, recorded as one:** both mean
"a human must look", and the one nearer the data was picked. It is **not** `Math.max`, which
ranks 6 above 2 and 5 above 4.

**A repeated exit 5 across runs is a persistent server-side failure, not a transient one** —
measured: a one-listing batch whose only write fails answers 503 and lands on 5, so a *total*
write outage carries the quieter code and would otherwise retry silently forever. Check
`wrangler tail`.

**A repeated exit 3 is also worth looking at.** The four evidence markers are field names in one
GraphQL response and are not independent: a single wholesale rename could remove all four at the
same time as the listing anchor, and the collector would report an empty market forever. One
response cannot rule that out.

### The alarm, which is now built

**Both of those sentences used to end "and is not built".** They do now. `collector/runState.ts`
keeps cross-run state in `~/.marketplace-collector-state.json` (mode 600, outside the repository)
and latches a **cause** when any of three conditions holds:

| condition | cause | threshold |
|---|---|---|
| N consecutive exit 3 **at one target** | `source-empty:<target>` | `CONSECUTIVE_ALARM_RUNS = 3` |
| N consecutive exit 5 **at one target** | `transient:<target>` | `CONSECUTIVE_ALARM_RUNS = 3` |
| one exit 5 whose `reason` is `rate-limited` or `blocked-redirect` | `refused:<target>` | **1** |
| two DIFFERENT queries in ONE run returning the same listings | `feed-overlap:<a>+<b>` | `OVERLAP_ALARM_FRACTION = 0.80`, only when `min(\|A\|,\|B\|) >= 12` |

**The counters are per target, never per run**, because `worstExitCode` folds a run to one code —
a run-level counter lets one target be empty for a hundred runs while another target's occasional
5 resets it, and the real log shows exactly that interleaving (three different non-zero codes at
three different targets in 52 runs).

**The fourth condition is the one that was actually observed, and it needs no cross-run state at
all.** Three live searches with different queries (`rtx 4060`, `rtx 3060`, `rtx 3070`) returned
the identical three matched listings after ~17 live requests in ~17 minutes. **Every one of those
runs would have exited 0** — the page parsed, 24 listings were extracted, the POST succeeded. One
run drives nine targets with nine different queries, so substantial listing-id overlap *between
different queries in the same run* is a generic feed.

**What a latched cause does: a 2-target probe, never a stop.** The next run searches only the
latched cause's own targets (`CANARY_TARGETS = 2`, a 78 % volume cut) and the run line reports
`"canary":true`. Stopping instead would be **indistinguishable from a broken cron** and would be
discovered days later, which is how this project shipped "evaluation is running" over 498 dead
cron runs. **One exception: a quiet `source-empty` cause engages no cut.** When one target
comes back empty while another in the same run exits 0, that is a quiet query, not a page-marker
change (which empties every target). The cause keeps its alarm and the page still says Degraded,
but runs stay full. A cause clears only when **its own cause** is re-measured clean twice
(`CANARY_CLEAN_PROBES = 2`), with two exceptions. A refusal is of the IP, so `refused:t` is also
credited by a run in which `t` itself got a parsed empty page (exit 3), another target exited 0,
and nothing was refused. A 403, an off-site redirect or a checkpoint page at `t` earns no such
credit. And a cause whose question can no longer be answered is dropped without credit: a pair
whose two rows became the same query (at once), or whose pages both parsed but cannot clear the
denominator floor (after `CANARY_CLEAN_PROBES = 2` such probes in a row; a probe that still
shows the feed resets the count, so a real feed whose one side flickers empty stays latched).
The cut — not the alarm — expires after `MAX_CANARY_RUNS = 48`
so one full run per day keeps re-measuring everything. **`refused:*` never expires:** that is the
case where Facebook has refused this IP, and staying low is the entire point.

**The exit-code numbers do not change and there is no seventh code.** A probe that comes back
clean exits 0. The alarm **adds** a signal — the run line's `alarms`, a health row, and the badge
on the dashboard — and launchd still reads the same `LastExitStatus` it always did.

**The override is one command:** `rm ~/.marketplace-collector-state.json`. The next run then goes
back to full volume with no memory, which is also what happens on a first-ever run.

### Schedule

**Every 30 minutes**, matching the monitoring cron. It is still a one-shot process, not a daemon:
one `GET` for the watch list, then one request to the source and one POST per target, then it
exits — no pagination, no cursor following, no retry of any request, one bounded loop whose
length the cap bounds. **A documented schedule is a weaker guard than a mechanism**, which is why
`MAX_TARGETS_PER_RUN` is code rather than prose. The real exposure of a runaway is **Facebook**,
not Cloudflare. D1-side, every write is idempotent, so a runaway wastes quota and does not
corrupt.

#### The launchd job

`scripts/launchd/com.marketplace-deal-finder.collector.plist.template` and
`scripts/collector-run.sh` ship as **templates that a human installs**. Nothing in this
repository writes to `~/Library/LaunchAgents`, and no test runs `launchctl load` or
`launchctl bootstrap`.

**`StartCalendarInterval`, never `StartInterval`, and the keys are not interchangeable on a Mac
that sleeps.** `man launchd.plist`: `StartInterval` — "If the system is asleep during the time of
the next scheduled interval firing, **that interval will be missed** due to shortcomings in
kqueue(3)"; `StartCalendarInterval` — "**Unlike cron which skips job invocations when the
computer is asleep, launchd will start the job the next time the computer wakes up.**" So
`StartCalendarInterval` recovers exactly one run on wake where `StartInterval` silently loses the
window. **Do not swap the key.**

`RunAtLoad` is `false`: the man page says the key "should be avoided, as speculative job launches
have an adverse effect on system-boot and user-login scenarios". The install ends with one manual
`launchctl kickstart`, so there is still immediate confirmation.

**Why a wrapper at all** — three real failures, not tidiness. launchd jobs run with a minimal
environment and **no `PATH` to a version-managed `node`**; they have **no working directory**, and
`node collector/main.ts` needs the repo root; and **the token must not be in the plist**, because
files in `~/Library/LaunchAgents` are world-readable. The wrapper sources
`~/.marketplace-collector.env` and **refuses to run unless that file exists and its mode is
exactly 600**.

**What protects that file is its mode and its location, not `.gitignore`.** It lives in `$HOME`,
where `.gitignore` has no say whatsoever, and `.env.*` never matched `marketplace-collector.env`
anyway — that pattern needs a leading dot before `env` (measured with `git check-ignore -v`).
`.gitignore` now names the file explicitly, but **only** to catch a copy dropped inside the repo.
Do not read that as cover for the real one.

**Install:**

```bash
# 0. APPLY THE MIGRATION FIRST. The route reads watch_market and watch_targets; against a database
#    that has not been migrated it answers 503, which the collector maps to retryable -> EXIT 5,
#    "the next run is the retry" -- FOREVER, every 30 minutes, with the health check above
#    reporting the failure only because it reads exitCode as well as recency. That is exactly the
#    laundering collector/watchTargets.ts exists to prevent, one layer up.
# `--no-install` on every npx, as everywhere else in this repo: without devDependencies present,
# a bare `npx` SILENTLY DOWNLOADS A DIFFERENT WRANGLER, and this is the one step in the whole
# install that touches PRODUCTION.
npm run db:migrate                       # --remote; `npm run db:migrate:local` is the e2e's copy
npx --no-install wrangler d1 execute marketplace-deal-finder-db --remote \
  --command "SELECT target_id, component_type, query FROM watch_targets ORDER BY target_id"

# 1. the secrets file, mode 600, never in the repo
cat > ~/.marketplace-collector.env <<'EOF'
COLLECTOR_API_BASE=https://your-worker.workers.dev
COLLECTOR_TOKEN=...
PATH=/opt/homebrew/bin:/usr/bin:/bin       # a PATH that finds YOUR node
EOF
chmod 600 ~/.marketplace-collector.env

# 2. render the template
# ~/Library/LaunchAgents does not exist by default on macOS. Without this the redirect below
# fails, and plutil and bootstrap then fail after it -- three cascading failures from one absent
# directory. `-p` makes it a no-op when it is already there.
mkdir -p ~/Library/LaunchAgents
REPO=$(pwd)                              # from the repo root
sed -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" \
  scripts/launchd/com.marketplace-deal-finder.collector.plist.template \
  > ~/Library/LaunchAgents/com.marketplace-deal-finder.collector.plist
plutil -lint ~/Library/LaunchAgents/com.marketplace-deal-finder.collector.plist

# 3. load it, then fire one run by hand for immediate confirmation
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.marketplace-deal-finder.collector.plist
launchctl kickstart -p gui/$UID/com.marketplace-deal-finder.collector
```

**Verify:**

```bash
# launchd's own view: last exit code, runs, state
launchctl print gui/$UID/com.marketplace-deal-finder.collector

# RECENCY IS NOT HEALTH. This reads the last run line's CONTENT as well as its age.
python3 - <<'EOF'
import calendar, json, re, time, pathlib
log = pathlib.Path.home() / "Library/Logs/marketplace-collector.log"
# `if log.exists()` is not defensive padding: between `launchctl bootstrap` and the first run
# completing there IS no log file, and that is exactly when an operator runs this. Without it the
# first thing they see is a FileNotFoundError traceback instead of the answer.
# `stopped` lines are read too: a dashboard Stop makes every run log `{"kind":"stopped"}` and exit 0
# with no run line, so reading run lines alone would report a deliberate pause as a dead job.
runs = re.findall(r'^(\S+Z) (\{"kind":"(?:run|stopped)".*\})$',
                  log.read_text() if log.exists() else "", re.M)
if not runs:
    print("UNHEALTHY: no run line yet -- is the job loaded?")
elif json.loads(runs[-1][1])["kind"] == "stopped":
    print(f"stopped: monitoring is stopped from the dashboard (last checked {runs[-1][0]}); press Start to resume")
else:
    stamp, payload = runs[-1]
    line = json.loads(payload)
    # calendar.timegm, NEVER mktime + time.timezone: the wrapper stamps UTC, mktime reads LOCAL,
    # and time.timezone is the NON-DST offset -- measured, that combination reported a run made
    # one second ago as "60 minutes ago" under EDT, i.e. permanently UNHEALTHY all summer.
    age = (time.time() - calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ"))) / 60
    problems = []
    if age > 45: problems.append(f"last run was {age:.0f} minutes ago")
    if line.get("dryRun"): problems.append("COLLECTOR_DRY_RUN is set -- NOTHING IS BEING COLLECTED")
    if line.get("exitCode") != 0: problems.append(f"exitCode {line['exitCode']}")
    # THE CANARY BRANCH COMES FIRST AND IT IS NOT COSMETIC. A probe run reports complete:false BY
    # DESIGN -- two of nine searches ran because a guard is latched -- and without this branch the
    # line below printed `UNHEALTHY: incomplete: {"0":2}`, which reads as "seven of your searches
    # silently vanished": precisely the confusion the run line's two-clause invariant exists to
    # make unrepresentable.
    if line.get("canary"):
        problems.append(f"CANARY: a guard is latched, so only some of your {line['targets']} searches ran")
    elif not line.get("complete"): problems.append(f"incomplete: {line.get('exitCodes')}")
    # THE CAUSES, VERBATIM. `source-empty:<target>`, `transient:<target>`, `refused:<target>`,
    # `feed-overlap:<a>+<b>`, plus `canary-expired` and `guard-blind`. See "The alarm" above.
    if line.get("alarms"): problems.append("alarms: " + ", ".join(line["alarms"]))
    print(("UNHEALTHY: " + "; ".join(problems)) if problems else
          f"healthy: {line['targets']} targets, all clean, {age:.0f} minutes ago")
EOF
```

**RECENCY ALONE IS NOT HEALTH, AND THE SHARP CASE IS THE ONE THIS PAGE NAMES THREE TIMES:** with
`COLLECTOR_DRY_RUN` set in the environment file, every run emits `complete:true, exitCode:0,
dryRun:true` on the dot, launchd's own `last exit code` is `0`, and **both shipped signals report
success while nothing whatsoever is collected.** That is why `dryRun` is on the run line, and a
check that did not read it would make the field decorative. The same applies to a run that exits
2 every 30 minutes: perfectly punctual, perfectly useless.

**Healthy is recent AND `complete:true` AND `exitCode:0` AND `dryRun:false`.** On age alone:
**under 30 min** is the ordinary case, **under about an hour** means one window was skipped, and
**hours** means the Mac slept or the job is not loaded. Every line in the log is timestamped by
the wrapper, so **a missed window is a gap in a file** rather than an absence of evidence.

**THAT FOUR-CONJUNCT DEFINITION IS NOW ALSO THE WORKER'S**, verbatim, in
`worker/api/collectorHealth.ts` — reusing this page's own `45` rather than inventing a second
bound, because two staleness numbers in one product is the "second authority that can drift" this
page names elsewhere. If you change 45 here, change it there.

**What the 45 actually measures, stated at the width it was measured at.** Across 51 intervals
over 24.7 h: min gap 9.7 min, max **30.1**, none above 35, **zero** stale reports. `caffeinate
-dimsu` has held this Mac awake since 14 Sep with no `-t`, against `pmset` idle sleep of 1 minute
on both AC and battery — so it is tempting to say the bound only ever measured a machine that
could not sleep. **The full `pmset -g log` refutes that.** The long lid-closed periods on this
machine are `Entering DarkWake … 'Clamshell Sleep' … Using AC`: 858 min on 09-28, 768 on 09-30,
643 on 10-01 and **766 on 10-03 (02:28:54–15:14:54 local), which is inside the log window** — and
across it **26 of 26 expected runs fired, max gap 30.1 min, min 29.9**. The three real `Entering
Sleep state` transitions in the 8-day history are **all on battery and all short**.

**So the bound survived a 12 h 46 m closed lid on AC, which is the overnight case.** The untested
case is narrower than "every morning": **lid closed on battery**, where `StartCalendarInterval`
coalesces the missed windows into one run on wake. Do not read this as "expect stale every
morning" — that would be an argument for softening the one signal that catches the job genuinely
not being loaded, which is how this project shipped "evaluation is running" over 498 dead cron
runs.

**Sleep, stated rather than solved.** Coverage equals uptime; `StartCalendarInterval` recovers
one run on wake and coalesces the rest. Deliberately **not** done: `pmset` / `caffeinate` to keep
the Mac awake (the user's machine, not ours).

> **DEPLOY ORDER: THE MIGRATION GOES FIRST, OR TOGETHER.** `POST /api/collector-health` needs
> `migrations/0006`. Deploy the Worker *before* the migration lands and the UPSERT answers 503
> `COLLECTOR_HEALTH_STORAGE_FAILED` on every run, so `GET /api/status` reads `unknown` with
> `causes: ["status-unreadable"]` (the table it reads does not exist either) and the panel says
> **"The collector's status could not be read."** while the collector is running perfectly — no
> longer the false "No collector run has reported yet", but still a page that cannot show a
> healthy collector. It self-heals the moment the migration lands, and the collector's own exit
> codes are untouched throughout (the failure is one trailing `run-health` line per run). Run
> `npm run db:migrate` before `wrangler deploy`, or both in one change.
>
> **Before EITHER lands**, the route does not exist and the deployed Worker falls through to
> `authenticateRequest`, so the POST answers **401 `AUTH_TOKEN_MISSING`** — measured, not
> predicted. Same consequence: one trailing line, no change to any exit code.
>
> **THEN THE API WORKER, THEN THE FRONTEND.** The full order is: migration →
> `marketplace-deal-finder-api` (`wrangler.jsonc`) → `marketplace-deal-finder` (the dashboard,
> `wrangler.frontend.jsonc`). The old API answers `/api/status` with `{status:"ok", phase:2}`,
> which has no `causes` and no `collector`. The dashboard checks the body and shows "The
> collector's status could not be read" rather than going blank, so a frontend that lands first
> (or an API rollback) costs the panel, not the page. The order is still API first.

> **REVERSAL, RECORDED.** This paragraph also listed **a Worker-side "last collection at"
> endpoint** as deliberately not done. It is now built: `POST /api/collector-health` and the
> `collector_health` row behind `GET /api/status`. The reversal's reason is that the line was
> written when the only notification channel was a terminal script reading a log **on the
> laptop** — and the channel is now the **web page**, which cannot read that log. The terminal
> check above is kept as a *second* channel, not replaced: it is a command you have to remember
> to run, and the page is not.

**Uninstall:** `launchctl bootout gui/$UID/com.marketplace-deal-finder.collector` and delete the
plist.

**Expect a one-off aggregate reset if production already holds observations under different
coordinates.** `market_key` is derived from the market's latitude, longitude and radius, so the
seeded `43.6532,-79.3832|25km` is a *new* key: existing `model_stats` rows keep their old key,
fall to `count 0` as their observations are re-recorded under the new one, and are swept by the
daily cleanup — which `worker/storage/cleanupStaleObservations.ts` already names as a thing it
exists to mop up ("one dead row per group per location or radius change"). Verdicts for the
affected models are suspended until each new key reaches `MINIMUM_REFERENCE_COUNT = 5` again.
**It self-heals and needs no intervention — but the operator will see it, so it is said here
rather than discovered.** Editing the market to the previously-used coordinates before the first
run avoids it entirely.

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
stands, and rows 3 and 4 are why — but its original reason no longer holds and is replaced
rather than repeated. It used to be that the catalog was current-generation only while most real
supply is older; the catalog now carries 337 names two generations back, so that premise is
gone. What survives is the part that was never about coverage: an uncatalogued card under the
maximum still reads as a deal on no evidence at all, and no catalog can be complete — GTX 900,
RX 500 and Intel 10th gen are deliberately out, and a seller can always name something older or
rarer. A free listing still reads as the best deal in the database. Alerting is deferred, so today
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
