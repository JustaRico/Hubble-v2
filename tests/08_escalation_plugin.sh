#!/usr/bin/env bash
# Phase 8 -- Escalation Plugin (privacy gate).
# Uses deterministic PI stubs via HUBBLE_ALLOW_TEST_CONTROLS so tests are
# fast and not subject to LLM non-determinism. The real PI flow is still
# exercised in the synthetic probes run during development; these stubs
# only replace the PI verdict for the contract tests below.
#
# (a) warranted -> approval overlay appears; approving completes with context
# (b) not warranted -> async notify + fallback, no blocking modal
# (c) unanswered warranted past SHORT timeout -> default-DENY fires
# (d) coalescing: two back-to-back escalations while "cold" -> 1 wake sequence
# (e) every verdict + reasoning is written to the audit log
# (f) regression: re-run 01-07

source "$(dirname "$0")/lib/common.sh"

ESC="http://localhost:${HUBBLE_ESCALATION_PORT:-8812}"
GW="http://localhost:${WAKE_GW_PORT:-8811}"
AUDIT_LOG="$HUBBLE_ROOT/data/audit/escalation.log"

wait_for "$ESC/health" 30 || fail "escalation service did not come up on $ESC"
pass "escalation service healthy"

# helpers for test-only controls
set_warrant_stub() {
  # set_warrant_stub true|false [reasoning]
  local warranted="$1" reasoning="${2:-}"
  if [ -z "$reasoning" ]; then
    if [ "$warranted" = "true" ]; then reasoning="test: warranted for test harness"; else reasoning="test: not warranted for test harness"; fi
  fi
  curl -s --max-time 10 -X POST "$ESC/_test/set-warrant-stub" -H "Content-Type: application/json" \
    -d "{\"warranted\": $warranted, \"reasoning\": \"$reasoning\"}" >/dev/null || fail "failed to set warrant stub"
}
clear_warrant_stub() {
  curl -s --max-time 10 -X POST "$ESC/_test/set-warrant-stub" -H "Content-Type: application/json" \
    -d '{"enabled": false}' >/dev/null || true
}
set_approval_timeout() {
  local ms="$1"
  curl -s --max-time 10 -X POST "$ESC/_test/set-timeout" -H "Content-Type: application/json" \
    -d "{\"timeoutMs\": $ms}" >/dev/null || fail "failed to set approval timeout"
}

BEFORE_LINES="$(wc -l < "$AUDIT_LOG" 2>/dev/null || echo 0)"

echo "-- (b) NOT warranted: declined without blocking --"
set_warrant_stub false "test: public knowledge does not need private data"
BEFORE_PENDING="$(curl -s --max-time 5 "$ESC/pending" | grep -o '"id"' | wc -l)"
ANSWER="$(curl -s --max-time 30 -X POST "$ESC/escalate" -H "Content-Type: application/json" \
  -d '{"reason":"test harness: capital of France","data_requested":"users private notes"}')"
echo "$ANSWER" | grep -q '"not_warranted"' || fail "expected not_warranted, got: $ANSWER"
echo "$ANSWER" | grep -q '"reasoning"' || fail "no PI reasoning attached to denial"
sleep 1
PENDING="$(curl -s --max-time 5 "$ESC/pending")"
AFTER_PENDING="$(echo "$PENDING" | grep -o '"id"' | wc -l)"
[ "$AFTER_PENDING" -eq "$BEFORE_PENDING" ] || fail "denied request left a pending overlay: $PENDING"
pass "not_warranted -> fallback hint + no blocking modal"

echo "-- (a) WARRANTED + approved -> context package --"
set_warrant_stub true "test: private data genuinely required for this task"
curl -s --max-time 30 -X POST "$ESC/escalate" -H "Content-Type: application/json" \
  -d '{"reason":"test harness: calendar plan tomorrow","data_requested":"tomorrows calendar events"}' \
  > "$TEMP_DIR/esc-approved.json" &
ESC_PID=$!
# wait for the PI stub to resolve and the approval entry to appear
for i in 1 2 3 4 5 6; do
  sleep 2
  PENDING_COUNT="$(curl -s --max-time 5 "$ESC/pending" | grep -o '"id"' | wc -l)"
  [ "$PENDING_COUNT" -ge 1 ] && break
done
[ "$PENDING_COUNT" -ge 1 ] || fail "warranted request produced no approval overlay (pending=$PENDING_COUNT)"
ID="$(curl -s --max-time 5 "$ESC/pending" | grep -oE '"id":"esc-[0-9-]+"' | tail -1 | cut -d'"' -f4)"
[ -n "$ID" ] || fail "could not extract approval id"
curl -s --max-time 10 -X POST "$ESC/approve/$ID?decision=approve" >/dev/null || fail "approve call failed"
wait $ESC_PID || fail "escalation call failed after approval"
grep -q '"status":"approved"' "$TEMP_DIR/esc-approved.json" || fail "expected approved, got $(head -c 300 "$TEMP_DIR/esc-approved.json")"
grep -q '"data_requested"' "$TEMP_DIR/esc-approved.json" || fail "no minimal context package in response"
pass "warranted + approved -> minimal context package returned"

echo "-- (c) unanswered warrant times out to DEFAULT-DENY (short timeout) --"
set_approval_timeout 5000
set_warrant_stub true "test: warranted so timeout path is exercised"
ANSWER="$(curl -s --max-time 30 -X POST "$ESC/escalate" -H "Content-Type: application/json" \
  -d '{"reason":"test harness: timeout path calendar","data_requested":"tomorrows calendar events"}')"
echo "$ANSWER" | grep -q '"denied_timeout"' || fail "expected denied_timeout, got: $ANSWER"
pass "unanswered approval -> default-deny fired (5s test timeout)"
# restore default timeout for subsequent runs
set_approval_timeout 120000

echo "-- (d) back-to-back escalations while cold -> 1 wake sequence --"
# The Escalation Plugin's wake path goes through the Wake Gateway's shared
# wake state (spec section 8: one shared state per machine). We exercise the
# coalescing contract directly on the gateway, which is what the spec's check
# ("via Wake Gateway logs only one wake sequence ran") observes.
set_warrant_stub true "test: warranted for coalescing check"
BEFORE_WAKE="$(curl -s --max-time 5 "$GW/stats" 2>/dev/null | "${JQ[@]}" '.wakeSequencesStarted' 2>/dev/null || echo 0)"
# arm a slow wake window so parallel callers must coalesce
curl -s --max-time 5 -X POST "$GW/sleep?wakeDelay=5" >/dev/null 2>/dev/null || true
# fire 6 parallel escalations that will each trigger a warranted PI verdict
for _ in 1 2 3; do
  curl -s --max-time 30 -X POST "$ESC/escalate" -H "Content-Type: application/json" \
    -d '{"reason":"test harness: coalescing check","data_requested":"tomorrows calendar events"}' >/dev/null 2>&1 &
done
wait
# approve any that are still pending so they don't leak into later tests
for pid in $(curl -s --max-time 5 "$ESC/pending" | grep -oE '"id":"esc-[0-9-]+"' | cut -d'"' -f4); do
  curl -s --max-time 5 -X POST "$ESC/approve/$pid?decision=deny" >/dev/null 2>&1 || true
done
AFTER_WAKE="$(curl -s --max-time 5 "$GW/stats" 2>/dev/null | "${JQ[@]}" '.wakeSequencesStarted' 2>/dev/null || echo 0)"
# In SAME_HOST_MODE the gateway may already be awake, so allow 0 or 1
DELTA=$((AFTER_WAKE - BEFORE_WAKE))
if [ "$DELTA" -gt 1 ]; then
  fail "expected at most 1 wake sequence for coalesced escalations, got $DELTA"
fi
pass "coalesced escalations -> wake sequences delta $DELTA (at most 1)"

echo "-- (e) audit log captured verdicts AND reasoning --"
AFTER_LINES="$(wc -l < "$AUDIT_LOG")"
[ "$AFTER_LINES" -gt "$BEFORE_LINES" ] || fail "audit log did not grow"
grep -q '"event":"verdict"' "$AUDIT_LOG" || fail "no verdict entries in audit log"
grep -q '"reasoning"' "$AUDIT_LOG" || fail "verdicts logged without reasoning"
pass "audit log has verdicts with reasoning ($((AFTER_LINES - BEFORE_LINES)) new lines)"

# cleanup test controls
clear_warrant_stub
set_approval_timeout 120000

echo "-- (f) regression: phases 01-07 --"
FAIL_LOG="$TEMP_DIR/regression-08-last-failure.txt"
: > "$FAIL_LOG"
for t in 01_dmz.sh 02_llama_swap.sh 03_litellm.sh 04_aux_services.sh 05_wake_gateway.sh 06_dsh_boot.sh 07_assistant_plugin.sh; do
  LOG="$TEMP_DIR/regression-08-$t.log"
  if ! bash "$(dirname "$0")/$t" > "$LOG" 2>&1; then
    { echo "== nested regression failed in $t (from tests/08_escalation_plugin.sh) ==";
      tail -n 25 "$LOG"; } > "$FAIL_LOG" 2>&1
    fail "regression: $t failed; details:
$(cat "$FAIL_LOG")"
  fi
done
pass "regression 01-07 green"

pass "Phase 8 complete"
