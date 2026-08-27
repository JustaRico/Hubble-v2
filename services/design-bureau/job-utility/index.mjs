/**
 * Hubble shared background-job utility (Phase 9).
 *
 * One in-process registry: start(fn, {schema, timeoutMs}) -> taskId.
 * Poll with status(id), validate with result(id), cancel(id).
 * States: pending -> running -> done | failed | cancelled.
 * Hard timeout (timeoutMs) force-fails before the function can hang forever.
 *
 * Mirrors the async-job/status-polling shape already used for the Wake
 * Gateway's cold-boot problem and the escalation approval overlay, and matches
 * Odysseus ResearchHandler's own task manager.
 *
 * Consumers (Design Bureau, Research Bureau) import this single module rather
 * than each reinventing task tracking.
 */
import { z } from "zod";

const StatusSchema = z.enum(["pending", "running", "done", "failed", "cancelled"]);

export class JobUtility {
  constructor({ defaultTimeoutMs = 300000 } = {}) {
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.jobs = new Map(); // id -> record
    this.nextId = 1;
  }

  /**
   * Start a job. Returns the taskId immediately.
   * @param {() => Promise<any> | any} fn - the async work
   * @param {{ schema?: z.ZodTypeAny, timeoutMs?: number, label?: string }} opts
   * @returns {string} taskId
   */
  start(fn, opts = {}) {
    const id = `job-${Date.now()}-${this.nextId++}`;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const schema = opts.schema ?? null;
    const label = opts.label ?? id;

    const record = {
      id,
      label,
      status: "pending",
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      result: undefined,
      error: undefined,
      schema,
      cancelled: false,
      timeoutMs,
      _timer: null,
      _abort: null,
    };
    this.jobs.set(id, record);

    // Defer to next tick so caller can poll "pending" before "running"
    queueMicrotask(() => this._run(id, fn));

    // Hard timeout: force-fail if still pending/running
    record._timer = setTimeout(() => {
      const r = this.jobs.get(id);
      if (!r || (r.status !== "pending" && r.status !== "running")) return;
      r.status = "failed";
      r.error = `job exceeded hard timeout of ${timeoutMs}ms`;
      r.finishedAt = Date.now();
      if (r._abort) r._abort.abort();
    }, timeoutMs);
    // Don't keep Node alive just for a timeout
    if (record._timer.unref) record._timer.unref();

    return id;
  }

  async _run(id, fn) {
    const r = this.jobs.get(id);
    if (!r || r.cancelled) return;
    r.status = "running";
    r.startedAt = Date.now();
    const controller = new AbortController();
    r._abort = controller;
    try {
      const raw = await fn({ signal: controller.signal, jobId: id });
      const cur = this.jobs.get(id);
      if (!cur || cur.cancelled || cur.status === "failed") return;
      if (cur.schema) {
        const parsed = cur.schema.safeParse(raw);
        if (!parsed.success) {
          cur.status = "failed";
          cur.error = `result validation failed: ${parsed.error.message}`;
          cur.finishedAt = Date.now();
          return;
        }
        cur.result = parsed.data;
      } else {
        cur.result = raw;
      }
      cur.status = "done";
      cur.finishedAt = Date.now();
    } catch (err) {
      const cur = this.jobs.get(id);
      if (!cur) return;
      if (cur.cancelled) {
        cur.status = "cancelled";
        cur.finishedAt = Date.now();
        return;
      }
      if (cur.status === "failed") return; // already timed out
      cur.status = "failed";
      cur.error = String(err?.message ?? err);
      cur.finishedAt = Date.now();
    } finally {
      const cur = this.jobs.get(id);
      if (cur?._timer) clearTimeout(cur._timer);
    }
  }

  /** Current status snapshot (throws if unknown id). */
  status(id) {
    const r = this.jobs.get(id);
    if (!r) throw new Error(`unknown job ${id}`);
    StatusSchema.parse(r.status);
    return {
      id: r.id,
      status: r.status,
      label: r.label,
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      error: r.error ?? null,
    };
  }

  /** Validated result (only when status is 'done'). */
  result(id) {
    const r = this.jobs.get(id);
    if (!r) throw new Error(`unknown job ${id}`);
    if (r.status !== "done") throw new Error(`job ${id} is ${r.status}, not done`);
    return r.result;
  }

  /** Cancel a pending/running job. Returns true if it was cancelled. */
  cancel(id) {
    const r = this.jobs.get(id);
    if (!r) throw new Error(`unknown job ${id}`);
    if (r.status === "done" || r.status === "failed" || r.status === "cancelled") return false;
    r.cancelled = true;
    if (r._abort) r._abort.abort();
    if (r.status === "pending") {
      r.status = "cancelled";
      r.finishedAt = Date.now();
      if (r._timer) clearTimeout(r._timer);
    } else {
      // running: _run will flip to cancelled on next catch
      r.status = "cancelled";
      r.finishedAt = Date.now();
    }
    return true;
  }

  /** For tests: wait until status leaves pending/running, with a poll timeout. */
  async waitForTerminal(id, { timeoutMs = 10000, pollMs = 50 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = this.status(id).status;
      if (s === "done" || s === "failed" || s === "cancelled") return s;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`waitForTerminal timed out for ${id} (still ${this.status(id).status})`);
  }
}

// Singleton for the whole process (consumers import the same instance)
export const jobs = new JobUtility();
