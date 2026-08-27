#!/usr/bin/env bash
# Hubble 2.0 — Homelab-tier installer (Phase 13, post-split).
# Installs the always-on control plane: DSH, LiteLLM, Wake Gateway, DMZ,
# Escalation + both Bureaus. Expects WORKSTATION_NETBIRD_IP and
# WORKSTATION_MAC in .env (the Workstation runs install-workstation.sh itself).

set -euo pipefail
cd "$(dirname "$0")"

echo "=== Hubble 2.0 Homelab installer ==="

# ── 1. prerequisites ─────────────────────────────────────────────────────────
echo "-- [1/5] prerequisites --"
command -v docker >/dev/null || { echo "docker missing"; exit 1; }
docker compose version >/dev/null || { echo "docker compose v2 missing"; exit 1; }
command -v node >/dev/null || { echo "node >= 20 required"; exit 1; }

# NetBird IS load-bearing on this tier (reaches the Workstation over the mesh)
if ! command -v netbird >/dev/null; then
  echo "!! netbird required on the Homelab tier (curl -fsSL https://pkgs.netbird.io/install.sh | sh)"
  exit 1
fi
netbird status >/dev/null || { echo "netbird not connected — run: netbird up"; exit 1; }

# ── 2. env ───────────────────────────────────────────────────────────────────
echo "-- [2/5] environment --"
[ -f .env ] || { cp .env.example .env; echo "created .env — fill OPENROUTER_API_KEY etc."; }

for v in WORKSTATION_NETBIRD_IP WORKSTATION_MAC; do
  grep -qE "^${v}=..+" .env || { echo "!! ${v} must be set in .env for the split topology"; exit 1; }
done

# ── 3. modules ───────────────────────────────────────────────────────────────
echo "-- [3/5] npm modules --"
[ -d node_modules/zod ] || npm install --no-audit --no-fund >/dev/null

# ── 4. images ────────────────────────────────────────────────────────────────
echo "-- [4/5] building images --"
docker compose -f docker-compose.homelab.yml build

# ── 5. up + smoke test ───────────────────────────────────────────────────────
echo "-- [5/5] starting stack --"
docker compose -f docker-compose.homelab.yml up -d

echo "smoke test: run tests/run_tests.sh against this box once the Workstation"
echo "is reachable (Wake Gateway flips SAME_HOST_MODE=false with its MAC)."
echo "Suite phases that touch Workstation services (02/04/05) require it awake."
