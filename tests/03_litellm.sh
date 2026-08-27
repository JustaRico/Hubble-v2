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
# Bounded retry for LLM non-determinism (occasional empty content under load)
A_CONTENT=""
for attempt in 1 2 3; do
  OUT="$(chat assistant-model "What is 2+3? Answer with just the number." 300)" \
    || { echo "  attempt $attempt: HTTP failure, retrying..."; sleep 3; continue; }
  "${JQ[@]}" -e '.choices[0].message.content' "$OUT" >/dev/null 2>&1 || { sleep 3; continue; }
  A_CONTENT="$("${JQ[@]}" -r '.choices[0].message.content' "$OUT" | tr -d '[:space:]')"
  [ -n "$A_CONTENT" ] && echo "$A_CONTENT" | grep -q "5" && break
  A_CONTENT=""
  echo "  attempt $attempt: empty/incorrect content, retrying..."
  sleep 3
done
[ -n "$A_CONTENT" ] || fail "assistant-model failed after 3 attempts"
pass "assistant-model answered correctly ($A_CONTENT)"

echo "-- (b) pi-model via llama-swap --"
P_CONTENT=""
for attempt in 1 2 3; do
  OUT="$(chat pi-model "What is 6 multiplied by 7? Answer with just the number." 400)" \
    || { echo "  attempt $attempt: HTTP failure, retrying..."; sleep 3; continue; }
  "${JQ[@]}" -e '.choices[0].message.content' "$OUT" >/dev/null 2>&1 || { sleep 3; continue; }
  P_CONTENT="$("${JQ[@]}" -r '.choices[0].message.content' "$OUT" | tr -d '[:space:]')"
  [ -n "$P_CONTENT" ] && echo "$P_CONTENT" | grep -q "42" && break
  P_CONTENT=""
  echo "  attempt $attempt: empty/incorrect content, retrying..."
  sleep 3
done
[ -n "$P_CONTENT" ] || fail "pi-model failed after 3 attempts"
pass "pi-model answered correctly ($P_CONTENT)"

echo "-- (c) gateway audit log shows both calls --"
LOGS="$(docker logs hubble-litellm --since 10m 2>&1)"
# LiteLLM's uvicorn access log records each POST; verbose per-model lines are
# not emitted at default verbosity, so assert on the completions endpoint.
CALLS="$(echo "$LOGS" | grep -c 'POST /v1/chat/completions')"
[ "$CALLS" -ge 2 ] || fail "expected >=2 completion calls in gateway logs, got $CALLS"
pass "gateway logged both calls ($CALLS completions)"

echo "-- (d) regression: phases 1-2 --"
bash "$(dirname "$0")/01_dmz.sh" || fail "regression: 01_dmz.sh"
bash "$(dirname "$0")/02_llama_swap.sh" || fail "regression: 02_llama_swap.sh"

pass "Phase 3 complete"
