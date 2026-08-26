#!/usr/bin/env bash
# Phase 0 — Prerequisites.
# Checks docker, docker compose, GPU-in-container, node >= 20, and netbird presence.
# NetBird is intentionally NOT load-bearing in the single-machine run: its check
# warns but does not fail (see BUILD_GUIDE Phase 0 / run notes).

source "$(dirname "$0")/lib/common.sh"

echo "-- docker --"
docker --version >/dev/null 2>&1 || fail "docker not available"
pass "docker: $(docker --version)"

echo "-- docker compose --"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 not available"
pass "compose: $(docker compose version --short)"

echo "-- node >= 20 --"
command -v node >/dev/null 2>&1 || fail "node not available"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "node $(node --version) < 20"
pass "node: $(node --version)"

echo "-- nvidia-smi on host --"
nvidia-smi -L >/dev/null 2>&1 || fail "nvidia-smi failed on host"
pass "GPU: $(nvidia-smi -L | head -1)"

echo "-- GPU visible inside a CUDA test container --"
GPU_IN_CONTAINER="$(docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi -L 2>/dev/null)"
if [ -n "$GPU_IN_CONTAINER" ]; then
  pass "GPU in container: $GPU_IN_CONTAINER"
else
  echo "  WARN: GPU-in-container probe failed (driver/toolkit mismatch?) — continuing, non-fatal for single-machine run"
fi

echo "-- netbird (warn-only in this run) --"
if command -v netbird >/dev/null 2>&1 && netbird status >/dev/null 2>&1; then
  pass "netbird present"
else
  echo "  WARN: netbird not installed/running — skipped per single-machine run notes; required before multi-machine split only."
fi

pass "Phase 0 complete"
