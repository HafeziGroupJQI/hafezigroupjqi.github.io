#!/usr/bin/env bash
# End-to-end check of the one-domain members site: the public build served like GitHub Pages on
# :8080, the members API (wrangler dev, dev auth, the member edition as assets) on :8787, a fake
# lab PC feeding the device API, and headless Chromium signing in and walking the member pages.
#
# Usage: tools/verify-members.sh [--build]
#   --build  first builds both editions into .cache/e2e-public and .cache/e2e-private (≈5 min).
#            Without it, those must exist; the three members bundles are re-pointed at the local
#            API either way (tools/members-bundles.mjs), so any build of the editions will do.
# Env:     PAGES_PORT (8086), API_PORT (8796)
# Env:     GITHUB_DOCS_TOKEN (optional; defaults to ~/.config/hafezi/vault-private-read.token)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Own ports, so a wrangler dev you already run on :8787 is left alone.
PAGES_PORT="${PAGES_PORT:-8086}" API_PORT="${API_PORT:-8796}"
PAGES="http://localhost:$PAGES_PORT" API="http://localhost:$API_PORT"
PUBLIC_DIR="$ROOT/.cache/e2e-public" PRIVATE_DIR="$ROOT/.cache/e2e-private"
SHOTS="$ROOT/dashboard-shots"
WORK="$(mktemp -d -t hafezi-members-XXXXXX)"
CODE="e2e-pc-$(date +%H%M%S)"
PIDS=()

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mok\033[0m  %s\n' "$*"; }
fail() { printf '   \033[31mFAIL\033[0m %s\n' "$*" >&2; [ -f "$WORK/wrangler.log" ] && tail -n 25 "$WORK/wrangler.log" >&2; exit 1; }
cleanup() { for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done; rm -rf "$WORK"; }
trap cleanup EXIT
command -v jq >/dev/null || fail "jq is required"
for port in $PAGES_PORT $API_PORT; do
  curl -s -o /dev/null "http://localhost:$port" && fail "port $port is already in use"
done

if [ "${1:-}" = "--build" ]; then
  say "0/4  build both editions against the local API"
  ( cd "$ROOT" && MEMBERS_API_ORIGIN="$API" MEMBERS_BASE_URL="$PAGES" \
      MEMBERS_PUBLIC_SITE_PATH=.cache/e2e-public MEMBERS_SITE_PATH=.cache/e2e-private npm run build:unified ) \
    > "$WORK/build.log" 2>&1 || { tail -n 30 "$WORK/build.log" >&2; fail "build failed"; }
fi
[ -f "$PUBLIC_DIR/sw.js" ] && [ -d "$PRIVATE_DIR/resources" ] || fail "run with --build first"
( cd "$ROOT" && node tools/members-bundles.mjs "$API" "$PUBLIC_DIR" "$PRIVATE_DIR" ) || fail "could not re-point the bundles"
grep -q "localhost:$API_PORT" "$PUBLIC_DIR/sw.js" || fail "the public build does not point at $API"

say "1/4  start the Pages stand-in and the members API"
DOCS_TOKEN="${GITHUB_DOCS_TOKEN:-$(cat ~/.config/hafezi/vault-private-read.token 2>/dev/null || true)}"
{ printf 'AUTH_MODE=dev\nSESSION_SECRET=%s\nALLOWED_ORIGINS=%s\n' "$(head -c 32 /dev/urandom | base64 | tr -d '=+/')" "$PAGES"
  [ -n "$DOCS_TOKEN" ] && printf 'GITHUB_DOCS_TOKEN=%s\n' "$DOCS_TOKEN"; } > "$WORK/dev.vars"
( cd "$ROOT/worker" && npx wrangler d1 migrations apply hafezi-members --local --persist-to "$WORK/state" ) \
  > "$WORK/migrate.log" 2>&1 || { cat "$WORK/migrate.log" >&2; fail "D1 migrations did not apply"; }
( cd "$ROOT/worker" && exec npx wrangler dev --port "$API_PORT" --persist-to "$WORK/state" --assets "$PRIVATE_DIR" \
    --env-file "$WORK/dev.vars" --show-interactive-dev-session=false ) > "$WORK/wrangler.log" 2>&1 &
PIDS+=($!)
node "$ROOT/tools/serve-pages.mjs" "$PUBLIC_DIR" "$PAGES_PORT" > "$WORK/pages.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 90); do curl -sf "$API/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "$API/api/health" >/dev/null || fail "the members API never became healthy"
curl -sf -o /dev/null "$PAGES/" || fail "the Pages stand-in is not serving"
ok "Pages stand-in at $PAGES, members API at $API"

say "2/4  a fake lab PC: create, enrol, declare, heartbeat"
START="$(curl -sf -H 'content-type: application/json' -d '{"next":"/"}' "$API/api/auth/start")"
TOKEN="$(curl -sf -H 'content-type: application/json' -d "$START" "$API/api/auth/exchange" | jq -r .token)"
[ -n "$TOKEN" ] && [ "$TOKEN" != null ] || fail "dev sign-in returned no token"
member() { curl -sf -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$@"; }
ENROL="$(member -d "{\"code_name\":\"$CODE\"}" "$API/api/devices" | jq -r .enrollment_token)"
KEY="$(curl -sf -H 'content-type: application/json' -d "{\"enrollment_token\":\"$ENROL\",\"hostname\":\"E2E-PC\",\"platform\":\"windows-x64\",\"agent_version\":\"0.0.0-e2e\"}" "$API/api/agent/enroll" | jq -r .device_key)"
[ -n "$KEY" ] && [ "$KEY" != null ] || fail "enrolment returned no device key"
agent() { curl -sf -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d "$2" "$API/api/agent/$1" >/dev/null; }
agent instruments '[{"local_id":"sim-1","title":"Simulated SMU","model":"Keithley2450","driver":"simulated","address_kind":"null","capabilities":["readable"],"metrics":["voltage_v"],"ports":[]}]' || fail "declare rejected"
ns() { printf '%s000000' "$(date +%s%3N)"; }
( while true; do
    agent heartbeat "{\"ts_ns\":\"$(ns)\",\"statuses\":{\"sim-1\":\"online\"}}" || true
    agent readings "[{\"local_id\":\"sim-1\",\"metric\":\"voltage_v\",\"value\":$((RANDOM % 100))e-1,\"units\":\"V\",\"ts_ns\":\"$(ns)\"}]" || true
    sleep 2
  done ) &
PIDS+=($!)
sleep 3
[ "$(member "$API/api/devices" | jq -r --arg c "$CODE" '.[]|select(.code_name==$c)|.liveness')" = online ] || fail "the fake lab PC is not online"
ok "$CODE online and streaming"

say "3/4  the API is not a website"
LOC="$(curl -s -o /dev/null -w '%{redirect_url}' "$API/resources/")"
[ "$LOC" = "https://hafezigroupjqi.github.io/resources/" ] || fail "non-API path did not redirect to the site: $LOC"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/site/resources/")" = 401 ] || fail "/api/site is not gated"
ok "non-API paths redirect to github.io; /api/site needs a token"

say "4/4  a browser signs in at $PAGES and walks the member pages"
mkdir -p "$SHOTS"
node "$ROOT/tools/members-e2e.mjs" "$PAGES" "$API" "$CODE" "$PRIVATE_DIR" "$SHOTS" || fail "browser walk failed"

printf '\n\033[1;32mMEMBERS SITE VERIFIED\033[0m — one domain, private pages only after sign-in, the API never visited.\n'
