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
ANSWER="$(docker exec hubble-dsh sh -c 'timeout 150 node /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless "Call the request_private_data tool with reason \"phase7 test\" and data_requested \"calendar\". Reply with ONLY the JSON object it returned." 2>/dev/null')"
echo "$ANSWER" | grep -qiE '"status"' || fail "tool call did not return structured status: $ANSWER"
pass "tool returned structured result: $(echo "$ANSWER" | grep -oE '"status"[^,}]*' | head -1)"

echo "-- (c) regression: phases 01-06 --"
for t in 01_dmz.sh 02_llama_swap.sh 03_litellm.sh 04_aux_services.sh 05_wake_gateway.sh 06_dsh_boot.sh; do
  bash "$(dirname "$0")/$t" > /dev/null 2>&1 || fail "regression: $t failed (run it directly for details)"
done
pass "regression 01-06 green"

pass "Phase 7 complete"
