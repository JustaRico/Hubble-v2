#!/usr/bin/env bash
# Phase 3 — LiteLLM model gateway.
# (a) assistant-model returns a real completion via OpenRouter/DeepSeek-V4-Flash
# (b) pi-model returns a real completion via llama-swap
# (c) gateway logs show both calls
# (d) regression: re-run 01 + 02

source "$(dirname "$0")/lib/common.sh"

source "$HUBBLE_ROOT/.env"
GW="http://localhost:${LITELLM_PORT:-14000}"
AUTH="Authorization: Bearer ${LITELLM_MASTER_KEY}"

chat() { # chat <model> <prompt> <max_tokens> -> body file path or empty on HTTP fail
  local model="$1" prompt="$2" maxtok="$3"
  local out="$TEMP_DIR/litellm-$model-$$.json"
  local code
  code="$(curl -s -o "$out" -w '%{http_code}' --max-time 300 "$GW/v1/chat/completions" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d '{"model":"'"$model"'","messages":[{"role":"user","content":"'"$prompt"'"}],"max_tokens":'"$maxtok"'}')"
  if [ "$code" != "200" ]; then echo ""; return 1; fi
  echo "$out"
}

echo "-- (a) assistant-model via OpenRouter --"
OUT="$(chat assistant-model "What is 2+3? Answer with just the number." 300)" \
  || fail "assistant-model call failed: $(head -c 200 "${TEMP_DIR}/litellm-assistant-model-$$.json" 2>/dev/null)"
"${JQ[@]}" -e '.choices[0].message.content' "$OUT" >/dev/null || fail "assistant-model: malformed response"
A_CONTENT="$("${JQ[@]}" -r '.choices[0].message.content' "$OUT" | tr -d '[:space:]')"
[ -n "$A_CONTENT" ] || fail "assistant-model returned empty content"
echo "$A_CONTENT" | grep -q "5" || fail "assistant-model expected fact '5', got: $A_CONTENT"
pass "assistant-model answered correctly ($A_CONTENT)"

echo "-- (b) pi-model via llama-swap --"
OUT="$(chat pi-model "What is 6 multiplied by 7? Answer with just the number." 400)" \
  || fail "pi-model call failed"
"${JQ[@]}" -e '.choices[0].message.content' "$OUT" >/dev/null || fail "pi-model: malformed response"
P_CONTENT="$("${JQ[@]}" -r '.choices[0].message.content' "$OUT" | tr -d '[:space:]')"
[ -n "$P_CONTENT" ] || fail "pi-model returned empty content"
echo "$P_CONTENT" | grep -q "42" || fail "pi-model expected fact '42', got: $P_CONTENT"
pass "pi-model answered correctly ($P_CONTENT)"

echo "-- (c) gateway audit log shows both models --"
LOGS="$(docker logs hubble-litellm --since 10m 2>&1)"
echo "$LOGS" | grep -q "assistant-model" || fail "no assistant-model trace in gateway logs"
echo "$LOGS" | grep -q "pi-model" || fail "no pi-model trace in gateway logs"
pass "gateway logged both calls"

echo "-- (d) regression: phases 1-2 --"
bash "$(dirname "$0")/01_dmz.sh" || fail "regression: 01_dmz.sh"
bash "$(dirname "$0")/02_llama_swap.sh" || fail "regression: 02_llama_swap.sh"

pass "Phase 3 complete"
