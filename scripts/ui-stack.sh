#!/bin/bash
# scripts/ui-stack.sh -- run the WHOLE product locally so a person (or an agent) can drive the real
# dashboard in a browser: the Worker (`wrangler dev`, local D1), the dashboard (`vite`), the real
# collector process against a saved Facebook page, and a fake Discord. NOTHING HERE TOUCHES
# PRODUCTION: every D1 command is `--local`, the collector posts to 127.0.0.1, and the only webhook
# is the stub on 127.0.0.1 (the Worker accepts a plain-http loopback URL only under APP_ENV=local).
#
#   ./scripts/ui-stack.sh up [--fresh]   start everything (--fresh wipes THIS checkout's local D1 first)
#   ./scripts/ui-stack.sh claim          claim user 1 as local-dev@localhost (a fresh D1 starts unclaimed)
#   ./scripts/ui-stack.sh user <name>    create <name>@localhost (then open http://localhost:5173/?as=<name>)
#   ./scripts/ui-stack.sh collect [page] one real collector run against a saved page (default: the fixture)
#   ./scripts/ui-stack.sh ingest <lat> <lon> <radiusKm> <price,price,...> <idPrefix>
#                                        post RTX 4070 Super listings, one per price, into that market
#   ./scripts/ui-stack.sh fire           run the 30-minute monitor (drain + notify) once
#   ./scripts/ui-stack.sh targets        what the collector would be told to search
#   ./scripts/ui-stack.sh posts          what the fake Discord received (path = whose webhook)
#   ./scripts/ui-stack.sh sql "<sql>"    a query against the local D1
#   ./scripts/ui-stack.sh down           stop everything
#
# A typical two-person check: up --fresh, claim, user alice, user bob; set each one up in the dashboard
# (`?as=alice`, `?as=bob`), including a webhook such as http://127.0.0.1:8798/api/webhooks/2/alice;
# then ingest into each area, fire, and read `posts`. See docs/local-ui-testing.md.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
STATE=${UI_STACK_STATE:-$ROOT/.ui-stack}
BASE=http://127.0.0.1:8787
ORIGIN=http://127.0.0.1:5173
STUB_PORT=8798
LOCK=/tmp/mdf-e2e.lock
cd "$ROOT" || exit 1
mkdir -p "$STATE"

sql() {
  npx --no-install wrangler d1 execute marketplace-deal-finder-db --local --command "$1" --json 2>/dev/null |
    python3 -c "import sys,json
raw=sys.stdin.read(); i=raw.find('[')
if i < 0: sys.exit('the query failed (is the stack migrated?)')
for r in json.loads(raw[i:]): print(r['results'])"
}
token() { cat "$STATE/collector-token"; }

case "${1:-}" in
up)
  # ONE local stack at a time: e2e-local.sh and this script both bind 8787/8798 and share local D1.
  mkdir "$LOCK" 2>/dev/null || { echo "lock $LOCK is held (an e2e run or another stack); 'down' it first"; exit 1; }
  if pgrep -f "^bash ./scripts/e2e-local.sh" >/dev/null || lsof -iTCP:8787 -iTCP:5173 -iTCP:$STUB_PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
    rmdir "$LOCK"; echo "port 8787, 5173 or $STUB_PORT is in use, or e2e-local.sh is running"; exit 1
  fi
  [ "${2:-}" = "--fresh" ] && rm -rf .wrangler/state
  python3 -c "import secrets;print('ui-stack-'+secrets.token_hex(12))" >"$STATE/collector-token"
  npx --no-install wrangler d1 migrations apply marketplace-deal-finder-db --local >"$STATE/migrate.log" 2>&1 ||
    { echo "migration failed: $STATE/migrate.log"; rmdir "$LOCK"; exit 1; }
  echo '[]' >"$STATE/discord-script.json"; rm -f "$STATE/discord-log.jsonl"
  nohup node scripts/e2e-discord-stub.mjs "$STATE/discord-script.json" "$STATE/discord-log.jsonl" "$STUB_PORT" \
    >"$STATE/discord.out" 2>&1 & echo $! >"$STATE/discord.pid"
  nohup npx --no-install wrangler dev --config wrangler.local.jsonc --port 8787 \
    --var "COLLECTOR_TOKEN:$(token)" --var "NOTIFICATIONS:on" \
    --var "DISCORD_WEBHOOK_URL:http://127.0.0.1:$STUB_PORT/api/webhooks/1/owner" >"$STATE/worker.log" 2>&1 &
  echo $! >"$STATE/worker.pid"
  nohup npx --no-install vite >"$STATE/vite.log" 2>&1 & echo $! >"$STATE/vite.pid"
  for _ in $(seq 1 60); do curl -s -o /dev/null "$BASE/api/status" -H "Origin: $ORIGIN" --max-time 2 && break; sleep 1; done
  echo "up: dashboard http://localhost:5173  (logs in $STATE)"
  sql "SELECT user_id, email, monitoring_enabled FROM users ORDER BY user_id"
  ;;
claim)
  sql "UPDATE users SET email = 'local-dev@localhost' WHERE user_id = 1 AND email IS NULL" >/dev/null
  sql "SELECT user_id, email FROM users WHERE user_id = 1"
  ;;
user)
  [ -n "${2:-}" ] || { echo "usage: user <name>"; exit 2; }
  curl -s -o /dev/null -w "$2@localhost: HTTP %{http_code}\n" "$BASE/api/settings" -H "Origin: $ORIGIN" -H "X-Local-User: $2"
  ;;
collect)
  env COLLECTOR_API_BASE="$BASE" COLLECTOR_TOKEN="$(token)" COLLECTOR_LIMIT=4 COLLECTOR_TARGET_DELAY_MS=0 \
    COLLECTOR_HTML_FILE="${2:-collector/testing/fixtures/facebookSearchPage.html}" \
    COLLECTOR_STATE_FILE="$STATE/collector-state.json" node collector/main.ts >"$STATE/collector.out" 2>&1
  echo "collector exit $?"; grep -o '"kind":"run"[^}]*' "$STATE/collector.out" | tail -1
  ;;
ingest)
  [ $# -ge 6 ] || { echo "usage: ingest <lat> <lon> <radiusKm> <price,...> <idPrefix>"; exit 2; }
  python3 - "$2" "$3" "$4" "$5" "$6" >"$STATE/ingest.json" <<'EOF'
import json, sys
lat, lon, radius, prices, prefix = float(sys.argv[1]), float(sys.argv[2]), int(sys.argv[3]), sys.argv[4].split(","), sys.argv[5]
rows = [{"listingId": "%s%02d" % (prefix, i), "title": "MSI GeForce RTX 4070 Super Ventus 2X 12GB",
         "priceText": "CA$%s" % p, "locationText": "Ontario",
         "url": "https://www.facebook.com/marketplace/item/%s%02d" % (prefix, i)} for i, p in enumerate(prices, 1)]
print(json.dumps({"source": "facebook-marketplace", "componentType": "gpu",
                  "market": {"latitude": lat, "longitude": lon, "radiusKm": radius}, "listings": rows}))
EOF
  curl -s -o /dev/null -w "ingest: HTTP %{http_code}\n" -X POST -H "Content-Type: application/json" \
    -H "X-Collector-Token: $(token)" -d @"$STATE/ingest.json" "$BASE/api/listings"
  ;;
fire)
  sql "DELETE FROM monitor_lock" >/dev/null
  before=$(sql "SELECT COUNT(*) n FROM monitor_runs" | grep -o '[0-9]\+')
  curl -s -o /dev/null --max-time 20 \
    "$BASE/cdn-cgi/handler/scheduled?cron=%2A%2F30%20%2A%20%2A%20%2A%20%2A&time=$(python3 -c 'import time;print(int(time.time()*1000))')"
  for _ in $(seq 1 40); do [ "$(sql "SELECT COUNT(*) n FROM monitor_runs" | grep -o '[0-9]\+')" != "$before" ] && break; sleep 0.5; done
  sql "SELECT status, claimed_count FROM monitor_runs ORDER BY run_seq DESC LIMIT 1"
  ;;
targets)
  curl -s -H "X-Collector-Token: $(token)" "$BASE/api/watch-targets" | python3 -c "import json,sys
d=json.load(sys.stdin); print('monitoring:', d.get('monitoring'), '| top-level market:', d.get('market'))
for t in d.get('targets', []): m=t.get('market') or {}; print(' ', t['targetId'], '|', t['query'], '|', m.get('location'), m.get('radiusKm'))"
  ;;
posts)
  [ -f "$STATE/discord-log.jsonl" ] || { echo "no posts"; exit 0; }
  python3 -c "import json
for line in open('$STATE/discord-log.jsonl'):
    r=json.loads(line)
    if r['method']=='POST': print(r['path'].split('?')[0], '|', (r['body'] or {}).get('content','').split(chr(10))[0])"
  ;;
sql) sql "$2" ;;
down)
  for f in worker vite discord; do [ -f "$STATE/$f.pid" ] && kill "$(cat "$STATE/$f.pid")" 2>/dev/null; rm -f "$STATE/$f.pid"; done
  sleep 2
  for p in 8787 5173 $STUB_PORT; do lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null; done
  rmdir "$LOCK" 2>/dev/null; echo down
  ;;
*) sed -n '2,25p' "$0"; exit 2 ;;
esac
