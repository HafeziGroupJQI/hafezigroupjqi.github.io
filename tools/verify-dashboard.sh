#!/usr/bin/env bash
# End-to-end check of the /devices dashboard's server truth (and, optionally, the page itself).
#
#   1. boots a private `wrangler dev` Worker (dev auth, own port, own D1/DO state, migrations applied)
#   2. dev-logs-in with a cookie jar and creates two devices through the member API
#   3. simulates a HafeziAgent with curl: enroll -> declare one simulated instrument -> heartbeat ->
#      readings + a log line (the second device stays un-enrolled, i.e. "pending")
#   4. asserts the liveness fields: liveness=online, instruments_online=1, effective_status=online,
#      pending for the other device, and that the SSE `hello` frame carries the reading
#   5. --screenshots: keeps the fake agent heartbeating and drives the real page in headless
#      Chromium (playwright-core) through every tab and overview layout into $SHOTS_DIR
#
# Usage: tools/verify-dashboard.sh [--screenshots]
#   The page itself is served from ../.cache/private-site (wrangler.jsonc `assets`), so run
#   `npm run build:members` first when you want screenshots of the current frontend.
# Env:   DASH_PORT (8798), SHOTS_DIR (default: ./dashboard-shots)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_DIR="$ROOT/worker"
PORT="${DASH_PORT:-8798}"
URL="http://localhost:$PORT"
WORK="$(mktemp -d -t hafezi-dash-XXXXXX)"
JAR="$WORK/cookies.txt"
SHOTS=0
[ "${1:-}" = "--screenshots" ] && SHOTS=1
SHOTS_DIR="${SHOTS_DIR:-$ROOT/dashboard-shots}"
CODE="dash-pc-$(date +%H%M%S)"
PENDING="dash-pending-$(date +%H%M%S)"
WRANGLER_PID=""
HEART_PID=""

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mok\033[0m  %s\n' "$*"; }
fail() { printf '   \033[31mFAIL\033[0m %s\n' "$*" >&2; [ -f "$WORK/wrangler.log" ] && tail -n 25 "$WORK/wrangler.log" >&2; exit 1; }
cleanup() {
  [ -n "$HEART_PID" ] && kill "$HEART_PID" 2>/dev/null || true
  if [ -n "$WRANGLER_PID" ]; then kill "$WRANGLER_PID" 2>/dev/null || true; wait "$WRANGLER_PID" 2>/dev/null || true; fi
  pkill -f "wrangler.*--port $PORT" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
command -v jq >/dev/null || fail "jq is required"

say "1/5  boot a private Worker on :$PORT (dev auth, fresh state)"
printf 'AUTH_MODE=dev\nSESSION_SECRET=%s\n' "$(head -c 32 /dev/urandom | base64 | tr -d '=+/')" > "$WORK/dash.vars"
( cd "$WORKER_DIR" && npx wrangler d1 migrations apply hafezi-members --local --persist-to "$WORK/state" ) \
  > "$WORK/migrate.log" 2>&1 || { cat "$WORK/migrate.log" >&2; fail "D1 migrations did not apply"; }
( cd "$WORKER_DIR" && exec npx wrangler dev --port "$PORT" --persist-to "$WORK/state" \
    --env-file "$WORK/dash.vars" --show-interactive-dev-session=false ) > "$WORK/wrangler.log" 2>&1 &
WRANGLER_PID=$!
for _ in $(seq 1 90); do
  curl -sf "$URL/api/health" >/dev/null 2>&1 && break
  kill -0 "$WRANGLER_PID" 2>/dev/null || fail "wrangler dev exited early"
  sleep 1
done
curl -sf "$URL/api/health" >/dev/null || fail "Worker never became healthy"
ok "Worker healthy at $URL"

say "2/5  sign in (dev auth) and create two devices"
curl -sf -c "$JAR" -o /dev/null "$URL/auth/login?next=/" || fail "dev login failed"
CSRF="$(curl -sf -b "$JAR" "$URL/api/session" | jq -r .csrf)"
[ -n "$CSRF" ] && [ "$CSRF" != null ] || fail "no CSRF token (is AUTH_MODE=dev in effect?)"
member_post() { curl -sf -b "$JAR" -H "origin: $URL" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' -d "$2" "$URL$1"; }
TOKEN="$(member_post /api/devices "{\"code_name\":\"$CODE\"}" | jq -r .enrollment_token)"
[ -n "$TOKEN" ] && [ "$TOKEN" != null ] || fail "POST /api/devices returned no token"
member_post /api/devices "{\"code_name\":\"$PENDING\"}" >/dev/null || fail "could not create $PENDING"
ok "devices $CODE and $PENDING created"

say "3/5  simulate an agent: enroll -> declare -> heartbeat -> readings + log"
agent_post() { curl -sf -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d "$2" "$URL/api/agent/$1"; }
KEY="$(curl -sf -H 'content-type: application/json' \
  -d "{\"enrollment_token\":\"$TOKEN\",\"hostname\":\"DASH-PC\",\"platform\":\"windows-x64\",\"agent_version\":\"0.0.0-verify\"}" \
  "$URL/api/agent/enroll" | jq -r .device_key)"
[ -n "$KEY" ] && [ "$KEY" != null ] || fail "enroll returned no device key"
agent_post instruments '[{"local_id":"sim-1","title":"Simulated SMU","model":"Keithley2450","driver":"simulated","address_kind":"null","capabilities":["readable"],"metrics":["voltage_v","current_a"],"ports":[{"id":"force_hi","label":"Force HI","direction":"source"}]}]' >/dev/null \
  || fail "instrument declaration rejected"
ns() { printf '%s000000' "$(date +%s%3N)"; }
beat() {
  agent_post heartbeat "{\"ts_ns\":\"$(ns)\",\"statuses\":{\"sim-1\":\"online\"}}" >/dev/null
  local v i
  v="$(awk -v s="$RANDOM" 'BEGIN{srand(s); printf "%.4f", 19.5 + rand()}')"
  i="$(awk -v s="$RANDOM" 'BEGIN{srand(s); printf "%.4f", 24 + rand()}')"
  agent_post readings "[{\"local_id\":\"sim-1\",\"metric\":\"voltage_v\",\"value\":$v,\"units\":\"V\",\"ts_ns\":\"$(ns)\"},{\"local_id\":\"sim-1\",\"metric\":\"current_a\",\"value\":$i,\"units\":\"mA\",\"ts_ns\":\"$(ns)\"}]" >/dev/null
}
beat || fail "heartbeat/readings rejected"
agent_post logs "[{\"level\":\"info\",\"message\":\"verify-dashboard: declared 1 instrument(s)\",\"ts_ns\":\"$(ns)\"}]" >/dev/null || fail "logs rejected"
ok "agent enrolled (key held), sim-1 declared, heartbeat + readings + log sent"

say "4/5  assert server-side liveness and the live stream"
api() { curl -sf -b "$JAR" "$URL$1"; }
DEVICES="$(api /api/devices)"
ROW="$(jq --arg c "$CODE" '.[] | select(.code_name == $c)' <<<"$DEVICES")"
[ "$(jq -r .liveness <<<"$ROW")" = online ] || fail "device is not online: $ROW"
[ "$(jq -r .instruments_online <<<"$ROW")" = 1 ] || fail "instruments_online != 1: $ROW"
[ "$(jq -r '.last_seen_age_ms < 10000' <<<"$ROW")" = true ] || fail "heartbeat age too large: $ROW"
ok "$CODE: liveness=online, instruments_online=1, heartbeat $(jq -r .last_seen_age_ms <<<"$ROW") ms ago"
[ "$(jq -r --arg c "$PENDING" '.[] | select(.code_name == $c) | .liveness' <<<"$DEVICES")" = pending ] || fail "$PENDING is not pending"
ok "$PENDING: liveness=pending"
[ "$(api "/api/devices/$CODE/instruments" | jq -r '.[0].effective_status')" = online ] || fail "effective_status is not online"
ok "sim-1 effective_status=online"
curl -s -N --max-time 3 -b "$JAR" "$URL/api/devices/$CODE/stream" > "$WORK/stream.txt" || true
grep -q '^event: hello' "$WORK/stream.txt" || fail "no hello frame on the SSE stream"
grep '^data:' "$WORK/stream.txt" | head -n 1 | sed 's/^data: //' | jq -e '.readings | any(.metric == "voltage_v")' >/dev/null \
  || fail "the hello frame does not carry the reading"
ok "SSE hello frame backfills the voltage_v reading"
member_post "/api/devices/$CODE/commands" '{"kind":"poll","args":{"local_id":"sim-1"}}' | jq -e '.id' >/dev/null || fail "poll command rejected"
[ "$(api "/api/devices/$CODE/commands" | jq -r '.[0].status')" = queued ] || fail "the poll command is not in the audit log"
ok "poll command queued (no agent socket) and visible to the Activity tab"

if [ "$SHOTS" = 1 ]; then
  say "5/5  screenshots of every tab and layout -> $SHOTS_DIR"
  curl -sf -o /dev/null "$URL/devices" -b "$JAR" || fail "/devices is not served — run 'npm run build:members' first"
  ( while true; do beat || true; sleep 3; done ) & HEART_PID=$!
  sleep 4
  mkdir -p "$SHOTS_DIR"
  node "$ROOT/tools/dashboard-screenshots.mjs" "$URL" "$CODE" "$SHOTS_DIR" || fail "screenshot run failed"
  ok "$(ls "$SHOTS_DIR" | wc -l) screenshots written"
else
  say "5/5  screenshots skipped (pass --screenshots)"
fi

printf '\n\033[1;32mDASHBOARD VERIFIED\033[0m — liveness, instruments, stream and commands behave end to end.\n'
