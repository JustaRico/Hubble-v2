#!/usr/bin/env bash
# Phase 4 — Workstation auxiliary services.
# (a) SearXNG JSON search returns >=1 result for a known term
# (b) Firecrawl scrape of example.com returns non-empty markdown
#     (existing deployment reused this run; FIRECRAWL_URL in .env)
# (c) MCPHub lists the file-scanner tool AND executes it against the DMZ
# (d) regression: re-run 01-03

source "$(dirname "$0")/lib/common.sh"

source "$HUBBLE_ROOT/.env"
SEARXNG="http://localhost:${SEARXNG_PORT:-8180}"
MCPHUB="http://localhost:${MCPHUB_PORT:-13100}"

echo "-- (a) SearXNG JSON search --"
SX_FILE="$TEMP_DIR/searxng-test.json"
# duckduckgo (the default engine mix) intermittently CAPTCHAs self-hosted
# instances; pin a resilient engine set for the test as the research bureau does
curl -s --max-time 30 "$SEARXNG/search?q=hubble+telescope&format=json&engines=bing,wikipedia,google,ddg" -o "$SX_FILE"
[ "$(http_code "$SEARXNG/search?q=test&format=json")" = "200" ] || fail "SearXNG not reachable at $SEARXNG"
RESULT_COUNT="$("${JQ[@]}" '.results | length' "$SX_FILE")"
[ "${RESULT_COUNT:-0}" -ge 1 ] || fail "SearXNG returned no results"
pass "SearXNG returned $RESULT_COUNT results"

echo "-- (b) Firecrawl scrape --"
FC_URL="${FIRECRAWL_URL:-http://host.docker.internal:3002}"
FC_FILE="$TEMP_DIR/firecrawl-test.json"
FC_CODE="$(curl -s -o "$FC_FILE" -w '%{http_code}' --max-time 90 "$FC_URL/v2/scrape" \
  -H "Content-Type: application/json" \
  ${FIRECRAWL_API_KEY:+-H "Authorization: Bearer ${FIRECRAWL_API_KEY}"} \
  -d '{"url":"https://example.com","formats":["markdown"]}')"
[ "$FC_CODE" = "200" ] || fail "Firecrawl returned HTTP $FC_CODE: $(head -c 200 "$FC_FILE")"
"${JQ[@]}" -e '.success == true' "$FC_FILE" >/dev/null || fail "Firecrawl success!=true"
MARKDOWN_LENGTH="$("${JQ[@]}" '.data.markdown | length' "$FC_FILE")"
[ "${MARKDOWN_LENGTH:-0}" -gt 20 ] || fail "Firecrawl markdown too short ($MARKDOWN_LENGTH chars)"
pass "Firecrawl scraped example.com (${MARKDOWN_LENGTH} chars of markdown)"

echo "-- (c) MCPHub file-scanner tool --"
[ "$(http_code "$MCPHUB/")" = "200" ] || fail "MCPHub not reachable at $MCPHUB"
SID="$(curl -s --max-time 15 -X POST "$MCPHUB/mcp" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"hubble-test","version":"1.0"}}}' \
  -D - -o /dev/null | grep -i '^mcp-session-id:' | tr -d '\r' | awk '{print $2}')"
[ -n "$SID" ] || fail "MCPHub: no mcp-session-id returned by initialize"
TOOLS="$(curl -s --max-time 15 -X POST "$MCPHUB/mcp" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SID" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')"
echo "$TOOLS" | grep -q "scan_directory" || fail "file-scanner tool not listed via MCPHub"
pass "tool listed: file-scanner-scan_directory"

RESULT="$(curl -s --max-time 15 -X POST "$MCPHUB/mcp" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"file-scanner-scan_directory","arguments":{"path":"."}}}')"
echo "$RESULT" | grep -q 'data:.*root.\{0,8\}/data/dmz' || fail "tool call failed"
pass "tool executed and listed the DMZ"

echo "-- (d) regression: phases 01-03 --"
FAIL_LOG="$TEMP_DIR/regression-04-last-failure.txt"
: > "$FAIL_LOG"
for t in 01_dmz.sh 02_llama_swap.sh 03_litellm.sh; do
  LOG="$TEMP_DIR/regression-04-$t.log"
  if ! bash "$(dirname "$0")/$t" > "$LOG" 2>&1; then
    { echo "== nested regression failed in $t (from tests/04_aux_services.sh) ==";
      tail -n 25 "$LOG"; } > "$FAIL_LOG" 2>&1
    fail "regression: $t failed; details:
$(cat "$FAIL_LOG")"
  fi
done
pass "regression 01-03 green"

pass "Phase 4 complete"
