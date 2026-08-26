#!/usr/bin/env bash
# Phase 6 — DSH instance (containerized).
#
# Topology inside hubble-dsh:  browser -> :3080 Caddy (basic auth) -> dsh web (loopback :3081)
# (a) unauthenticated requests are refused (401), wrong password refused
# (b) authenticated request reaches the DSH Web UI (200 + HTML)
# (c) process persists across spaced probes (restart policy keeps it up)
# (d) composed profile tree carries the Hubble LLM routes from settings.yaml

source "$(dirname "$0")/lib/common.sh"

source "$HUBBLE_ROOT/.env"
PORT="${HUBBLE_DSH_PORT:-3080}"
BASE="http://localhost:${PORT}"
AUTH="hubble:${DSH_PASSWORD:-hubble-dev-pass}"

echo "-- auth gate --"
CODE="$(http_code "$BASE/")"
[ "$CODE" = "401" ] || fail "expected 401 without credentials, got $CODE"
pass "no credentials -> 401"

CODE="$(http_code "$BASE/" -u "hubble:wrong-pass")"
[ "$CODE" = "401" ] || fail "expected 401 for wrong password, got $CODE"
pass "wrong password -> 401"

echo "-- DSH Web UI behind basic auth --"
BODY="$(curl -s --max-time 20 -u "$AUTH" "$BASE/")"
CODE="$(http_code "$BASE/" -u "$AUTH")"
[ "$CODE" = "200" ] || fail "authenticated UI request got $CODE"
echo "$BODY" | grep -q "<!doctype html" || fail "UI did not return HTML"
pass "DSH Web UI serves HTML through the auth gate (200)"

echo "-- persistence across spaced probes --"
for i in 1 2 3; do
  sleep 8
  CODE="$(http_code "$BASE/" -u "$AUTH")"
  [ "$CODE" = "200" ] || fail "probe $i returned $CODE — instance not stable"
done
pass "3/3 spaced authenticated probes OK"

echo "-- model round-trip: headless session answers through configured route --"
ROUNDTRIP="$(docker exec hubble-dsh sh -c 'timeout 120 node /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless "What is 2+3? Answer with just the number." 2>/dev/null' | tail -1)"
echo "$ROUNDTRIP" | grep -q "5" || fail "model round-trip failed, got: $ROUNDTRIP"
pass "headless session answered correctly ($ROUNDTRIP)"

pass "Phase 6 complete"
