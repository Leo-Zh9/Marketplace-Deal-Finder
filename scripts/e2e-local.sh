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
# A LOWER bound, never an upper one: a slow or loaded machine only makes it MORE true.
atleast() { [ "$3" -ge "$2" ] && ok "$1" || bad "$1" ">= $2" "$3"; }
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

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

# THE WATCH LIST IS RESET HERE, AND THE RESET IS LOAD-BEARING. THE FIX FOR A RED GATE BELOW IS TO
# RESTORE THIS RESET, NEVER TO RELAX THE ASSERTION.
#
# migrations/0005 seeds TWO targets -- `gpu-toronto` ('gpu', 'graphics card') AND `cpu-toronto`
# ('cpu', 'cpu') -- plus a market at 43.6532,-79.3832 / 25km. The collector now runs ONE SEARCH
# PER TARGET from that server-side list, and every collector assertion in this section was
# written against ONE gpu search into the market 43.5123,-79.8765|18km.
#
# Leave the seed in place and two independent things break at once, ~8 assertions going red
# together in a way that reads like a data bug:
#
#   1. BOTH targets parse the SAME committed fixture -- COLLECTOR_HTML_FILE is process-level, not
#      per-target -- so the `cpu` pass REWRITES the same six (source, listing_id) rows with
#      component_type='cpu'. Every derived model_key changes with it: normalization resolves a
#      title against the CPU trie instead of the GPU one, so 'GeForce RTX 5080' stops resolving,
#      model_stats loses its only row, and the 5080 content assertion, the recorded/skipped
#      counts and the whole-PC refusal all move.
#   2. market_key would ALSO change, from 43.5123,-79.8765|18km to 43.6532,-79.3832|25km, which
#      is the key the seeded control row below is written against -- so the control could not be
#      seeded at all.
#
# So: point the market at the values the merged assertions already use, and keep exactly ONE
# target. market_key stays 43.5123,-79.8765|18km and all 24 existing collector assertions survive
# byte-for-byte.
sql "UPDATE watch_market SET location='toronto', latitude=43.5123, longitude=-79.8765, radius_km=18 WHERE id=1;
     DELETE FROM watch_targets;
     INSERT INTO watch_targets (target_id, component_type, query) VALUES ('e2e-gpu', 'gpu', 'graphics card');" >/dev/null

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

echo "== the watch list the collector reads =="
# The same three auth rows the ingest route carries, because it is the same credential on the
# same terms: no browser channel, no Firebase identity, no Origin at all.
wt() { $CURL -s -o /tmp/e2e.body -w '%{http_code}' "$@" "$BASE/api/watch-targets" --max-time 15; }
is "the watch list with NO token is refused"   401 "$(wt)"
is "  ...with a WRONG token too"               401 "$(wt -H 'X-Collector-Token: wrong-but-long-enough-to-be-a-token')"
is "a valid token from the ALLOWED origin"     403 "$(wt -H "X-Collector-Token: $COLLECTOR_TOKEN" -H "Origin: $ORIGIN")"
is "the watch-list preflight is refused"       403 "$(pf /api/watch-targets GET)"
is "a valid token with no Origin reads it"     200 "$(wt -H "X-Collector-Token: $COLLECTOR_TOKEN")"
has "  ...carrying the seeded target"          '"targetId":"e2e-gpu"' "$(body)"
has "  ...and the market alongside it"         '"radiusKm":18' "$(body)"

# The real thing: the collector process, against the committed fixture, over HTTP, into D1.
#
# COLLECTOR_COMPONENT_TYPE, COLLECTOR_LOCATION, COLLECTOR_QUERY, COLLECTOR_LATITUDE,
# COLLECTOR_LONGITUDE and COLLECTOR_RADIUS_KM ARE GONE FROM HERE, AND THAT IS THE ASSERTION.
# Those six values now come from `GET /api/watch-targets`, and the fact that this run still
# collects the same four listings into the same market_key IS the proof that the collector read
# its configuration out of D1 over HTTP rather than out of this file.
COLLECTOR_EXIT=0
run_collector() { # run_collector [EXTRA=VALUE ...]
  env COLLECTOR_API_BASE="$BASE" \
      COLLECTOR_TOKEN="$COLLECTOR_TOKEN" \
      COLLECTOR_LIMIT=4 \
      COLLECTOR_HTML_FILE=collector/testing/fixtures/facebookSearchPage.html \
      "$@" \
      node collector/main.ts >/tmp/e2e-collector.out 2>&1
  COLLECTOR_EXIT=$?
}
collect() { run_collector COLLECTOR_TARGET_DELAY_MS=0; }

collect
is "the collector run exits 0"                 0 "$COLLECTOR_EXIT"
has "  ...emitting a run line"                 '"kind":"run"' "$(cat /tmp/e2e-collector.out)"
has "  ...for the ONE server-side target"      '"targets":1,"complete":true,"exitCode":0,"exitCodes":{"0":1}' "$(cat /tmp/e2e-collector.out)"
has "  ...naming that target"                  '"target":"e2e-gpu"' "$(cat /tmp/e2e-collector.out)"
# NOT cosmetic: a launchd env file with COLLECTOR_DRY_RUN set reports complete:true, exitCode:0
# forever while collecting nothing, and this is the one field that distinguishes that state.
has "  ...and NOT a dry run"                   '"dryRun":false' "$(cat /tmp/e2e-collector.out)"
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

echo "== multi-target: a partial failure drops nothing =="
# FULLY OFFLINE, NO SECOND FIXTURE. `a-bad` carries component_type='gpuu': storable (0005 puts no
# CHECK on that column, deliberately) and refused LOUDLY by the ingest route as 400
# INVALID_LISTINGS -> exit 6. It sorts FIRST, so the two good targets run AFTER a failure.
ingest_tables
sql "DELETE FROM watch_targets;
     INSERT INTO watch_targets (target_id, component_type, query) VALUES ('a-bad', 'gpuu', 'graphics card');
     INSERT INTO watch_targets (target_id, component_type, query) VALUES ('b-gpu', 'gpu', 'graphics card');
     INSERT INTO watch_targets (target_id, component_type, query) VALUES ('c-gpu', 'gpu', 'graphics card');" >/dev/null
# THIS BLOCK RUNS AT A REAL, NON-ZERO DELAY, AND THE WALL-TIME ASSERTION BELOW IS WHY.
#
# MEASURED HOLE THIS CLOSES: every unit test injects `sleep` and asserts it was CALLED with the
# right value, which is blind to whether the real one waits; the two throttle rows below assert
# the REPORTED `delayMs`, not elapsed time; and at a delay of 0 a real `setTimeout(0)` and a
# `Promise.resolve()` are behaviourally identical. So `collector/main.ts` supplied the one
# dependency nothing observed: replacing its sleep with `() => Promise.resolve()` left 156 unit
# tests AND all 79 assertions in this file green with the throttle between searches GONE. That is
# nine back-to-back searches from the operator's residential IP -- the failure that already blocks
# Cloudflare and would end the Facebook half of the product.
#
# THE NUMBERS, MEASURED ON THIS GATE: the whole 3-target run costs 97 ms of real work (node
# start-up, the watch-list GET, three fixture parses and three POSTs to 127.0.0.1). Two sleeps at
# 500 ms put the true floor at ~1,100 ms. The bound asserted is 750 ms, so the mutant would need a
# 7.7x slowdown to sneak past it and a healthy run has 350 ms of slack below its own floor.
# IT IS A LOWER BOUND, so load only helps; `setTimeout` guarantees "at least".
# THE FIX FOR A RED ROW HERE IS TO RESTORE THE SLEEP, NEVER TO LOWER THE BOUND.
MT_DELAY_MS=500
MT_FLOOR_MS=750
MT_T0=$(now_ms)
run_collector COLLECTOR_TARGET_DELAY_MS=$MT_DELAY_MS
MT_ELAPSED=$(( $(now_ms) - MT_T0 ))
is "the multi-target run exits 6"              6 "$COLLECTOR_EXIT"
is "  ...with one line per target"             3 "$(grep -c '"kind":"target"' /tmp/e2e-collector.out)"
# THE LOAD-BEARING ASSERTION. One line pins the per-target outcomes, the partial/complete boolean,
# the fold -- and, by summing to 3, that NO TARGET WAS DROPPED. `targets.filter(parseOk)` would
# report targets:2, exitCodes:{"0":2}, complete:true and exit 0 while one search silently stopped.
has "  ...pinning every per-target outcome"    '"targets":3,"complete":false,"exitCode":6,"exitCodes":{"0":2,"6":1}' "$(cat /tmp/e2e-collector.out)"
# The half the counters cannot say: the two good targets' listings STILL REACHED D1 although the
# failing target ran FIRST.
is "  ...and the good targets still wrote"     4 "$(val "SELECT COUNT(*) FROM listings WHERE component_type='gpu'")"
is "  ...and the bad target wrote nothing"     0 "$(val "SELECT COUNT(*) FROM listings WHERE component_type='gpuu'")"
has "  ...at the delay it was given"           "\"delayMs\":$MT_DELAY_MS" "$(cat /tmp/e2e-collector.out)"
# THE MECHANISM, not the reported value: three targets means TWO real sleeps.
atleast "  ...and REALLY slept between them (${MT_ELAPSED}ms)" "$MT_FLOOR_MS" "$MT_ELAPSED"

echo "== the throttle, pinned in BOTH directions =="
# Two rows, and neither alone is enough. UNSET must report 60000: with the variable SET to 60000
# a literal `0` fallback in main.ts would pass. And the 0 row is what catches a TYPO'D VARIABLE
# NAME -- with the variable unset, COLLECTOR_TARGET_DELAY_MS and COLLECTOR_TARGET_DELY_MS both
# take the fallback and both emit 60000.
# THE FIRST ROW'S VARIABLE MUST BE LEFT UNSET. Do not "fix" it to COLLECTOR_TARGET_DELAY_MS=60000.
# Both run at N = 1, where no sleep happens, so they cost one process each and no wall time.
sql "DELETE FROM watch_targets;
     INSERT INTO watch_targets (target_id, component_type, query) VALUES ('e2e-gpu', 'gpu', 'graphics card');" >/dev/null
run_collector
is "an UNSET delay still exits 0"              0 "$COLLECTOR_EXIT"
has "  ...and falls back to 60000"             '"delayMs":60000' "$(cat /tmp/e2e-collector.out)"
collect
is "a delay of 0 still exits 0"                0 "$COLLECTOR_EXIT"
has "  ...and reports the 0 it was given"      '"delayMs":0' "$(cat /tmp/e2e-collector.out)"

ingest_tables

# THE WATCH LIST IS RESTORED TO THE SHIPPED SEED, AND THAT IS NOT TIDINESS -- IT IS WHAT KEEPS THE
# RESET AT THE TOP OF THE COLLECTOR SECTION LOAD-BEARING ON EVERY RUN.
#
# MEASURED: with the local D1 left holding this file's own one-target list, DELETING the reset at
# the top changes NOTHING -- the gate passes 79/79 against a database a previous run already
# conditioned, so the reset silently stops being tested from the second run onward. Restoring the
# seed here means every run starts from the state a FRESH `wrangler d1 migrations apply` produces,
# which is the only state the reset exists to survive. With this line present, deleting the reset
# turns the collector section red.
sql "DELETE FROM watch_targets;
     INSERT INTO watch_targets (target_id, component_type, query) VALUES ('cpu-toronto', 'cpu', 'cpu');
     INSERT INTO watch_targets (target_id, component_type, query) VALUES ('gpu-toronto', 'gpu', 'graphics card');
     UPDATE watch_market SET location='toronto', latitude=43.6532, longitude=-79.3832, radius_km=25 WHERE id=1;" >/dev/null
# AND THE RESTORE IS ASSERTED, NOT ASSUMED -- which is the same defect one level in. `sql()`
# discards stderr, this script has no `set -e`, and an unchecked restore that silently failed
# would leave the gate green while the reset at the top of the collector section quietly stopped
# being load-bearing all over again.
#
# WHAT THE TWO ROWS BELOW COVER, STATED AT THE WIDTH THEY ACTUALLY MEASURE: every column the
# reset writes -- the target count, the location, both coordinates and the radius. They do NOT
# cover a restore that writes the right values into the wrong DATABASE, or one that also mutates
# a table nothing here reads. "Impossible" was the word here before and it was one notch too
# wide, which is the same defect these rows exist to catch.
is "the shipped seed is restored"              2 "$(val 'SELECT COUNT(*) FROM watch_targets')"
# THE COORDINATES ARE IN THIS ASSERTION BECAUSE THEY ARE WHAT market_key IS BUILT FROM. Measured:
# a PARTIAL restore that dropped only the latitude/longitude clause left both rows green with the
# coordinates still at this file's own values -- an assertion one notch wider than its
# measurement, on exactly the two columns the reset exists to control.
is "  ...and the market with it"               'toronto|43.6532,-79.3832|25' \
   "$(val "SELECT location || '|' || latitude || ',' || longitude || '|' || radius_km FROM watch_market")"

printf '\n  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
