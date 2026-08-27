#!/usr/bin/env bash
# Phase 11 -- Research Bureau live test.
# Real end-to-end run: SearXNG search + LiteLLM research-model rounds + DMZ artifact.
#  (a) health
#  (b) real question -> bounded multi-round loop -> status complete or max_rounds
#      with a substantive report artifact in the DMZ citing >=1 real source URL
# (c) regression: core infra quick check via 01+03

source "$(dirname "$0")/lib/common.sh"
source "$HUBBLE_ROOT/.env"

RB="http://localhost:${HUBBLE_RESEARCH_PORT:-8814}"

echo "-- (a) service healthy --"
wait_for "$RB/health" 30 || fail "research bureau did not come up on $RB"
pass "research bureau healthy"

echo "-- (b) real question end-to-end --"
TASK_ID="$(curl -s --max-time 15 -X POST "$RB/research" -H "Content-Type: application/json" \
  -d '{"question":"What space telescope succeeded Hubble as NASAs flagship observatory?"}' \
  | "${JQ[@]}" -r '.taskId')"
[ -n "$TASK_ID" ] && [ "$TASK_ID" != "null" ] || fail "no taskId"
pass "task accepted: $TASK_ID"

STATUS=""
for i in $(seq 1 20); do
  sleep 12
  STATUS="$("${JQ[@]}" -r '.status' <<<"$(curl -s --max-time 10 "$RB/research/$TASK_ID")")"
  echo "  poll $i: $STATUS"
  case "$STATUS" in done|failed|cancelled) break;; esac
done
[ "$STATUS" = "done" ] || fail "run ended as $STATUS"

RESULT_FILE="$TEMP_DIR/research-result.json"
curl -s --max-time 15 "$RB/research/$TASK_ID/result" -o "$RESULT_FILE"
"${JQ[@]}" -e '.status == "complete" or .status == "max_rounds"' "$RESULT_FILE" >/dev/null || fail "bad result status: $(head -c 300 "$RESULT_FILE")"
ROUNDS="$("${JQ[@]}" -r '.rounds_used' "$RESULT_FILE")"
[ "${ROUNDS:-0}" -ge 1 ] && [ "$ROUNDS" -le "${HUBBLE_RESEARCH_MAX_ROUNDS:-6}" ] || fail "rounds_used out of bounds: $ROUNDS"
pass "bounded run finished in $ROUNDS round(s)"

ARTIFACT="$("${JQ[@]}" -r '.artifact' "$RESULT_FILE")"
[[ "$ARTIFACT" == /dmz/research/*report.md ]] || fail "bad artifact path: $ARTIFACT"
# host-side copyparty URL keeps the /dmz segment (same mapping as Phase 10)
REL="$ARTIFACT"   # already /dmz/... on the host too
DMZ_CODE="$(http_code "http://localhost:${DMZ_PORT:-13923}$REL" -u "hubble:${DMZ_PASS}")"
[ "$DMZ_CODE" = "200" ] || fail "report not downloadable from DMZ ($DMZ_CODE)"

# report must cite sources and contain the expected fact
curl -s --max-time 15 "http://localhost:${DMZ_PORT:-13923}$REL" -u "hubble:${DMZ_PASS}" -o "$TEMP_DIR/report-body.md"
REPORT_SRC_COUNT="$("${JQ[@]}" '[.sources[]] | length' "$RESULT_FILE")"
[ "${REPORT_SRC_COUNT:-0}" -ge 1 ] || fail "no sources recorded"
grep -qiE "james webb|JWST" "$TEMP_DIR/report-body.md" || fail "report body lacks expected fact (JWST)"
pass "report in DMZ (HTTP $DMZ_CODE), cites sources ($REPORT_SRC_COUNT), contains expected fact"

echo "-- (c) regression: core infra --"
bash "$(dirname "$0")/01_dmz.sh" > "$TEMP_DIR/regression-11-01.log" 2>&1 || { tail -n 20 "$TEMP_DIR/regression-11-01.log"; fail "regression: 01_dmz.sh"; }
bash "$(dirname "$0")/03_litellm.sh" > "$TEMP_DIR/regression-11-03.log" 2>&1 || { tail -n 20 "$TEMP_DIR/regression-11-03.log"; fail "regression: 03_litellm.sh"; }
pass "regression 01+03 green"

pass "Phase 11 complete"
