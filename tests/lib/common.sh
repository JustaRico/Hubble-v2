#!/usr/bin/env bash
# Shared helpers for Hubble infra tests (bash + curl + jq).

# jq: prefer system jq, fall back to vendored tools/jq.exe
if command -v jq >/dev/null 2>&1; then
  JQ=(jq)
elif [ -x "$(dirname "${BASH_SOURCE[0]}")/../../tools/jq.exe" ]; then
  JQ=($(dirname "${BASH_SOURCE[0]}")/../../tools/jq.exe)
else
  echo "FATAL: no jq available" >&2
  exit 1
fi

HUBBLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMP_DIR="$HUBBLE_ROOT/temp"
mkdir -p "$TEMP_DIR"

pass() { echo "  PASS: $*"; }
fail() { echo "  FAIL: $*" >&2; exit 1; }

# assert_contains <haystack> <needle> <label>
assert_contains() {
  case "$1" in
    *"$2"*) pass "$3" ;;
    *) fail "$3 — expected to contain: $2 ; got: $(printf '%.120s' "$1")" ;;
  esac
}

# http_code <url> [curl args...] -> prints HTTP status code
http_code() {
  local url="$1"; shift
  curl -s -o /dev/null -w '%{http_code}' --max-time "${MAX_TIME:-15}" "$@" "$url"
}

# wait_for <url> <timeout_seconds> — poll until HTTP 200
wait_for() {
  local url="$1" timeout="${2:-60}" i=0
  until [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url")" = "200" ]; do
    sleep 1
    i=$((i+1))
    if [ "$i" -ge "$timeout" ]; then return 1; fi
  done
}
