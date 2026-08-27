/**
 * Phase 9 — Shared background-job utility tests (node --test).
 * Covers BUILD_GUIDE 09: lifecycle, cancellation, hard timeout, Zod validation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { JobUtility } from "../services/job-utility/src/index.mjs";

test("full lifecycle: pending -> running -> done with validated result", async () => {
  const util = new JobUtility({ defaultTimeoutMs: 5000 });
  const schema = z.object({ ok: z.boolean(), artifact: z.string() });

  const id = util.start(async () => {
    await new Promise((r) => setTimeout(r, 80));
    return { ok: true, artifact: "/dmz/test.txt" };
  }, { schema });

  // Should be pending immediately after start
  assert.equal(util.status(id).status, "pending");

  const terminal = await util.waitForTerminal(id, { timeoutMs: 3000 });
  assert.equal(terminal, "done");
  const result = util.result(id);
  assert.equal(result.ok, true);
  assert.equal(result.artifact, "/dmz/test.txt");
});

test("cancellation mid-run leaves state cancelled, not done", async () => {
  const util = new JobUtility({ defaultTimeoutMs: 5000 });

  const id = util.start(async ({ signal }) => {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve("should not reach"), 5000);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("aborted via signal"));
      });
    });
    return { ok: true };
  });

  // Let it reach running
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(util.status(id).status, "running");

  const cancelled = util.cancel(id);
  assert.equal(cancelled, true);

  const terminal = await util.waitForTerminal(id, { timeoutMs: 2000 });
  assert.equal(terminal, "cancelled");
  assert.throws(() => util.result(id), /not done/);
});

test("job exceeding hard timeout is force-failed rather than hanging", async () => {
  const util = new JobUtility({ defaultTimeoutMs: 5000 });

  const id = util.start(async () => {
    await new Promise((r) => setTimeout(r, 5000));
    return { ok: true };
  }, { timeoutMs: 250 });

  const terminal = await util.waitForTerminal(id, { timeoutMs: 3000 });
  assert.equal(terminal, "failed");
  assert.match(util.status(id).error, /hard timeout/);
});

test("Zod validation failure marks job as failed", async () => {
  const util = new JobUtility({ defaultTimeoutMs: 5000 });
  const schema = z.object({ artifact: z.string() });

  const id = util.start(async () => {
    return { wrong: "shape" };
  }, { schema });

  const terminal = await util.waitForTerminal(id, { timeoutMs: 2000 });
  assert.equal(terminal, "failed");
  assert.match(util.status(id).error, /validation failed/);
});
