#!/usr/bin/env bash
# Hubble test runner — runs EVERY test file accumulated so far, in order.
# Regression rule: a phase is not complete until this is fully green.

set -u
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
FAILED_NAMES=()

# Run every numbered .sh test in order, then every .test.mjs (node --test) in order
for t in tests/[0-9][0-9]_*.sh; do
  [ -e "$t" ] || continue
  name="$(basename "$t")"
  echo "=============================================================="
  echo ">>> $name"
  echo "--------------------------------------------------------------"
  if bash "$t"; then
    PASS=$((PASS+1))
    echo "<<< $name: PASS"
  else
    rc=$?
    FAIL=$((FAIL+1))
    FAILED_NAMES+=("$name (rc=$rc)")
    echo "<<< $name: FAIL (rc=$rc)"
  fi
done
for t in tests/[0-9][0-9]_*.test.mjs; do
  [ -e "$t" ] || continue
  name="$(basename "$t")"
  echo "=============================================================="
  echo ">>> $name (node --test)"
  echo "--------------------------------------------------------------"
  if node --test "$t"; then
    PASS=$((PASS+1))
    echo "<<< $name: PASS"
  else
    rc=$?
    FAIL=$((FAIL+1))
    FAILED_NAMES+=("$name (rc=$rc)")
    echo "<<< $name: FAIL (rc=$rc)"
  fi
done

echo "=============================================================="
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -gt 0 ] && printf 'Failures: %s\n' "${FAILED_NAMES[*]}"
exit "$FAIL"
