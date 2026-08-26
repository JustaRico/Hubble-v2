/**
 * Hubble Wake Gateway — streaming-safe reverse proxy in front of the
 * Workstation-hosted services (spec section 8).
 *
 * - per-route health checks (llama-swap /v1/models, searxng /healthz,
 *   firecrawl /v0/health/readiness, mcphub /health)
 * - ONE shared wake state per machine; concurrent requests coalesce onto the
 *   single in-flight wake sequence
 * - true pipe-based forwarding, no response buffering: SSE and token streams
 *   pass through untouched
 * - SAME_HOST_MODE=true skips the physical Wake-on-LAN send (single-machine run)
 */
import http from "node:http";
import { loadConfig } from "./config.mjs";
import { WakeStateMachine, makePerformWake } from "./wake.mjs";
import dgram from "node:dgram";

const cfg = loadConfig(process.env);

/** Send a Wake-on-LAN magic packet (used only when SAME_HOST_MODE=false). */
function sendWoL(mac, broadcast, port) {
  return new Promise((resolve, reject) => {
    const parts = mac.split(":").map((h) => parseInt(h, 16));
    const packet = Buffer.from([
      ...Array(6).fill(0xff),
      ...Array.from({ length: 16 }, () => parts).flat(),
    ]);
    const sock = dgram.createSocket("udp4");
    sock.on("error", reject);
    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(packet, port, broadcast, (err) => {
        sock.close();
        err ? reject(err) : resolve();
      });
    });
  });
}

/** Probe a route's health endpoint. */
async function probeRouteHealth(route) {
  const target = new URL(route.target + route.health.path);
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname, method: "GET", timeout: route.health.timeoutMs },
      (res) => resolve(route.health.accept.includes(res.statusCode)),
    );
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}

const state = new WakeStateMachine({ log: (s) => console.log(s) });
state.simulatedWakeDelayMs = 0;
state.performWake = async () => {
  // test hook: simulate a slow cold boot so concurrent requests can coalesce
  if (state.simulatedWakeDelayMs > 0) {
    await new Promise((res) => setTimeout(res, state.simulatedWakeDelayMs));
  }
  await makePerformWake(cfg, probeRouteHealth, sendWoL)();
};

/** Find the route whose prefix matches the URL. */
function matchRoute(pathname) {
  return cfg.routes.find((r) => pathname === r.prefix || pathname.startsWith(r.prefix + "/"));
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    // ── gateway's own endpoints ──────────────────────────────────────────
    if (req.url === "/health") {
      res.writeHead(state.inFlight ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: state.inFlight ? "waking" : "ok", sameHostMode: cfg.sameHostMode, stats: state.stats }));
      return;
    }
    if (req.url === "/stats") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...state.stats, waking: !!state.inFlight }));
      return;
    }
    if (req.url.startsWith("/sleep")) {
      // machine-level sleep simulation for tests/dev (spec: idle policy hook).
      // Returns the sequence counter so tests can bracket atomically — no
      // wake can start between reading stats and arming the sleep.
      const params = new URL(req.url, "http://x").searchParams;
      const delaySec = Number(params.get("wakeDelay") ?? 0);
      state.simulatedWakeDelayMs = delaySec * 1000;
      state.lastWakeCompletedAt = 0;
      console.log(`[wake] simulated sleep (wakeDelay=${delaySec}s) — next request triggers one wake sequence`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, wakeSequencesStarted: state.stats.wakeSequencesStarted }));
      return;
    }

    // ── proxied routes ───────────────────────────────────────────────────
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const route = matchRoute(url.pathname);
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no route for ${url.pathname}` }));
      return;
    }

    // shared wake gate: first unready request starts the sequence, all
    // concurrent requests (any route) wait on the SAME promise
    await state.ensureAwake(url.pathname);

    // true reverse proxy: pipe both directions, never buffer
    const upstream = new URL(route.target);
    const stripped = route.stripPrefix && url.pathname.startsWith(route.prefix)
      ? url.pathname.slice(route.prefix.length) || "/"
      : url.pathname;
    const proxyReq = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: stripped + url.search,
        method: req.method,
        headers: { ...req.headers, host: `${upstream.hostname}:${upstream.port}` },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res); // streaming pass-through (SSE safe)
      },
    );
    proxyReq.on("error", (err) => {
      console.error(`[wake] upstream error ${route.prefix}: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream failed", detail: err.message }));
    });
    req.pipe(proxyReq);
    req.on("end", () => console.log(`[wake] ${req.method} ${url.pathname} -> ${route.prefix} (${Date.now() - started}ms)`));
  } catch (err) {
    console.error(`[wake] request error: ${err.message}`);
    if (!res.headersSent) res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(cfg.port, () => {
  console.log(`[wake] Hubble Wake Gateway on :${cfg.port} (SAME_HOST_MODE=${cfg.sameHostMode}, ${cfg.routes.length} routes)`);
});
