/**
 * Hubble Research Bureau HTTP service (Phase 11).
 * Thin wrapper: /health, POST /research -> taskId, GET /research/:id,
 * GET /research/:id/result, plus test controls. Loop logic lives in loop.mjs.
 */
import http from "node:http";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { JobUtility } from "./job-utility/index.mjs";
import { ReportSchema } from "./loop.mjs";
import { makeDefaultIo } from "./io.mjs";

const PORT = Number(process.env.HUBBLE_RESEARCH_PORT ?? 8814);
const LITELLM_URL = process.env.LITELLM_URL ?? "http://localhost:14000/v1";
const LITELLM_KEY = process.env.LITELLM_MASTER_KEY ?? "";
const RESEARCH_MODEL = process.env.HUBBLE_RESEARCH_MODEL ?? "research-model";
const SEARXNG_BASE = process.env.SEARXNG_TARGET ?? "http://localhost:8180";
const FIRECRAWL_BASE = process.env.FIRECRAWL_TARGET ?? "http://host.docker.internal:3002";
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY ?? "";
const DMZ_BASE = process.env.HUBBLE_DMZ_URL ?? "http://localhost:13923/dmz";
const DMZ_USER = process.env.HUBBLE_DMZ_USER ?? "hubble";
const DMZ_PASS = process.env.HUBBLE_DMZ_PASS ?? "hubble-dev-pass";
export const MAX_ROUNDS = Number(process.env.HUBBLE_RESEARCH_MAX_ROUNDS ?? 6);
const ROUND_TIMEOUT_MS = Number(process.env.HUBBLE_RESEARCH_ROUND_TIMEOUT_MS ?? 120000);
const ALLOW_TEST_CONTROLS = (process.env.HUBBLE_ALLOW_TEST_CONTROLS ?? "false") === "true";

const jobs = new JobUtility({ defaultTimeoutMs: MAX_ROUNDS * ROUND_TIMEOUT_MS + 60000 });

let _ioImpl = null; // test control: replace the whole IO surface
function log(entry) {
  console.log(`[research] ${JSON.stringify({ ts: new Date().toISOString(), ...entry })}`);
}

/** Real IO unless a test stub was injected via /_test/set-io-stub. */
function currentIo() {
  return _ioImpl ?? makeDefaultIo({
    litellmUrl: LITELLM_URL, litellmKey: LITELLM_KEY, researchModel: RESEARCH_MODEL,
    searxngBase: SEARXNG_BASE, firecrawlBase: FIRECRAWL_BASE, firecrawlKey: FIRECRAWL_API_KEY,
    dmzBase: DMZ_BASE, dmzUser: DMZ_USER, dmzPass: DMZ_PASS, roundTimeoutMs: ROUND_TIMEOUT_MS,
  });
}

async function startResearch(question) {
  const taskId = `res-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  const jobId = jobs.start(async () => {
    const { orchestrate } = await import("./loop.mjs");
    return orchestrate(taskId, question, {
      io: currentIo(),
      maxRounds: MAX_ROUNDS,
    });
  }, {
    schema: ReportSchema,
    timeoutMs: MAX_ROUNDS * ROUND_TIMEOUT_MS + 60000,
    label: taskId,
  });
  log({ event: "accepted", taskId, jobId, question: question.slice(0, 100) });
  return { taskId, jobId };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", maxRounds: MAX_ROUNDS }));
      return;
    }
    if (ALLOW_TEST_CONTROLS && req.method === "POST" && url.pathname === "/_test/set-io-stub") {
      // Receive a JS module URL exporting makeIo(env) — used by contract tests
      // running in-process instead (this endpoint is a convenience for curl
      // debugging); in tests we pass io directly to orchestrate().
      let raw = ""; for await (const c of req) raw += c;
      const body = JSON.parse(raw || "{}");
      _ioImpl = body.io ?? null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ioStubbed: !!_ioImpl }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/research") {
      let raw = ""; for await (const c of req) raw += c;
      const { question } = JSON.parse(raw || "{}");
      if (!question?.trim()) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "question is required" }));
        return;
      }
      const { taskId, jobId } = await startResearch(question.trim());
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ taskId, jobId }));
      return;
    }
    const sm = url.pathname.match(/^\/research\/([\w-]+)$/);
    if (req.method === "GET" && sm) {
      const rec = [...jobs.jobs.values()].find((j) => j.label === sm[1] || j.id === sm[1]);
      if (!rec) { res.writeHead(404); res.end(JSON.stringify({ error: "unknown taskId" })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(jobs.status(rec.id)));
      return;
    }
    const rm = url.pathname.match(/^\/research\/([\w-]+)\/result$/);
    if (req.method === "GET" && rm) {
      const rec = [...jobs.jobs.values()].find((j) => j.label === rm[1] || j.id === rm[1]);
      if (!rec) { res.writeHead(404); res.end(JSON.stringify({ error: "unknown taskId" })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(jobs.result(rec.id)));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err) {
    log({ event: "http_error", path: url.pathname, error: String(err.message ?? err) });
    if (!res.headersSent) res.writeHead(500);
    res.end(JSON.stringify({ error: String(err.message ?? err) }));
  }
});

// Auto-start only when run directly; importing from tests must not bind :8814.
const isMain = !!process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain || process.env.HUBBLE_RESEARCH_FORCE_LISTEN === "1") {
  server.listen(PORT, () => {
    log({ event: "listening", port: PORT, model: RESEARCH_MODEL, searxng: SEARXNG_BASE, firecrawl: FIRECRAWL_BASE, dmz: DMZ_BASE, maxRounds: MAX_ROUNDS });
  });
}
