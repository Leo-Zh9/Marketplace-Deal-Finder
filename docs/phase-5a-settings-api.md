# Phase 5A — `GET` and `PUT /api/settings`

This is the first HTTP surface over `worker/search/settings.ts`. Before it, `loadCurrentSettings`
and `updateSearchSettings` were merged, tested and had **no production caller**: the only
documented way to create a revision was a hand-written `wrangler d1 execute`
(`docs/phase-3e-monitoring.md`), `search_settings` was empty, and every monitoring run recorded
`NO_SETTINGS`.

It is also the first **mutating** route in this Worker and the first `request.json()`-shaped code
path in it. Everything else here is GET. That is why most of this document is about the boundary
rather than about the settings.

## The contract

| | `GET /api/settings` | `PUT /api/settings` |
|---|---|---|
| Auth | Bearer Firebase ID token, approved email (unchanged, `authenticateRequest` runs first) | same |
| Request body | none | `application/json`, ≤ 4096 bytes |
| Success | `200 {"settings": EvaluationSettings \| null}` | `200 {"settings": …, "changed": boolean}` |

The `PUT` body accepts **exactly three keys** — the three columns `search_revisions` has:

| Key | Type | Notes |
|---|---|---|
| `mode` | `"DISCOUNT"` \| `"MAXIMUM_PRICE"` \| `"BOTH"` | required |
| `minimumDiscountPercent` | `number` \| `null` | absent and explicit `null` are the same thing |
| `maximumPriceCents` | `number` \| `null` | same |

Meaning — ranges, per-mode requirements, integer-ness — is decided by the merged
`validateSettings` in `worker/evaluation/dealRules.ts`, not re-implemented here. This file checks
shape; that file checks meaning.

### Failures

| Status | `code` | When |
|---|---|---|
| 415 | `UNSUPPORTED_MEDIA_TYPE` | media type is not `application/json`. Parameters, case and the space RFC 9110 permits before a parameter are all tolerated — `application/json; charset=utf-8`, `APPLICATION/JSON` and `application/json ; charset=utf-8` are each accepted, `application/jsonx` and `application/json-patch+json` are not |
| 413 | `PAYLOAD_TOO_LARGE` | declared `Content-Length` > 4096, or the measured UTF-8 body > 4096 |
| 400 | `INVALID_JSON` | body does not parse, or parses to something that is not a non-null, non-array object |
| 400 | `SETTINGS_FIELD_UNSUPPORTED` | any key outside the three; the response carries a sorted `fields` array naming them |
| 400 | `INVALID_SETTINGS` | unknown `mode`, a non-number where a number belongs, or `validateSettings` rejects it |
| 503 | `DATABASE_UNAVAILABLE` | no `DB` binding |
| 503 | `SETTINGS_STORAGE_FAILED` | three different things — see below |
| 404 | `NOT_FOUND` | a method other than `GET`/`PUT`, e.g. `POST /api/settings`. Deliberately not a 405. |

An invalid request writes nothing. Validation runs before `updateSearchSettings`, and
`updateSearchSettings` validates again before its own write.

### The response says what is stored, not what was sent

`PUT` re-reads through `loadCurrentSettings` instead of echoing the input, so the caller is told
the state of the system. MEASURED: `minimumDiscountPercent: 0.0000001` is stored as `0` and the
response says `0`; `23.456` comes back `23.46`; and a `maximumPriceCents` sent in `DISCOUNT` mode
is dropped by the merged writer and the response says `null`.

The cost is named in the code: if the re-read throws after the write committed, the caller gets a
503 for a write that happened. The retry is idempotent and answers `changed: false`, so it
self-heals — but that one response lies about the outcome.

## Ruling 1 — a field this API cannot store is **refused by name**, not ignored

Phase 5's documented payload also carries `components`, `models`, `location`, `radiusKm` and
`dealRule`. `search_revisions` has nowhere to put them and `SearchSettingsInput` does not accept
them; 3E-a left them out deliberately, because they are collection-side.

A `PUT` carrying any of them is a **400 `SETTINGS_FIELD_UNSUPPORTED`** listing them. The decisive
argument is the spec's own copy: *"Could not save settings. Your previous monitoring settings are
still active."* is exactly true under a 400 and false under a 200 that stored three of eight
fields. A 400 can be relaxed to a 200 later; the reverse breaks callers.

> **THE RULING STILL STANDS; ITS ORIGINAL REASON HAS GONE STALE, AND SAYING SO MATTERS.**
> Migration `0005` shipped `watch_market` and `watch_targets`, so "`search_revisions` has nowhere
> to put them" is **no longer why** `location` and `radiusKm` are refused here. They are refused
> because **they belong to `watch_market`, not to the revision log** — and that separation is
> load-bearing, not filing: `search_revisions`' revision number is `evaluateBatch`'s staleness
> key, so storing the market there would make "I now travel 20 km instead of 25" re-open **every
> evaluation task in the corpus**. Editing what you hunt must cost zero verdicts. A future writer
> for those two fields is a route over `watch_market`, never a widening of this one. Without this
> paragraph the next reader concludes the API is simply missing a feature.

**Rejected:** mapping `dealRule` (the spec gives no spelling for `MAXIMUM_PRICE` or `BOTH`), and
storing the other five in the revision log (`components` and `models` have no reader yet, and
`0001`–`0004` are applied in production).

## Ruling 2 — `GET` with no settings is `200 {"settings": null}`

It maps onto the spec's `empty` state with no special-casing. A 404 collides with the route-level
`NOT_FOUND` and forces the frontend to infer state from a status code. Manufactured defaults are
rejected outright: they would describe a configuration that is not in force while the monitor
keeps recording `NO_SETTINGS`.

## The CORS widening, and why it is path-scoped

Before this PR the preflight allowed exactly one method (`GET`, a string) and two headers
(`authorization`, `accept`), globally. `PUT` with a JSON body needs three widenings: the method,
the `content-type` header, and the advertised `Access-Control-Allow-Methods`.

They are granted **per path**, from one table in `worker/index.ts`:

| Path | Methods | Advertised `Allow-Methods` | Advertised `Allow-Headers` |
|---|---|---|---|
| `/api/auth/session` | `GET` | `GET, OPTIONS` | `Authorization, Accept` |
| `/api/status` | `GET` | `GET, OPTIONS` | `Authorization, Accept` |
| `/api/settings` | `GET`, `PUT` | `GET, PUT, OPTIONS` | `Authorization, Accept, Content-Type` |

`Content-Type` is offered to a path **if and only if that path declares a body-bearing method**
(`PUT`/`POST`/`PATCH`) — not "if it has more than one method". Three table rows cannot tell those
two rules apart, so `preflightHeadersFor` is exported and tested directly over method sets the
table does not contain (`["GET","HEAD"]`, `["GET","OPTIONS"]`, `["POST"]`, …).

Two consequences worth stating plainly:

- **`OPTIONS` is advertised but never accepted as a requested method.** The advertised list is
  `[...methods, "OPTIONS"]`, which is what a preflight response is supposed to say; a preflight
  that *requests* `OPTIONS` is a 403. That carve-out is asserted in the tests, never filtered out
  of them.
- **A preflight for an unrouted path is now a 403 where it used to be a 204.** It cannot reach the
  deployed SPA: the exact-origin check runs first, so only an origin already on `ALLOWED_ORIGINS`
  ever reaches the table at all.

An entry in that table is a live CORS grant, so there are no speculative rows in it.

Unchanged: `authenticateRequest` still runs before routing and before any body is touched, no
route sets `Access-Control-Allow-Credentials`, and an origin that is not on the allowlist is
refused and never reflected — on the new route and on its preflight.

## `SETTINGS_STORAGE_FAILED` has three occupants

Only the first is what the message ("The settings could not be read or written.") suggests.

1. **A real storage outage.** D1 unreachable, the batch rejected. Transient.
2. **A corrupt live row. Permanent, and this API can never repair it.**
3. **A concurrent `PUT`.** Transient, and cured by a retry.

### (2) The corrupt-row jam

SQLite INTEGER is an **affinity, not a type**, so the runbook's own hand-written bootstrap can
store a value the column's `CHECK (maximum_price_cents >= 0)` happily accepts and
`validateSettings` will not:

```sql
INSERT INTO search_revisions VALUES (0,'MAXIMUM_PRICE',NULL,60000.5,1);
```

`updateSearchSettings` validates the **live row** before comparing, so from then on every `PUT`
fails — in **every** mode; a mode change does not escape it — while `GET` cheerfully returns 200
with the corrupt value.

**The exhaustive condition is `Number.isSafeInteger`, not "fractional".** MEASURED, all four:

| written literal | stored `typeof()` | stored value | `GET` | a later valid `PUT` |
|---|---|---|---|---|
| `60000.0` | `integer` | `60000` | 200, `60000` | **200** |
| `60000.5` | `real` | `60000.5` | 200, `60000.5` | **503** |
| `9007199254740993.0` | `integer` | `9007199254740992` (silently rounded) | 200, that value | **503** |
| `'abc'` | `text` | `"abc"` | 200, **`"abc"`** | **503** |

A magnitude past 2^53 stores with integer type and still jams. A **TEXT** value gets through as
well, because the column's only CHECK is a lower bound and SQLite orders text above every number,
so `'abc' >= 0` is true — and then `GET` returns `maximumPriceCents: "abc"`, a string where the
contract says `number | null`. There is **no symmetric jam on `minimum_discount_percent`**, and
the reason is the constraint rather than luck: that column's CHECK carries an upper bound too
(`<= 100`), which the same type ordering makes false, so a TEXT percent is refused at INSERT.

**Repair — one statement:**

```sql
UPDATE search_revisions SET maximum_price_cents = <integer> WHERE revision = <n>;
```

There is deliberately **no dedicated error code** for this. The state is unreachable through this
API, so a distinct status would be a contract 5D must handle for a case 5D cannot cause. The
residual is accepted and named: the operator sees transient copy for a permanent condition, and
this paragraph is the runbook entry that fixes it.

### (3) The concurrent `PUT`

MEASURED: two parallel `PUT`s answer **one 200 and one 503**, with exactly one row written, the
pointer on it and no corruption. The same `PUT` twice — a double-clicked save button — behaves
the same way. The race is inside merged `updateSearchSettings` (read revision → compute next →
`INSERT` on that primary key) and its batch rolls back cleanly, so the failure mode is a clean
refusal, not a partial write. Fixing it would mean changing that merged function, which this PR
deliberately does not touch.

## Reversibility

- **Undo the code:** `wrangler rollback`, or redeploy the previous version. **No migration, so
  there is no schema state to unwind** — `0003` already has every column and CHECK this endpoint
  needs.
- **Undo a write:** a successful `PUT` appends a revision row and moves the pointer, and a Worker
  rollback does not undo that. The log is append-only on purpose, so the undo is to move the
  pointer back: `UPDATE search_settings SET current_revision = <previous> WHERE id = 1;`.
  Eligibility in `evaluateBatch` is `evaluated_revision IS NULL OR < ?5 OR > ?5`, so tasks stamped
  at the abandoned higher revision are re-opened by the `> ?5` term exactly as a forward bump
  re-opens them. No evaluation history is destroyed either way.
- **Close the endpoint alone — BOTH edits are required.** Delete the `/api/settings` row from
  `ROUTE_METHODS` **and** delete the routing block in `worker/index.ts`. They are two separate
  reads: the routing block matches `url.pathname` directly and never consults `ROUTE_METHODS`, so
  deleting the table row alone closes only the **preflight** and leaves `PUT /api/settings` fully
  open to every non-browser client. What keeps the two in step is the test suite, not the code:
  `W7` fails if the table advertises a method the router does not serve, and `W10` fails if the
  router serves a path the table does not name.
- **A closed CORS grant lingers in browsers.** The preflight replies
  `Access-Control-Max-Age: 600`, so a browser that cached the old grant can keep using it for up
  to ten minutes after the deploy. That is the reason the value is 600 and not a day; a rollback
  is not instant for an already-warm browser, and only the server-side close is.
- **Repair a jammed row:** the `UPDATE` above.

## Note for 5D (the settings form)

- `src/services/apiClient.ts` **cannot call this endpoint as written**: it hard-codes
  `method: "GET"` and sends no `Content-Type`, and `errorForResponse` lumps 400/413/415 into a
  generic `unexpected`. 5D has to widen it.
- **Do not `innerHTML` the `fields` array** from a `SETTINGS_FIELD_UNSUPPORTED` body. It echoes
  the caller's own key names verbatim, by design — that is what makes the refusal legible — and
  it is not sanitised here.
- Send exactly the three supported keys. Anything else is refused by name, not dropped.
- **Debounce the save. A 503 on `PUT` is always safe to retry, but it is not always effective:**
  under occupant (3) the retry succeeds and is idempotent (`changed: false`), and under occupant
  (2) — the permanent jam — it will fail identically forever, so a retry loop must be bounded and
  must surface the failure to the operator rather than spin.
- The `PUT` response is the authority on what is stored. Render it; do not render the form state
  back to the user as if it had been saved.
