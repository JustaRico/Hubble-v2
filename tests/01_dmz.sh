#!/usr/bin/env bash
# Phase 1 — Shared DMZ (copyparty).
# Upload a random file, download it back, diff, clean up.

source "$(dirname "$0")/lib/common.sh"

source "$HUBBLE_ROOT/.env"
DMZ_URL="http://localhost:${DMZ_PORT:-13923}"
AUTH="hubble:${DMZ_PASS}"

echo "-- DMZ reachable --"
[ "$(http_code "$DMZ_URL/dmz/" -u "$AUTH")" = "200" ] || fail "DMZ not reachable at $DMZ_URL (auth?)"
pass "DMZ up at $DMZ_URL"

# random test payload
TEST_FILE="$TEMP_DIR/dmz-test-$RANDOM-$$"
DOWN_FILE="${TEST_FILE}.down"
head -c 65536 /dev/urandom > "$TEST_FILE"

cleanup() { rm -f "$TEST_FILE" "$DOWN_FILE"; }
trap cleanup EXIT

echo "-- upload via PUT --"
UP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -u "$AUTH" -T "$TEST_FILE" "$DMZ_URL/dmz/tests/$(basename "$TEST_FILE")")"
[ "$UP_CODE" = "201" ] || [ "$UP_CODE" = "200" ] || [ "$UP_CODE" = "204" ] || fail "upload returned HTTP $UP_CODE"
pass "upload accepted (HTTP $UP_CODE)"

echo "-- download and compare --"
curl -s --max-time 30 -u "$AUTH" -o "$DOWN_FILE" "$DMZ_URL/dmz/tests/$(basename "$TEST_FILE")"
cmp -s "$TEST_FILE" "$DOWN_FILE" || fail "round-trip content mismatch"
pass "downloaded content identical"

echo "-- cleanup remote test artifact --"
DEL_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -u "$AUTH" -X DELETE "$DMZ_URL/dmz/tests/$(basename "$TEST_FILE")")"
if [ "$DEL_CODE" = "200" ] || [ "$DEL_CODE" = "204" ]; then
  pass "remote test file deleted"
else
  echo "  WARN: delete returned HTTP $DEL_CODE — check perms flag on the volume"
fi

pass "Phase 1 complete"
