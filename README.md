# Undercut

**Finds underpriced PC parts on local resale marketplaces.**

Undercut watches listings for the components you care about and matches each one to a specific model. It keeps a running price for every model and flags listings that come in below it.

*(Previously "Marketplace Deal Finder". The repository name is unchanged.)*

---

## What it does

- **Watch list.** From the control panel you choose component types, models, a location and a search radius. The collector runs one search per target.
- **Model matching.** Listing titles are normalized against a catalog of **336 models across nine component types**, two generations back. A title that can't be matched with confidence is marked invalid rather than guessed.
- **Reference prices.** Every stored listing feeds a running price aggregate per model, so "normal price" comes from the market Undercut has actually seen.
- **Verdicts.** Scheduled evaluation compares each new listing with its model's reference price, and the dashboard shows the resulting deals.
- **Private by default.** Sign-in is Firebase Google auth restricted to an allowlist. The collector uses its own credential, which can reach only two routes.

## How it works

```
local collector ──GET /api/watch-targets──▶ Cloudflare Worker ◀── React dashboard
      │                                           │                (Firebase sign-in)
      └──POST /api/listings (collector token)──▶  │
                                                  ▼
                         D1: listings, dedup, running price aggregate per model
                                                  │
                     Cron (every 30 min) ─▶ Workflow: monitoring run ─▶ evaluation ─▶ verdicts
                     Cron (daily)        ─▶ Workflow: stale-listing cleanup
```

Everything runs on Cloudflare except the fetch itself (see
[Collection runs on your machine](#collection-runs-on-your-machine-not-on-cloudflare) for the
measurement behind that).

## Engineering notes

- **Hybrid by measurement, not by default.** Identical code fetched 10 listings from a residential IP and 0 from Cloudflare (a login wall served with HTTP 200). So collection moved to a small local Node process, and everything else stayed serverless.
- **Source-agnostic pipeline.** Storage, pricing, evaluation and scheduling never branch on `source`. Adding a marketplace means adding a provider module, not redesigning anything.
- **Durable, fenced evaluation.** Evaluation runs as durable tasks under a run lock, so overlapping scheduled runs can't double-process a listing.
- **Two verification gates.** `npm run check` runs offline: lint, unit tests, build and typechecks. `npm run e2e:local` drives a real `wrangler dev` Worker over HTTP against a real local D1, proving the pieces actually connect.
- **Additive-only migrations.** The applied migrations are live, so every schema change is a new numbered migration.
- **Mutation-checked tests.** Every test names the code change that makes it fail.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React, TypeScript, Vite |
| API | Cloudflare Workers (TypeScript) |
| Storage | Cloudflare D1 (SQLite) |
| Scheduling | Cloudflare Cron Triggers + Workflows |
| Auth | Firebase Google sign-in, verified in the Worker with `jose`; a separate collector token |
| Collector | Node.js |
| Testing | Vitest, Testing Library, Miniflare, local end-to-end run against `wrangler dev` |

---

# Development

## Requirements

| | |
|---|---|
| Node | 20+ (developed on 24) |
| npm | 10+ |
| Cloudflare account | only for deploying, or for the local end-to-end check |

`npm install` is the only setup step for the unit suite. **No credentials are needed to
run the tests.**

---

## Quick start

```bash
git clone git@github.com:Leo-Zh9/Marketplace-Deal-Finder.git
cd Marketplace-Deal-Finder
npm install
npm run check
```

`npm run check` is lint → unit tests → build → worker typecheck → collector typecheck. It is
offline, needs no configuration, and is the gate every change has to pass.

---

## The two gates

Every change is verified twice, because they prove different things.

```bash
npm run check       # units and seams — offline, fast, no config
npm run e2e:local   # the real Worker over HTTP against a real local D1
```

`npm run check` cannot prove the pieces **connect**: that an HTTP write reaches the
database, that the scheduler reads what the API wrote, or that auth and CORS hold on a
running server rather than in a test harness. `npm run e2e:local` starts a real
`wrangler dev`, exercises the live HTTP surface, and asserts the cross-component link —
including a control that removes the settings and asserts the scheduler notices.

**Before the first `e2e:local` run, create the local database:**

```bash
npm run db:migrate:local
```

That is a one-time step per machine. `e2e:local` starts and stops its own Worker.

---

## Local development

```bash
npm run db:migrate:local   # once per machine
npm run dev:full           # frontend on :5173, Worker on :8787
```

Locally the Worker accepts a development identity when `APP_ENV` is `local` **and** the
request arrives on a loopback host, so no Firebase token is needed. Both conditions are
required, and production is pinned to `APP_ENV: "production"`, so this path is not
reachable from a deployed instance.

`.dev.vars` holds local-only values and is gitignored. See `.dev.vars.example` — it is
deliberately empty, because local development needs no secrets.

---

## Deploying

```bash
npx wrangler deploy --dry-run   # offline: catches an unexported Workflow class or a bad cron
npm run db:migrate              # migrations FIRST, against the real database
npx wrangler deploy
```

Order matters. Deploying a schedule before its migration fails silently on every fire.
`docs/phase-3e-monitoring.md` carries the full runbook and the rollback.

### Values that are specific to one account

Running your **own** instance rather than contributing to this one means replacing:

| where | what |
|---|---|
| `wrangler.jsonc`, `wrangler.local.jsonc` | `database_id` — from `wrangler d1 create` |
| `wrangler.jsonc` | `ALLOWED_ORIGINS` — your frontend origin, exact match |
| `wrangler.jsonc` | `FIREBASE_PROJECT_ID` |
| `wrangler secret put APPROVED_EMAILS` | a JSON array of allowed sign-in addresses |

`APPROVED_EMAILS` is a Worker secret. It must never appear in a committed file, and never
as a `VITE_*` value — those are compiled into the browser bundle.

> Piping a secret through non-TTY stdin can upload an **empty** value and still print
> success. Use `wrangler secret put NAME` interactively, or `< file` and then delete the
> file — and verify with `wrangler secret list`.

---

## Collection runs on your machine, not on Cloudflare

Everything in this project runs on Cloudflare **except the fetch**. Measured with identical code
from two egress points one minute apart, Facebook Marketplace returns 10 listings to a
residential IP and **0 listings plus a login wall — at HTTP 200 — to Cloudflare**. A VPS is the
same class of address. So a small Node collector runs on the operator's machine and posts
batches to `POST /api/listings`:

```bash
npm run collect     # see docs/collector-ingest.md for the environment it needs
```

It is a one-shot process, not a daemon — but it is no longer a *single-request* one. It first
reads its **watch list** from `GET /api/watch-targets` (what to hunt, and the one market saying
where and how far), then runs **one search per target**, at most `MAX_TARGETS_PER_RUN = 9`, with
60 s between them: one GET plus up to nine source requests and nine POSTs, then it exits. No
pagination, no cursor following, no retry of any request.

Both routes are guarded by the same Worker secret, `COLLECTOR_TOKEN`, a **third** identity that
reaches **`POST /api/listings` and `GET /api/watch-targets`, and nothing else**. A leak therefore
now discloses the component types, the query strings and a lat/long as well as allowing writes —
`docs/collector-ingest.md` states exactly what it would allow. **Until that secret is set, the
deployed routes answer 503 and both branches are dead**, and **`npm run db:migrate` must have run
before the first collection** or the watch-list read is a permanent 503.

**Before changing the evaluation mode, read the warning in `docs/collector-ingest.md`:** until
model normalization lands, `MAXIMUM_PRICE` makes the drain mark un-normalized listings — a free
one included — as deals.

---

## Docs

| doc | covers |
|---|---|
| `PLAN.md` | product rules — what counts as a deal, what a reference price is |
| `ARCHITECTURE.md` | system shape |
| `docs/phase-3c-storage.md` | storage, deduplication, the running aggregate |
| `docs/phase-3d-evaluation.md` | pricing and the evaluation queue |
| `docs/phase-3e-scheduling.md` | the daily cleanup Workflow |
| `docs/phase-3e-monitoring.md` | the monitoring run, the lock, telemetry, the runbook |
| `docs/phase-5a-settings-api.md` | the settings API contract |
| `docs/collector-ingest.md` | the collector, the ingest route and its credential |

---

## Repository conventions

- **No CI.** "Green" means `npm run check` exiting 0 locally on the pushed branch. One
  local run is the entire verification for a pull request.
- **Migrations are additive only.** SQLite cannot drop a `CHECK` or alter a primary key,
  and the applied migrations are live. A schema change is a new numbered migration.
- **Every test names the mutation that kills it.** A test that cannot be made to fail is
  not a test, and a mutation that fails for the wrong reason proves nothing — check the
  shape of a failure, not just its count.
