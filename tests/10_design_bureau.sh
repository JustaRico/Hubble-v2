#!/usr/bin/env bash
# Phase 10 -- Design Bureau live test.
# Drives the real service on :8813 end-to-end (LiteLLM + copyparty DMZ):
#  (i)  health
#  (ii) full run: skipPlanner mode, both branches -> both DMZ artifacts exist
#       and synthesis status=complete referencing both paths
# (iii) regression: re-run the whole accumulated suite via the runner's own
#       ordering is done by npm test; here we re-run core 01+03 quickly.

source "$(dirname "$0")/lib/common.sh"

source "$HUBBLE_ROOT/.env"
BUREAU="http://localhost:${HUBBLE_DESIGN_BUREAU_PORT:-8813}"

echo "-- (i) bureau service healthy --"
wait_for "$BUREAU/health" 30 || fail "design bureau did not come up on $BUREAU"
pass "bureau healthy"

echo "-- (ii) full two-branch run against LiteLLM + DMZ --"
curl -s -X POST "$BUREAU/_test/set-controls" -H "Content-Type: application/json" \
  -d '{"skipPlanner": true}' >/dev/null || fail "set-controls failed"
TASK_ID="$(curl -s -X POST "$BUREAU/design" -H "Content-Type: application/json" \
  -d '{"task":"Build a GPU temperature widget with a refresh button"}' \
  | "${JQ[@]}" -r '.taskId')"
[ -n "$TASK_ID" ] && [ "$TASK_ID" != "null" ] || fail "no taskId returned"
pass "task accepted: $TASK_ID"

STATUS=""
for i in $(seq 1 25); do
  sleep 10
  STATUS="$("${JQ[@]}" -r '.status' <<<"$(curl -s --max-time 10 "$BUREAU/design/$TASK_ID")")"
  echo "  poll $i: $STATUS"
  case "$STATUS" in done|failed|cancelled) break;; esac
done
[ "$STATUS" = "done" ] || fail "run ended as $STATUS"

RESULT_FILE="$TEMP_DIR/bureau-result.json"
curl -s --max-time 15 "$BUREAU/design/$TASK_ID/result" -o "$RESULT_FILE"
"${JQ[@]}" -e '.status == "complete"' "$RESULT_FILE" >/dev/null || fail "expected complete, got $(head -c 300 "$RESULT_FILE")"

DESIGNER_PATH="$("${JQ[@]}" -r '.artifacts.designer' "$RESULT_FILE")"
CODER_PATH="$("${JQ[@]}" -r '.artifacts.coder' "$RESULT_FILE")"
[[ "$DESIGNER_PATH" == /dmz/bureau/*designer.md ]] || fail "bad designer path: $DESIGNER_PATH"
[[ "$CODER_PATH" == /dmz/bureau/*coder.js ]] || fail "bad coder path: $CODER_PATH"

# Host-side copyparty maps URL /dmz/* -> data/dmz/* (the compose volume mounts
# ./data/dmz at /mnt/storage/shared-dmz and the share is published AT /dmz).
# The bureau's artifact paths are /dmz/bureau/..., so the host GET keeps that
# same /dmz prefix — strip only the scheme+host portion.
REL_DES="${DESIGNER_PATH#/dmz/}"   # bureau/<taskId>/designer.md
REL_COD="${CODER_PATH#/dmz/}"
DES_CODE="$(http_code "http://localhost:${DMZ_PORT:-13923}/dmz/$REL_DES" -u "hubble:${DMZ_PASS}")"
COD_CODE="$(http_code "http://localhost:${DMZ_PORT:-13923}/dmz/$REL_COD" -u "hubble:${DMZ_PASS}")"
[ "$DES_CODE" = "200" ] || fail "designer artifact not downloadable ($DES_CODE)"
[ "$COD_CODE" = "200" ] || fail "coder artifact not downloadable ($COD_CODE)"
pass "both artifacts in DMZ and downloadable (designer=$DES_CODE coder=$COD_CODE)"

echo "-- (iii) quick regression: core infra still green --"
bash "$(dirname "$0")/01_dmz.sh" > "$TEMP_DIR/regression-10-01.log" 2>&1 || { tail -n 20 "$TEMP_DIR/regression-10-01.log"; fail "regression: 01_dmz.sh"; }
bash "$(dirname "$0")/03_litellm.sh" > "$TEMP_DIR/regression-10-03.log" 2>&1 || { tail -n 20 "$TEMP_DIR/regression-10-03.log"; fail "regression: 03_litellm.sh"; }
pass "regression 01+03 green"

pass "Phase 10 complete"
