#!/usr/bin/env bash
# Phase 7 — Assistant Agent plugin.
# (a) the request_private_data tool is registered in the DSH agent catalog
# (b) calling it returns structured JSON (status unavailable while the
#     Phase 8 escalation service is not running) instead of throwing
# (c) regression: re-run 01-06

source "$(dirname "$0")/lib/common.sh"

source "$HUBBLE_ROOT/.env"

echo "-- (a) tool registered in the agent catalog --"
TOOLLIST="$(docker exec hubble-dsh sh -c 'timeout 120 node /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless "List every tool name available to you that contains the word private. Names only, nothing else." 2>/dev/null')"
echo "$TOOLLIST" | grep -q "request_private_data" || fail "request_private_data not in agent tool list: $TOOLLIST"
pass "request_private_data registered"

echo "-- (b) tool call returns structured JSON --"
# Retry a few times: the cloud model occasionally emits DSML/JSON diffs or
# claims it lacks the tool; the contract under test is that the tool executes
# and its structured status surfaces in the reply.
ANSWER=""
for i in 1 2 3 4; do
  ANSWER="$(docker exec hubble-dsh sh -c 'timeout 150 node /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless "Use the request_private_data tool now: reason \"phase7 test\", data_requested \"calendar\". Then print the exact JSON status object the tool returned." 2>/dev/null')"
  if printf '%s' "$ANSWER" | grep -qiE '"status"'; then break; fi
  echo "  attempt $i: no status field, retrying..."
  sleep 3
done
# The model may print the tool-result JSON directly or inside a fenced block;
# strip fences before asserting on the status field.
STRIPPED="$(printf '%s' "$ANSWER" | sed 's/```json//g; s/```//g')"
echo "$STRIPPED" | grep -qiE '"status"' || fail "tool call did not return structured status: $ANSWER"
pass "tool returned structured result: $(echo "$STRIPPED" | grep -oE '"status"[^,}]*' | head -1)"

echo "-- (c) regression: phases 01-06 --"
FAIL_LOG="$TEMP_DIR/regression-07-last-failure.txt"
: > "$FAIL_LOG"
for t in 01_dmz.sh 02_llama_swap.sh 03_litellm.sh 04_aux_services.sh 05_wake_gateway.sh 06_dsh_boot.sh; do
  LOG="$TEMP_DIR/regression-07-$t.log"
  if ! bash "$(dirname "$0")/$t" > "$LOG" 2>&1; then
    { echo "== nested regression failed in $t (from tests/07_assistant_plugin.sh) ==";
      tail -n 25 "$LOG"; } > "$FAIL_LOG" 2>&1
    fail "regression: $t failed; details:
$(cat "$FAIL_LOG")"
  fi
done
pass "regression 01-06 green"

pass "Phase 7 complete"
