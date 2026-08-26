/**
 * Wake Gateway — shared wake-state machine tests.
 * Verifies: coalescing (N concurrent requests → 1 sequence), failure clearing,
 * and sequential new sequences. Plain asserts + exit code (node-runnable).
 * Run by tests/run_tests.sh via: node tests/05_wake_state.test.mjs
 */
import { WakeStateMachine } from "../services/wake-gateway/src/wake.mjs";

let failures = 0;
function check(cond, label) {
  if (cond) { console.log(`  PASS: ${label}`); }
  else { failures += 1; console.error(`  FAIL: ${label}`); }
}

// ── test 1: coalescing ──────────────────────────────────────────────────────
{
  let resolveGate;
  const gate = new Promise((res) => { resolveGate = res; });
  let sequences = 0;
  const state = new WakeStateMachine({ log: () => {} });
  state.performWake = async () => {
    sequences += 1;
    await gate; // hold the "wake" open so the other 4 calls must coalesce
  };

  // five requests fire synchronously while the machine is "asleep"
  const waiters = [1, 2, 3, 4, 5]
    .map((i) => state.ensureAwake("route" + i))
    .map((p) => p.then(() => ({ ok: true }), (e) => ({ ok: false, err: e })));
  // release the held wake; every coalesced waiter must now settle
  resolveGate();
  const settled = await Promise.all(waiters);

  check(sequences === 1, `wake sequence ran exactly once (got ${sequences})`);
  check(state.stats.wakeSequencesStarted === 1, "counter says 1 sequence started");
  check(settled.every((r) => r.ok), `all five waiters resolved (${JSON.stringify(settled.filter((r) => !r.ok))})`);
  check(state.inFlight === null, "inFlight cleared after completion");
}

// ── test 2: sequential requests start NEW sequences ─────────────────────────
{
  let sequences = 0;
  const state = new WakeStateMachine({ log: () => {} });
  state.performWake = async () => { sequences += 1; };
  await state.ensureAwake("a");
  await state.ensureAwake("b");
  check(sequences === 2, `sequential requests run 2 sequences (got ${sequences})`);
}

// ── test 3: failed wake rejects and clears in-flight ────────────────────────
{
  const state = new WakeStateMachine({ log: () => {} });
  state.performWake = async () => { throw new Error("boot failed"); };
  let rejected = false;
  try { await state.ensureAwake("x"); } catch (e) { rejected = /boot failed/.test(e.message); }
  check(rejected, "failed wake rejects waiters with the boot error");
  check(state.inFlight === null, "inFlight cleared after failure");
  state.performWake = async () => {};
  await state.ensureAwake("y");
  check(state.stats.wakeSequencesStarted === 2, "later request may retry after failure");
}

if (failures > 0) {
  console.error(`05_wake_state: ${failures} failing assertion(s)`);
  process.exit(1);
}
console.log("  PASS: 05_wake_state all assertions green");
