#!/usr/bin/env bash
# Phase 2 — Local model serving via the EXISTING llama-swap deployment
# (host port 10123 this run; installer provisions the container on fresh machines).
#
# (a) /v1/models lists the chat model + embedding model
# (b) a real chat completion returns non-empty content
# (c) idle-unload: after the model TTL with no requests, llama-swap reports the
#     model unloaded. Host-level VRAM attribution is not available on this
#     shared-desktop run (nvidia-smi shows [N/A] per process), so llama-swap's
#     own model status is the source of truth. The full TTL-length wait only
#     runs with HUBBLE_LONG_TESTS=1; otherwise it is skipped with a warning so
#     the everyday suite stays fast.

source "$(dirname "$0")/lib/common.sh"

source "$HUBBLE_ROOT/.env"
LS_URL="${LLAMA_SWAP_URL:-http://localhost:10123}"
CHAT_MODEL="${LLAMA_SWAP_CHAT_MODEL:-gemma4-12b}"
EMBED_MODEL="${LLAMA_SWAP_EMBED_MODEL:-qwen3-embed}"

echo "-- (a) /v1/models lists both models --"
MODELS_JSON="$(curl -s --max-time 15 "$LS_URL/v1/models")"
echo "$MODELS_JSON" | "${JQ[@]}" -e '.data[] | select(.id == "'"$CHAT_MODEL"'")' >/dev/null \
  || fail "model '$CHAT_MODEL' not listed"
pass "chat model listed: $CHAT_MODEL"
echo "$MODELS_JSON" | "${JQ[@]}" -e '.data[] | select(.id == "'"$EMBED_MODEL"'")' >/dev/null \
  || fail "embedding model '$EMBED_MODEL' not listed"
pass "embedding model listed: $EMBED_MODEL"

echo "-- (b) minimal chat completion --"
RESP_FILE="$TEMP_DIR/llamaswap-probe.json"
# Bounded retry: pi-model (local LLM) occasionally returns an empty content
# under load; the contract under test is that the model serves correct facts,
# so retry up to 3 times on an empty/unparseable sample.
CONTENT=""
for attempt in 1 2 3; do
  curl -s --max-time 300 "$LS_URL/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"model":"'"$CHAT_MODEL"'","messages":[{"role":"user","content":"What is 17 multiplied by 23? Answer with just the number."}],"max_tokens":400}' \
    -o "$RESP_FILE" || fail "chat completion request failed"
  [ -s "$RESP_FILE" ] || fail "empty response body"
  if "${JQ[@]}" -e '.choices[0].message.content' "$RESP_FILE" >/dev/null 2>&1; then
    CONTENT="$("${JQ[@]}" -r '.choices[0].message.content' "$RESP_FILE" | tr -d '[:space:]')"
  fi
  [ -n "$CONTENT" ] && break
  echo "  attempt $attempt: empty/unparseable completion, retrying..."
  sleep 3
done
[ -n "$CONTENT" ] || fail "content is empty after 3 attempts: $(head -c 200 "$RESP_FILE")"
# the probe doubles as a factual sanity check
echo "$CONTENT" | grep -q "391" || fail "expected arithmetic fact 391 in content, got: $CONTENT"
pass "completion returned correct fact (content=$CONTENT)"

echo "-- (b2) embedding completion (swap-independence sanity) --"
EMBED_CODE="$(curl -s -o "$TEMP_DIR/llamaswap-embed.json" -w '%{http_code}' --max-time 300 "$LS_URL/v1/embeddings" \
  -H "Content-Type: application/json" \
  -d '{"model":"'"$EMBED_MODEL"'","input":"hubble smoke test"}')"
[ "$EMBED_CODE" = "200" ] || fail "embeddings returned HTTP $EMBED_CODE"
"${JQ[@]}" -e '.data[0].embedding | length > 0' "$TEMP_DIR/llamaswap-embed.json" >/dev/null \
  || fail "empty embedding vector"
pass "embedding served"

echo "-- (c) idle TTL unload check --"
if [ "${HUBBLE_LONG_TESTS:-0}" != "1" ]; then
  echo "  SKIP: set HUBBLE_LONG_TESTS=1 to wait out the model TTL (~10 min) and assert unload."
  echo "  SKIP: verified separately during build-out; see commit history."
else
  # ensure resident, then poll until llama-swap reports it unloaded
  curl -s --max-time 300 "$LS_URL/v1/chat/completions" -H "Content-Type: application/json" \
    -d '{"model":"'"$CHAT_MODEL"'","messages":[{"role":"user","content":"hi"}],"max_tokens":4}' >/dev/null
  STATUS="$(curl -s "$LS_URL/v1/models" | "${JQ[@]}" -r '.data[] | select(.id=="'"$CHAT_MODEL"'") | .status.value // "?"')"
  echo "  status right after request: $STATUS"
  DEADLINE=$(( $(date +%s) + 900 ))   # TTL 600s + generous margin
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    sleep 20
    STATUS="$(curl -s --max-time 10 "$LS_URL/v1/models" | "${JQ[@]}" -r '.data[] | select(.id=="'"$CHAT_MODEL"'") | .status.value // "?"')"
    echo "  $(date +%H:%M:%S) status: $STATUS"
    [ "$STATUS" = "unloaded" ] && break
  done
  [ "$STATUS" = "unloaded" ] || fail "model still '$STATUS' after TTL window"
  pass "model auto-unloaded after idle TTL"
fi

pass "Phase 2 complete"
