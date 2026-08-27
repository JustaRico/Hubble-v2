#!/usr/bin/env bash
# Hubble 2.0 — single-machine installer (Phase 13).
# Idempotent: safe to re-run. Installs prerequisites where missing, builds
# images, brings the stack up, and self-verifies via tests/run_tests.sh.
#
# Target: the Workstation box (RTX 4080 Super class) running everything.

set -euo pipefail
cd "$(dirname "$0")"

echo "=== Hubble 2.0 single-machine installer ==="

# ── 1. prerequisites ─────────────────────────────────────────────────────────
echo "-- [1/6] checking prerequisites --"
command -v docker >/dev/null || { echo "docker missing"; exit 1; }
docker compose version >/dev/null || { echo "docker compose v2 missing"; exit 1; }

if ! command -v node >/dev/null; then
  echo "!! Node.js >= 20 required (DSH runtime + test tooling). Install from https://nodejs.org"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "node >= 20 required, found $(node --version)"; exit 1; }

# jq is vendored by the repo for Windows hosts; Linux/macOS use system jq
if ! command -v jq >/dev/null && [ ! -x tools/jq.exe ]; then
  if command -v apt-get >/dev/null; then sudo apt-get install -y jq
  elif command -v brew >/dev/null; then brew install jq
  else echo "WARN: no jq found; infra tests will need it" >&2; fi
fi

# GPU check (non-fatal on machines without NVIDIA hardware)
if command -v nvidia-smi >/dev/null; then
  nvidia-smi -L || true
else
  echo "WARN: nvidia-smi not found — llama-swap model serving will not work"
fi

# NetBird is NOT required for the single-machine run (warn only)
command -v netbird >/dev/null && netbird status >/dev/null 2>&1 \
  || echo "NOTE: netbird not active — fine for single-machine; required before split"

# ── 2. env file ──────────────────────────────────────────────────────────────
echo "-- [2/6] environment --"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "created .env from .env.example"
  # generate a DSH basic-auth hash via caddy
  read -r -s -p "Choose a password for the DSH web UI (hubble user): " DSHPW; echo
  HASH="$(docker run --rm caddy:2 caddy hash-password --plaintext "$DSHPW" | tr -d '\r\n')"
  B64="$(printf '%s' "$HASH" | base64)"
  python3 - "$B64" <<'PY' 2>/dev/null || sed -i "s|^DSH_BASIC_AUTH_B64=.*|DSH_BASIC_AUTH_B64=$1|" .env
import sys, pathlib
p = pathlib.Path(".env"); t = p.read_text()
t = t.replace("DSH_BASIC_AUTH_B64=", f"DSH_BASIC_AUTH_B64={sys.argv[1]}")
p.write_text(t)
PY
  echo "DSH basic auth configured."
fi

# OPENROUTER key must be present for assistant/coder/planner models
if ! grep -qE "^OPENROUTER_API_KEY=.+" .env; then
  echo "!! OPENROUTER_API_KEY empty in .env — cloud models will fail until set."
fi

# ── 3. local module installs (job utility consumers resolve zod) ─────────────
echo "-- [3/6] npm modules --"
[ -d node_modules/zod ] || npm install --no-audit --no-fund >/dev/null
for d in services/job-utility services/design-bureau services/research-bureau; do
  [ -d "$d/node_modules" ] || (cd "$d" && npm install --no-audit --no-fund >/dev/null)
done

# ── 4. images ────────────────────────────────────────────────────────────────
echo "-- [4/6] building/pulling images --"
docker compose -f docker-compose.single-machine.yml build

# ── 5. stack up ──────────────────────────────────────────────────────────────
echo "-- [5/6] starting stack --"
docker compose -f docker-compose.single-machine.yml up -d
# llama-swap may be an existing deployment on this host (as in this build);
# the installer expects it listening on :10123:
docker ps --format '{{.Names}}' | grep -qx llama-swap || {
  echo "NOTE: no container named 'llama-swap' running. Ensure llama-swap serves"
  echo "      gemma4-12b + qwen3-embed at localhost:10123 before model-dependent tests."
}

# ── 6. post-install smoke test = the accumulated suite ───────────────────────
echo "-- [6/6] running tests/run_tests.sh as smoke test --"
if npm test; then
  echo ""
  echo "=== Hubble 2.0 installed and verified green ==="
else
  echo ""
  echo "=== installer finished but suite has failures — inspect output above ==="
  exit 1
fi
