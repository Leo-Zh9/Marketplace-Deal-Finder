#!/usr/bin/env bash
# Local end-to-end check: exercises the real Worker over HTTP against a real local D1.
#
# `npm run check` proves units and seams. This proves the pieces CONNECT: that an HTTP
# write reaches D1, that the scheduler reads what the API wrote, and that auth and CORS
# still hold on a running server rather than in a harness.
#
#   ./scripts/e2e-local.sh          # assumes a worker is already on :8787
#   ./scripts/e2e-local.sh --serve  # starts and stops one itself
#
# Exits non-zero on the first failing assertion. Every check here has been verified to
# FAIL when the thing it tests is broken -- a check that cannot go red proves nothing.
set -uo pipefail

BASE=${BASE:-http://127.0.0.1:8787}
ORIGIN=${ORIGIN:-http://localhost:5173}
EVIL=https://evil.example
CURL=/usr/bin/curl
PASS=0; FAIL=0; SERVER_PID=

# A FIXTURE, NOT A SECRET, and not a violation of "no secret in a committed file": nothing here
# names the production token, wrangler.local.jsonc still defines none (so `npm run dev:worker`
# correctly answers 503 until a developer writes .dev.vars), and this value is reachable only on
# 127.0.0.1 by a worker this script started and kills. Without --serve the script uses
# COLLECTOR_TOKEN from the environment; if the running worker has none, the ingest assertions
# fail LOUDLY with 401/503 rather than skipping.
E2E_COLLECTOR_TOKEN=e2e-collector-token-4d81f0ba75c9e236
COLLECTOR_TOKEN=${COLLECTOR_TOKEN:-}

cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; }
trap cleanup EXIT

ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n     expected: %s\n     actual:   %s\n' "$1" "$2" "$3"; }
is()   { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
has()  { case "$3" in *"$2"*) ok "$1";; *) bad "$1" "contains $2" "$3";; esac; }

sql()  { npx --no-install wrangler d1 execute marketplace-deal-finder-db --local --command "$1" 2>/dev/null; }
val()  { sql "$1" | python3 -c "
import sys,json,re
raw=sys.stdin.read(); i=raw.find('[')
try:
    rows=json.loads(raw[i:])[0]['results']
    print('' if not rows else list(rows[0].values())[0])
except Exception: print('')
"; }
code() { $CURL -s -o /tmp/e2e.body -w '%{http_code}' "$@" --max-time 15; }

# Workflows are ASYNCHRONOUS: the scheduled handler returns as soon as create() is
# called, long before the instance writes its row. A single read is a race that reads
# empty in both the healthy and the broken case -- i.e. an assertion that cannot fail.
# Poll for the expected value, and only then assert.
until_val() { # until_val <sql> <expected> [tries]
  local t=${3:-25}
  for _ in $(seq 1 "$t"); do [ "$(val "$1")" = "$2" ] && return 0; sleep 0.4; done
  return 1
}
body() { cat /tmp/e2e.body; }

if [ "${1:-}" = "--serve" ]; then
  npx --no-install wrangler d1 migrations apply marketplace-deal-finder-db --local >/dev/null 2>&1
  COLLECTOR_TOKEN=$E2E_COLLECTOR_TOKEN
  # --var injects the value for this process only. MEASURED to coexist with the config's own
  # `vars` block, which is why wrangler.local.jsonc does not need (and must not have) a token.
  npx --no-install wrangler dev --config wrangler.local.jsonc --port 8787 \
    --var "COLLECTOR_TOKEN:$E2E_COLLECTOR_TOKEN" >/tmp/e2e-worker.log 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 40); do $CURL -sf -o /dev/null "$BASE/api/status" --max-time 2 && break; sleep 1; done
fi

echo "== auth and CORS =="
is "loopback dev identity is accepted"        200 "$(code -H "Origin: $ORIGIN" "$BASE/api/status")"
is "an evil origin is refused"                403 "$(code -H "Origin: $EVIL" "$BASE/api/settings")"
h=$($CURL -s -D- -o /dev/null -H "Origin: $EVIL" "$BASE/api/settings" --max-time 15 | grep -ci "access-control-allow-origin: $EVIL")
is "an evil origin is never reflected"        0 "$h"
is "an unrouted path is 404"                  404 "$(code -H "Origin: $ORIGIN" "$BASE/api/nope")"

echo "== preflight is scoped per path =="
pf() { $CURL -s -o /dev/null -w '%{http_code}' -X OPTIONS -H "Origin: $ORIGIN" \
        -H "Access-Control-Request-Method: $2" ${3:+-H "Access-Control-Request-Headers: $3"} \
        "$BASE$1" --max-time 15; }
is "PUT is allowed on /api/settings"          204 "$(pf /api/settings PUT)"
is "PUT is REFUSED on /api/status"            403 "$(pf /api/status PUT)"
is "content-type is REFUSED on /api/status"   403 "$(pf /api/status GET content-type)"
is "DELETE is refused on /api/settings"       403 "$(pf /api/settings DELETE)"

echo "== settings write path =="
sql "DELETE FROM search_settings; DELETE FROM search_revisions;" >/dev/null
is "GET with no settings is 200"              200 "$(code -H "Origin: $ORIGIN" "$BASE/api/settings")"
is "  ...and the body says null"              '{"settings":null}' "$(body)"

put() { code -X PUT -H "Origin: $ORIGIN" -H "Content-Type: application/json" -d "$1" "$BASE/api/settings"; }
is "a valid PUT is accepted"                  200 "$(put '{"mode":"MAXIMUM_PRICE","minimumDiscountPercent":null,"maximumPriceCents":74900}')"
has "  ...and reports changed"                '"changed":true' "$(body)"
is "  ...and the row reached D1"              74900 "$(val 'SELECT maximum_price_cents FROM search_revisions WHERE revision=0')"
is "an identical PUT is idempotent"           200 "$(put '{"mode":"MAXIMUM_PRICE","minimumDiscountPercent":null,"maximumPriceCents":74900}')"
has "  ...and reports NO change"              '"changed":false' "$(body)"
is "  ...and wrote no second revision"        1 "$(val 'SELECT COUNT(*) FROM search_revisions')"
is "a changed PUT bumps the revision"         200 "$(put '{"mode":"MAXIMUM_PRICE","minimumDiscountPercent":null,"maximumPriceCents":61250}')"
has "  ...to revision 1"                      '"searchRevision":1' "$(body)"

echo "== settings rejections =="
is "an unstorable field is refused"           400 "$(put '{"mode":"MAXIMUM_PRICE","maximumPriceCents":74900,"radiusKm":25}')"
has "  ...naming the field"                   '"fields":["radiusKm"]' "$(body)"
is "an invented mode is refused"              400 "$(put '{"mode":"WISHFUL","minimumDiscountPercent":23.5,"maximumPriceCents":74900}')"
is "a wrong content-type is refused"          415 "$(code -X PUT -H "Origin: $ORIGIN" -H 'Content-Type: text/plain' -d '{}' "$BASE/api/settings")"
is "malformed JSON is refused"                400 "$(put '{')"

echo "== the cross-component link: does the scheduler read what the API wrote? =="
fire() { $CURL -s -o /dev/null "$BASE/cdn-cgi/handler/scheduled?cron=$(python3 -c "import urllib.parse;print(urllib.parse.quote('$1'))")" --max-time 20; }
sql "DELETE FROM monitor_runs" >/dev/null; sql "DELETE FROM monitor_lock" >/dev/null
fire '*/30 * * * *'
until_val 'SELECT COUNT(*) FROM monitor_runs' 1
is "a configured run reports OK"              OK "$(val 'SELECT status FROM monitor_runs ORDER BY run_seq DESC LIMIT 1')"
is "  ...at the revision the API wrote"       1 "$(val 'SELECT search_revision FROM monitor_runs ORDER BY run_seq DESC LIMIT 1')"
# The control. Without it, "OK" could be a default rather than a reading of the settings.
sql "DELETE FROM search_settings" >/dev/null; sql "DELETE FROM monitor_lock" >/dev/null
sql "DELETE FROM monitor_runs" >/dev/null
fire '*/30 * * * *'
until_val 'SELECT COUNT(*) FROM monitor_runs' 1
is "an unconfigured run reports NO_SETTINGS"  NO_SETTINGS "$(val 'SELECT status FROM monitor_runs ORDER BY run_seq DESC LIMIT 1')"

echo "== the cron guard routes each schedule to its own workflow =="
# The guard exists because both crons reach one handler. If it broke, the daily cleanup
# would silently run monitoring 48x/day, or monitoring would run cleanup. The observable
# is monitor_runs: the cleanup cron must leave it untouched.
sql "DELETE FROM monitor_runs" >/dev/null; sql "DELETE FROM monitor_lock" >/dev/null
fire '0 17 * * *'
# Give a wrongly-routed monitoring run as long to appear as a correct one gets below.
until_val 'SELECT COUNT(*) FROM monitor_runs' 1 12
is "the cleanup cron writes NO monitoring run" 0 "$(val 'SELECT COUNT(*) FROM monitor_runs')"
sql "DELETE FROM monitor_lock" >/dev/null
fire '*/30 * * * *'
until_val 'SELECT COUNT(*) FROM monitor_runs' 1
is "the monitoring cron DOES write one"        1 "$(val 'SELECT COUNT(*) FROM monitor_runs')"

echo "== the collector ingest path =="
# THIS SECTION RUNS LAST AND TRUNCATES ITS FOUR TABLES AT BOTH ENDS.
# The settings section above leaves search_settings pointing at a MAXIMUM_PRICE / 61250 revision
# for the WHOLE MIDDLE of this script; it is cleared only at the very end, for the NO_SETTINGS
# check. MEASURED: under MAXIMUM_PRICE the evaluation drain marks an un-normalized CA$0 listing
# DEAL -- the exact verdict PR #6 exists to prevent. Anywhere between those two points, a
# monitoring run would put that DEAL inside the gate. Moving this section earlier reintroduces it.
# Truncating at both ends is what keeps a re-run from draining the previous run's leftovers.
ingest_tables() { sql "DELETE FROM listings; DELETE FROM price_observations; DELETE FROM model_stats; DELETE FROM evaluation_tasks;" >/dev/null; }
ingest_tables

ING="$BASE/api/listings"
MINI='{"source":"facebook-marketplace","componentType":"gpu","market":{"latitude":43.5123,"longitude":-79.8765,"radiusKm":18},"listings":[]}'
ct() { $CURL -s -o /tmp/e2e.body -w '%{http_code}' -X POST -H 'Content-Type: application/json' "$@" -d "$MINI" "$ING" --max-time 15; }

is "ingest with NO token is refused"           401 "$(ct)"
is "ingest with a WRONG token is refused"      401 "$(ct -H 'X-Collector-Token: wrong-but-long-enough-to-be-a-token')"
is "the ingest preflight is refused"           403 "$(pf /api/listings POST)"
is "a valid token from the ALLOWED origin"     403 "$(ct -H "X-Collector-Token: $COLLECTOR_TOKEN" -H "Origin: $ORIGIN")"
is "a valid token from an evil origin"         403 "$(ct -H "X-Collector-Token: $COLLECTOR_TOKEN" -H "Origin: $EVIL")"
h=$($CURL -s -D- -o /dev/null -X POST -H 'Content-Type: application/json' -H "X-Collector-Token: $COLLECTOR_TOKEN" \
      -H "Origin: $EVIL" -d "$MINI" "$ING" --max-time 15 | grep -ci "access-control-allow-origin: $EVIL")
is "  ...and evil is never reflected"          0 "$h"
is "an empty batch is refused"                 400 "$(ct -H "X-Collector-Token: $COLLECTOR_TOKEN")"

# The real thing: the collector process, against the committed fixture, over HTTP, into D1.
COLLECTOR_EXIT=0
collect() {
  COLLECTOR_API_BASE="$BASE" \
  COLLECTOR_TOKEN="$COLLECTOR_TOKEN" \
  COLLECTOR_COMPONENT_TYPE=gpu \
  COLLECTOR_LOCATION=toronto \
  COLLECTOR_QUERY='graphics card' \
  COLLECTOR_LATITUDE=43.5123 \
  COLLECTOR_LONGITUDE=-79.8765 \
  COLLECTOR_RADIUS_KM=18 \
  COLLECTOR_LIMIT=4 \
  COLLECTOR_HTML_FILE=collector/testing/fixtures/facebookSearchPage.html \
  node collector/main.ts >/tmp/e2e-collector.out 2>&1
  COLLECTOR_EXIT=$?
}

collect
is "the collector run exits 0"                 0 "$COLLECTOR_EXIT"
has "  ...reporting SUCCESS"                   '"state":"SUCCESS"' "$(cat /tmp/e2e-collector.out)"
# A total write outage answered 200 with FAILED:n and zero rows before this slice existed.
has "  ...and ZERO failed listings"            '"FAILED":0' "$(cat /tmp/e2e-collector.out)"
# EXACTLY 4, not ">= 1" and not the fixture's own 6: a parser that ignored the limit fails here.
is "  ...and four listings reached D1"         4 "$(val "SELECT COUNT(*) FROM listings WHERE source='facebook-marketplace'")"
is "  ...with the comma price parsed"          300000 "$(val "SELECT price_cents FROM listings WHERE listing_id='915010494744438'")"
# 0, not None: val() prints None for NULL, so `cents || null` is red rather than green.
is "  ...and CA\$0 stored as ZERO, not NULL"    0 "$(val "SELECT price_cents FROM listings WHERE listing_id='1807946430653887'")"
is "  ...and the title verbatim, pipes and all" 'GeForce RTX 3070 | Intel Core i9 | 1TB SSD | 16GB RAM | Gaming PC' "$(val "SELECT title FROM listings WHERE listing_id='913388811629562'")"
is "  ...and four evaluation tasks queued"     4 "$(val "SELECT COUNT(*) FROM evaluation_tasks WHERE status='PENDING'")"
# NORMALIZATION IS WHAT MAKES THESE NON-ZERO. Of the four fixture edges exactly one -- the ASUS
# ROG Astral RTX 5080 at CA$3,000 -- is a standalone catalog GPU at a positive price. The other
# three are a trade-only ad, a whole gaming PC whose title names a real GPU, and a GTX 980 Ti
# the catalog does not list. Before normalization existed all four reported skipped-no-model and
# BOTH of these counts were 0.
#
# THE FIXTURE TITLE IS LOAD-BEARING AND IT CHANGED ONCE ALREADY. It was a GTX 1080 Ti until
# src/data/catalog.ts was extended two generations back, at which point it MATCHED a catalog
# model and took SEVEN assertions in this file down with it: the two counts just below, the
# model_stats contents, `"recorded":1`, `"skipped-no-model":1`, the removal control's seed and
# the two assertions that hang off it. Maxwell (GTX 900) is now the ONLY generation left that
# keeps this listing uncatalogued. DO NOT ADD GTX 900 CARDS TO src/data/catalog.ts without
# rewriting this block and the control below; `GENERATION_TITLES` in
# worker/normalize/normalizeListing.test.ts pins the same title so the 13-second suite says so
# before this gate does.
is "  ...and ONE observation reached price_observations" 1 "$(val 'SELECT COUNT(*) FROM price_observations')"
is "  ...and ONE aggregate row reached model_stats"      1 "$(val 'SELECT COUNT(*) FROM model_stats')"
# The CONTENTS, not just the count: a rule that resolved every title to one wrong key would pass
# a count-only check. count=1 and total=300000 also pin that the CA$3,000 comma price is the
# amount that entered the average.
is "  ...holding exactly the 5080 at its asking price" 'GeForce RTX 5080|1|300000' \
   "$(val "SELECT model_key || '|' || count || '|' || total_price_cents FROM model_stats")"
# THE DANGEROUS CASE, excluded over real HTTP into real D1: a CA$1,000 whole PC whose title
# contains 'GeForce RTX 3070'. It must never be the 3070's price. MEASURED, AND SAID PLAINLY:
# TWO rules refuse this title -- emptying the whole-unit table leaves it INVALID_REFERENCE with a
# null key via mixed-components -- so this line is a REGRESSION assertion and discriminates
# neither rule. T9 in worker/normalize/normalizeListing.test.ts asserts WHICH rule fired and is
# the one that goes red.
is "  ...and the whole-PC listing is refused outright" 'INVALID_REFERENCE|NULL' \
   "$(val "SELECT validity || '|' || COALESCE(model_key,'NULL') FROM listings WHERE listing_id='913388811629562'")"
# THE CROSS-INVARIANT. modelKey and validity come from ONE rule, so a stored model key implies a
# VALID row; the reverse (VALID with a null key) is the normal uncatalogued case.
# IT IS ALSO 0 IF NO KEY IS EVER PRODUCED. Its anchor is the model_stats content line above,
# which requires 'GeForce RTX 5080|1|300000'. Deleting that line leaves this one passing on an
# inert pipeline; the two must be read, and kept, together.
is "  ...and no listing carries a key while not VALID" 0 \
   "$(val "SELECT COUNT(*) FROM listings WHERE model_key IS NOT NULL AND validity <> 'VALID'")"
# The route's own report of the same two facts. `recorded` and `skipped-no-model` were both
# structurally unreachable in one direction before this slice: every listing reported the latter.
has "  ...and the collector reports one recorded"      '"recorded":1' "$(cat /tmp/e2e-collector.out)"
has "  ...and one skipped-no-model"                    '"skipped-no-model":1' "$(cat /tmp/e2e-collector.out)"

collect
is "a second run exits 0"                      0 "$COLLECTOR_EXIT"
# THE DISCRIMINATOR. "evaluation_tasks is still 4" cannot fail: QUEUE_TASK is ON CONFLICT DO
# UPDATE, so the count is 4 whether or not the task was re-queued. The response body is what
# distinguishes a genuine UNCHANGED from a silent re-write.
has "  ...and reports UNCHANGED for all four"  '"UNCHANGED":4' "$(cat /tmp/e2e-collector.out)"
is "  ...and wrote no new listing rows"        4 "$(val 'SELECT COUNT(*) FROM listings')"
is "  ...and queued no new tasks"              4 "$(val 'SELECT COUNT(*) FROM evaluation_tasks')"

# THE CONTROL. The removal path is the one contribution outcome the fixture cannot reach on its
# own, and "it went to zero" is also what a completely inert path produces. So seed a REAL
# contribution, run the collector over the same listing, and watch it go to zero.
#
# THE CONTROL MOVED, AND THIS IS WHY. It used to hang off 915010494744438, which is the ASUS ROG
# Astral RTX 5080 -- that listing now CONTRIBUTES ON ITS OWN, so it can no longer stand in for a
# listing whose contribution must disappear. 1812246723463464 is `Nvidia GeForce GTX 980 Ti
# Graphics Card with MSI Cooler` at CA$80: a real, standalone GPU the catalog does not list, so
# the rule answers VALID with a NULL model key and the sighting still takes recordSightings'
# `removed` path. price_cents 8000 is that listing's own price.
#
# IT IS THE SAME DEPENDENCY AS THE BLOCK AT THE TOP OF THIS FILE, AND IT IS THE SHARPER HALF.
# The moment that listing carries a model key of its own, the seed INSERT below collides with
# the row the listing writes for itself and the control cannot be seeded AT ALL -- an empty
# control rather than a wrong number, which no count bump can repair. It is also the ONLY
# fixture listing that is VALID with a null key, so there is nowhere to move the control to.
# DO NOT CATALOGUE GTX 900 without rewriting this control first.
#
# THE TWO SEEDED ROWS MUST SHARE market_key / model_key / variant_key EXACTLY. SUBTRACT_OLD's
# correlated EXISTS matches price_observations against model_stats on all three; if they differ,
# the aggregate is never decremented -- but DELETE_OBS runs unconditionally, so the observation
# half of the check PASSES while the model_stats half FAILS. THE FIX FOR A RED CONTROL IS TO FIX
# THE SEED, NEVER TO RELAX THE ASSERTION. variant_key is '' on both rows, never NULL.
sql "INSERT INTO price_observations (source, listing_id, market_key, model_key, variant_key, price_cents, last_seen_at)
     VALUES ('facebook-marketplace', '1812246723463464', '43.5123,-79.8765|18km', 'control-model', '', 8000, 1);
     INSERT INTO model_stats (market_key, model_key, variant_key, count, total_price_cents)
     VALUES ('43.5123,-79.8765|18km', 'control-model', '', 1, 8000);" >/dev/null
is "the control aggregate is seeded"           1 "$(val "SELECT count FROM model_stats WHERE model_key='control-model'")"

collect
is "a third run exits 0"                       0 "$COLLECTOR_EXIT"
is "  ...and the ingest REMOVED the contribution" 0 "$(val "SELECT count FROM model_stats WHERE model_key='control-model'")"
is "  ...and deleted the control observation"  0 "$(val "SELECT COUNT(*) FROM price_observations WHERE model_key='control-model'")"
# SCOPED, and the other half of the same claim: the removal took the control and NOTHING ELSE.
# A rule that deleted every observation would pass the line above and fail this one.
is "  ...leaving the 5080's own observation"   1 "$(val 'SELECT COUNT(*) FROM price_observations')"

ingest_tables

printf '\n  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
