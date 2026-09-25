#!/usr/bin/env bash
# The launchd wrapper. A TEMPLATE THAT NOTHING HERE INSTALLS: no test runs `launchctl load` or
# `launchctl bootstrap`, and nothing writes to ~/Library/LaunchAgents.
#
# WHY A WRAPPER AT ALL -- three real failures, not tidiness:
#
#   1. launchd jobs run with a MINIMAL ENVIRONMENT and NO PATH to a version-managed `node`.
#      Sourcing the operator's env file is what puts one back.
#   2. launchd jobs have NO WORKING DIRECTORY, and `node collector/main.ts` needs the repo root.
#      That is derived from this script's own location, so a moved checkout does not silently
#      run the wrong tree.
#   3. THE TOKEN MUST NOT BE IN THE PLIST. Files in ~/Library/LaunchAgents are world-readable,
#      so an `EnvironmentVariables` block would put a live secret in one. It lives in
#      ~/.marketplace-collector.env instead, and this script REFUSES to run unless that file
#      exists and its mode is exactly 600.
#
#      WHAT PROTECTS IT IS THE MODE AND THE LOCATION, NOT .gitignore, AND THE DIFFERENCE MATTERS:
#      the file is in $HOME, where .gitignore has no say whatsoever, and `.env.*` would not have
#      matched `marketplace-collector.env` in any case -- that pattern needs a leading dot before
#      `env`. .gitignore now names the file explicitly, but ONLY to catch a copy dropped inside
#      the repo. Do not read that as cover for the real one.
#
# EVERY EMITTED LINE IS PREFIXED WITH AN ISO-8601 UTC TIMESTAMP, and that is what makes a missed
# schedule window VISIBLE rather than an absence of evidence: coverage equals uptime on a Mac
# that sleeps, so a skipped window can only be seen as a GAP IN A TIMESTAMPED FILE.
#
# It exits with the collector's own exit code. launchd records it as `last exit code`, which
# `launchctl print gui/$UID/com.marketplace-deal-finder.collector` reports.
set -euo pipefail

# COLLECTOR_ENV_FILE is a test seam, the same character as COLLECTOR_HTML_FILE: launchd sets
# neither, so a real run always takes the default.
ENV_FILE=${COLLECTOR_ENV_FILE:-$HOME/.marketplace-collector.env}
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)

if [ ! -f "$ENV_FILE" ]; then
  echo "collector-run: $ENV_FILE does not exist" >&2
  exit 2
fi

# FAIL LOUDLY ON A READABLE SECRET, never warn and continue. `stat -f %Lp` is the BSD/macOS
# spelling; this script is only ever run by launchd on the operator's Mac.
MODE=$(stat -f %Lp "$ENV_FILE")
if [ "$MODE" != "600" ]; then
  echo "collector-run: $ENV_FILE must be mode 600, not $MODE (chmod 600 \"$ENV_FILE\")" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

cd "$REPO_DIR"

stamp() {
  while IFS= read -r line; do
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$line"
  done
}

# `set +e` around the pipeline, then PIPESTATUS[0]: `set -e` would abort before the exit code
# could be read, and the pipeline's own status is the STAMP function's without it. The collector
# exit code is the operator's only signal and it must survive the timestamping.
set +e
node collector/main.ts 2>&1 | stamp
status=${PIPESTATUS[0]}
set -e

exit "$status"
