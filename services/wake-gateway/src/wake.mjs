/**
 * Shared wake state — ONE per machine, not per route (spec section 8).
 *
 * The first request that finds the machine unready triggers the wake sequence;
 * every concurrent request for ANY route awaits the same in-flight sequence.
 * In SAME_HOST_MODE the "wake" is a health-check retry loop (the services are
 * already up; this exercises coalescing + polling without real WoL).
 */

/** @typedef {{startedAt:number, promise:Promise<void>, reason:string}} WakeJob */

export class WakeStateMachine {
  /**
   * @param {object} opts
   * @param {(log:string)=>void} [opts.log]
   */
  constructor(opts = {}) {
    this.log = opts.log ?? ((s) => console.log(`[wake] ${s}`));
    /** @type {null|WakeJob} */
    this.inFlight = null;
    this.lastWakeCompletedAt = 0;
    /** counters exposed for tests */
    this.stats = { wakeSequencesStarted: 0 };
    /** injected by server: performs the actual wake+wait; returns when ready */
    this.performWake = null;
  }

  /**
   * Is the machine considered awake? In SAME_HOST_MODE "awake" is decided
   * per-request by probing health, so this reports the sticky belief only.
   */
  isAwake() {
    return this.inFlight === null && this.lastWakeCompletedAt > 0;
  }

  /**
   * Ensure the machine is awake. Concurrent callers for any route share the
   * single in-flight sequence. Resolves once ready or rejects on timeout.
   * @param {string} reason who asked (route name), for logs/tests
   */
  async ensureAwake(reason) {
    if (this.inFlight) {
      this.log(`coalescing wait from ${reason} onto in-flight sequence`);
      return this.inFlight.promise;
    }
    const promise = this.#runSequence(reason);
    // store synchronously so racing callers see it
    this.inFlight = { startedAt: Date.now(), promise, reason };
    this.stats.wakeSequencesStarted += 1;
    try {
      await promise;
      this.lastWakeCompletedAt = Date.now();
    } finally {
      this.inFlight = null;
    }
  }

  async #runSequence(reason) {
    if (!this.performWake) throw new Error("performWake not configured");
    this.log(`wake sequence START (${reason})`);
    try {
      await this.performWake();
      this.log("wake sequence DONE");
    } catch (err) {
      this.log(`wake sequence FAILED: ${err.message}`);
      throw err;
    }
  }
}

/**
 * Build performWake for the gateway: optionally send WoL (skipped in
 * SAME_HOST_MODE), then poll route health until every route accepts.
 * @param {import('./config.mjs').z.infer<typeof import('./config.mjs').ConfigSchema>} cfg
 * @param {(route:any)=>Promise<boolean>} probeRouteHealth
 * @param {(mac:string,broadcast:string,port:number)=>Promise<void>} sendWoL
 */
export function makePerformWake(cfg, probeRouteHealth, sendWoL) {
  return async () => {
    const deadline = Date.now() + cfg.wake.timeoutSec * 1000;

    if (!cfg.sameHostMode) {
      if (!cfg.wol.mac) throw new Error("SAME_HOST_MODE=false but WORKSTATION_MAC is unset");
      await sendWoL(cfg.wol.mac, cfg.wol.broadcast, cfg.wol.port);
    }

    let allReady = false;
    while (Date.now() < deadline) {
      const results = await Promise.all(
        cfg.routes.map(async (r) => ({ route: r.prefix, ok: await probeRouteHealth(r) })),
      );
      allReady = results.every((r) => r.ok);
      if (allReady) return;
      const down = results.filter((r) => !r.ok).map((r) => r.route).join(",");
      process.stdout.write(`[wake] waiting for routes: ${down}\n`);
      await new Promise((res) => setTimeout(res, cfg.wake.pollIntervalMs));
    }
    throw new Error(`wake timeout after ${cfg.wake.timeoutSec}s`);
  };
}
