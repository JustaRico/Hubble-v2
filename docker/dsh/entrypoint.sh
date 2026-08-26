#!/bin/bash
# Hubble DSH entrypoint — final shape:
#   Caddy (basic auth, :80) -> dsh web (loopback-only, :3081)
#
# DSH refuses --host 0.0.0.0 by design; the proxy shares this container's
# network namespace so loopback is exactly what it should be. The DSH tree is
# baked into the image: we run node directly (no npx at runtime).
set -eu

DSH_HOME="${DSH_HOME:-/data/dsh-home}"
INTERNAL_PORT="${INTERNAL_PORT:-3081}"
PUBLIC_PORT="${PUBLIC_PORT:-80}"
DSH_BIN="/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"

export DSH_HOME
mkdir -p "$DSH_HOME"

echo "[entrypoint] starting dsh web on 127.0.0.1:${INTERNAL_PORT}"
node "$DSH_BIN" web --no-open --host 127.0.0.1 --port "$INTERNAL_PORT" &
DSH_PID=$!

echo "[entrypoint] starting caddy on 0.0.0.0:${PUBLIC_PORT} -> 127.0.0.1:${INTERNAL_PORT}"
caddy run --config /opt/hubble/Caddyfile --adapter caddyfile &
CADDY_PID=$!

term() { kill -TERM "$DSH_PID" "$CADDY_PID" 2>/dev/null || true; }
trap term TERM INT

wait -n "$DSH_PID" "$CADDY_PID"
status=$?
kill -TERM "$DSH_PID" "$CADDY_PID" 2>/dev/null || true
exit "$status"
