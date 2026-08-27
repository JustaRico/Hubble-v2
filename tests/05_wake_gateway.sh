#!/usr/bin/env bash
# Phase 5 — Wake Gateway live tests.
# (a) proxy forwards correctly to all four routes
# (b) concurrency: with a forced "asleep" machine, N parallel requests across
#     routes coalesce into exactly ONE wake sequence (stats assertion)
# (c) SSE streaming: llama-swap stream:true chunks arrive incrementally
# (d) regression: phases 01-04

source "$(dirname "$0")/lib/common.sh"

source "$HUBBLE_ROOT/.env"
GW="http://localhost:${WAKE_GW_PORT:-8811}"

echo "-- gateway up --"
wait_for "$GW/health" 30 || fail "wake gateway did not come up on $GW"
pass "gateway healthy"

echo "-- (a) forwarding to all four routes --"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 "$GW/llama-swap/v1/models")"
[ "$CODE" = "200" ] || fail "llama-swap route HTTP $CODE"
pass "/llama-swap -> models list"

CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "$GW/searxng/search?q=test&format=json")"
[ "$CODE" = "200" ] || fail "searxng route HTTP $CODE"
pass "/searxng -> JSON search"

CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "$GW/firecrawl/v0/health/readiness")"
[ "$CODE" = "200" ] || fail "firecrawl route HTTP $CODE"
pass "/firecrawl -> readiness"

CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "$GW/mcphub/health")"
[ "$CODE" = "200" ] || fail "mcphub route HTTP $CODE"
pass "/mcphub -> health"

CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$GW/nope/nothing")"
[ "$CODE" = "404" ] || fail "unknown route should 404, got $CODE"
pass "unknown route 404"

echo "-- (b) wake coalescing under parallel load --"
# simulate a cold machine with a SLOW boot (5s wake window, the guide's
# "force a slow/failing health check" case); /sleep returns the counter
# atomically so no wake can start between arming sleep and reading baseline.
BEFORE="$(curl -s -X POST "$GW/sleep?wakeDelay=5" | "${JQ[@]}" '.wakeSequencesStarted')"
for i in 1 2 3; do
  curl -s -o /dev/null --max-time 300 "$GW/llama-swap/v1/models" &
  curl -s -o /dev/null --max-time 300 "$GW/searxng/search?q=p$i&format=json" &
  curl -s -o /dev/null --max-time 300 "$GW/firecrawl/v0/health/readiness" &
  curl -s -o /dev/null --max-time 300 "$GW/mcphub/health" &
done
wait
AFTER="$(curl -s "$GW/stats" | "${JQ[@]}" '.wakeSequencesStarted')"
DELTA=$((AFTER - BEFORE))
[ "$DELTA" = "1" ] || fail "expected exactly 1 new wake sequence for 12 parallel requests, got $DELTA"
pass "12 parallel requests after sleep → exactly 1 wake sequence"

echo "-- (c) SSE streaming through the gateway --"
SSE_FILE="$TEMP_DIR/wake-sse.txt"
# time-to-first-chunk vs total: streaming means first chunk arrives well before end
python - "$GW" "$SSE_FILE" <<'PYEOF'
import sys, time, json, urllib.request

gw, out_path = sys.argv[1], sys.argv[2]
body = json.dumps({
    "model": "gemma4-12b",
    "messages": [{"role": "user", "content": "Count slowly from 1 to 15, one number per line."}],
    "max_tokens": 220,
    "stream": True,
}).encode()
req = urllib.request.Request(
    f"{gw}/llama-swap/v1/chat/completions", data=body,
    headers={"Content-Type": "application/json"}, method="POST")
first_chunk_at = None
chunks = 0
start = time.time()
with urllib.request.urlopen(req, timeout=300) as resp:
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line or not line.startswith("data:"):
            continue
        if first_chunk_at is None:
            first_chunk_at = time.time() - start
        chunks += 1
total = time.time() - start
print(f"chunks={chunks} first_chunk_after={first_chunk_at:.2f}s total={total:.2f}s")
assert first_chunk_at is not None and chunks >= 5, "expected incremental SSE chunks"
assert total - first_chunk_at > 0.05, "all content arrived in one blob — not streaming"
open(out_path, "w").write(f"chunks={chunks} first={first_chunk_at:.3f} total={total:.3f}")
PYEOF
pass "SSE streamed incrementally ($(cat "$SSE_FILE"))"

echo "-- (d) regression: phases 01-04 --"
# Each nested test's full log is kept in temp/ so a failure is diagnosable
# from the failure message itself instead of "run it directly for details".
FAIL_LOG="$TEMP_DIR/regression-05-last-failure.txt"
: > "$FAIL_LOG"
for t in 01_dmz.sh 02_llama_swap.sh 03_litellm.sh 04_aux_services.sh; do
  LOG="$TEMP_DIR/regression-05-$t.log"
  if ! bash "$(dirname "$0")/$t" > "$LOG" 2>&1; then
    { echo "== nested regression failed in $t (from tests/05_wake_gateway.sh) ==";
      tail -n 25 "$LOG"; } > "$FAIL_LOG" 2>&1
    fail "regression: $t failed; details:
$(cat "$FAIL_LOG")"
  fi
done
pass "regression 01-04 green"

pass "Phase 5 complete"
