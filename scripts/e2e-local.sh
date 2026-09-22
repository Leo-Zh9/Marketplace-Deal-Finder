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
  npx --no-install wrangler dev --config wrangler.local.jsonc --port 8787 >/tmp/e2e-worker.log 2>&1 &
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

printf '\n  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
