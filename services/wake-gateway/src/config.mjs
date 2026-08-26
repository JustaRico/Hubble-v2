/**
 * Wake Gateway configuration — Zod-validated route table + env settings.
 * (Spec section 8: per-route health checks, one shared wake state per machine,
 * SAME_HOST_MODE for the single-machine run.)
 */
import { z } from "zod";

const RouteSchema = z.object({
  /** path prefix the gateway serves this route under, e.g. /llama-swap */
  prefix: z.string().startsWith("/"),
  /** upstream base URL, e.g. http://host.docker.internal:10123 */
  target: z.string().url(),
  /** strip the prefix before forwarding (true when upstream has no such path) */
  stripPrefix: z.boolean().default(true),
  health: z
    .object({
      /** GET probe path used to decide "reachable" */
      path: z.string().startsWith("/"),
      /** acceptable HTTP status codes */
      accept: z.array(z.number().int()).default([200]),
      timeoutMs: z.number().int().positive().default(5000),
    })
    .default({ path: "/", accept: [200], timeoutMs: 5000 }),
});

export const ConfigSchema = z.object({
  port: z.number().int().positive(),
  sameHostMode: z.boolean(),
  /** single-machine run: one logical machine = all routes share one wake state */
  routes: z.array(RouteSchema).min(1),
  wol: z.object({
    mac: z.string().regex(/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/).or(z.literal("")),
    broadcast: z.string().default("255.255.255.255"),
    port: z.number().int().default(9),
  }),
  wake: z.object({
    /** max seconds a wake sequence may take before failing waiters */
    timeoutSec: z.number().int().positive().default(600),
    /** seconds between health probes while waking */
    pollIntervalMs: z.number().int().positive().default(2000),
  }),
});

/**
 * Build config from env + the static route table.
 * Health endpoints verified during Phase 4 build-out:
 *  - llama-swap: its own /v1/models (the checkEndpoint equivalent)
 *  - searxng: /healthz
 *  - firecrawl: /v0/health/readiness (reused existing deployment)
 *  - mcphub: custom /health reporting per-server connection state
 */
export function loadConfig(env) {
  const routes = [
    {
      prefix: "/llama-swap",
      target: env.LLAMA_SWAP_TARGET ?? "http://host.docker.internal:10123",
      stripPrefix: true,
      health: { path: "/v1/models", accept: [200], timeoutMs: 5000 },
    },
    {
      prefix: "/searxng",
      target: env.SEARXNG_TARGET ?? "http://localhost:8180",
      stripPrefix: true,
      health: { path: "/healthz", accept: [200], timeoutMs: 5000 },
    },
    {
      prefix: "/firecrawl",
      target: env.FIRECRAWL_TARGET ?? "http://host.docker.internal:3002",
      stripPrefix: true,
      health: { path: "/v0/health/readiness", accept: [200], timeoutMs: 5000 },
    },
    {
      prefix: "/mcphub",
      target: env.MCPHUB_TARGET ?? "http://localhost:13100",
      stripPrefix: true,
      // MCPHub exposes a real connection test, not just a TCP check:
      // status must be healthy AND every enabled server connected.
      health: { path: "/health", accept: [200], timeoutMs: 5000 },
    },
  ];

  return ConfigSchema.parse({
    port: Number(env.WAKE_GW_PORT ?? 8811),
    sameHostMode: (env.SAME_HOST_MODE ?? "true") === "true",
    routes,
    wol: {
      mac: env.WORKSTATION_MAC ?? "",
      broadcast: env.WORKSTATION_BROADCAST ?? "255.255.255.255",
      port: Number(env.WOL_PORT ?? 9),
    },
    wake: {
      timeoutSec: Number(env.WAKE_TIMEOUT_SEC ?? 600),
      pollIntervalMs: Number(env.WAKE_POLL_INTERVAL_MS ?? 2000),
    },
  });
}
