#!/usr/bin/env bash
# Start the Hubble DSH instance (Phase 6) with the project env exported.
# Usage: scripts/start_dsh.sh [port]
source "$(dirname "$0")/common.sh"
cd "$ROOT"
set -a; source .env; set +a
export DSH_HOME="$ROOT/data/dsh-home"
PORT="${1:-${HUBBLE_DSH_PORT:-3080}}"
exec npx -y @deepseek-ai/dsh web --no-open --port "$PORT"
