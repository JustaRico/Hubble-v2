/**
 * Hubble Design Bureau (Phase 10) — Planner + parallel Builders + synthesis.
 *
 * Flow, per spec section "Design Bureau":
 *  1. POST /design {task} -> taskId immediately (JobUtility)
 *  2. Planner produces TWO Zod-validated handoff payloads (Designer, Coder).
 *     Payloads carry task id + role instructions + governed context slice —
 *     never raw conversation history.
 *  3. Both builders run in PARALLEL via Promise.allSettled with a per-branch
 *     timeout, each producing an artifact string.
 *  4. Artifacts are written to the copyparty DMZ by HTTP PUT
 *     (/dmz/bureau/<taskId>/design.md and /code.js). The return trip carries
 *     only condensed references: {"status","artifact"} — never the content.
 *  5. Synthesis runs once both settle; partial results are acknowledged,
 *     never silently dropped.
 *
 * Single-machine run: everything on localhost via LiteLLM :14000. No graph
 * framework — two fixed branches joined once is a small allSettled problem.
 */
import http from "node:http";
import crypto from "node:crypto";
import { z } from "zod";
import { JobUtility } from "./job-utility/index.mjs";

// Auto-start only when run directly — importing this module from tests must
// not bind the port. Use Node's official pathToFileURL for correct comparison.
import { pathToFileURL } from "node:url";
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;



const PORT = Number(process.env.HUBBLE_DESIGN_BUREAU_PORT ?? 8813);
const LITELLM_URL = process.env.LITELLM_URL ?? "http://localhost:14000/v1";
const LITELLM_KEY = process.env.LITELLM_MASTER_KEY ?? "";
const PLANNER_MODEL = process.env.HUBBLE_PLANNER_MODEL ?? "planner-model";
const CODER_MODEL = process.env.HUBBLE_CODER_MODEL ?? "coder-model";
const DESIGNER_MODEL = process.env.HUBBLE_DESIGNER_MODEL ?? "designer-model";
const DMZ_BASE = process.env.HUBBLE_DMZ_URL ?? "http://localhost:13923/dmz";
const DMZ_USER = process.env.HUBBLE_DMZ_USER ?? "hubble";
const DMZ_PASS = process.env.HUBBLE_DMZ_PASS ?? "hubble-dev-pass";
// per-branch timeout; default matches JobUtility's own hard timeout scale
const BRANCH_TIMEOUT_MS = Number(process.env.HUBBLE_BUREAU_BRANCH_TIMEOUT_MS ?? 300000);
const ALLOW_TEST_CONTROLS = (process.env.HUBBLE_ALLOW_TEST_CONTROLS ?? "false") === "true";

const jobs = new JobUtility({ defaultTimeoutMs: BRANCH_TIMEOUT_MS });

/** ── Zod handoff payload schemas (spec: validated structured JSON) ────────── */
export const HandoffSchema = z.object({
  taskId: z.string().min(1),
  role: z.enum(["designer", "coder"]),
  instructions: z.string().min(1),
  contextSlice: z.object({
    task_summary: z.string(),
    requirements: z.array(z.string()).default([]),
    target_language: z.string().optional(),
    constraints: z.array(z.string()).default([]),
  }),
});
export const BuilderResultSchema = z.object({
  status: z.enum(["success", "failed", "timeout"]),
  artifact: z.string().describe("DMZ path of the artifact, or empty when failed"),
});
export const SynthesisSchema = z.object({
  status: z.enum(["complete", "partial"]),
  summary: z.string().min(1),
  artifacts: z.record(z.string(), z.string()).describe("role -> DMZ path"),
});

function log(entry) {
  console.log(`[bureau] ${JSON.stringify({ ts: new Date().toISOString(), ...entry })}`);
}

/** One LiteLLM chat call. Returns message content (may throw). */
async function chat(model, messages, maxTokens = 2000) {
  const res = await fetch(`${LITELLM_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LITELLM_KEY}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(BRANCH_TIMEOUT_MS - 5000),
  });
  if (!res.ok) throw new Error(`${model} HTTP ${res.status}`);
  const body = await res.json();
  const content = body.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) throw new Error(`${model} returned empty content`);
  return content;
}

/**
 * Planner: derive two handoff payloads from the user's complex task.
 * Test controls can bypass this with deterministic payloads.
 */
async function makeHandoffs(taskId, task, forced) {
  if (forced?.handoffs) return forced.handoffs;
  if (forced?.skipPlanner) {
    // simple deterministic split without an LLM round-trip
    return {
      designer: HandoffSchema.parse({
        taskId, role: "designer",
        instructions: `Sketch the UI layout for this task and save it as markdown:\n${task}`,
        contextSlice: { task_summary: task.slice(0, 200), requirements: [] },
      }),
      coder: HandoffSchema.parse({
        taskId, role: "coder",
        instructions: `Write a JavaScript implementation for this task and save it as code:\n${task}`,
        contextSlice: { task_summary: task.slice(0, 200), requirements: [], target_language: "javascript" },
      }),
    };
  }
  const raw = await chat(PLANNER_MODEL, [
    {
      role: "system",
      content:
        "You are the Hubble Design Bureau Planner. Split a complex task into exactly two " +
        "independent work packages for subagents who know nothing else about the request.\n" +
        'Reply with ONLY JSON: {"designer": {...}, "coder": {...}} where each object has ' +
        '"instructions" (string, what to produce), "contextSlice" (object with task_summary, ' +
        "requirements array, optional target_language, constraints array).\n" +
        "The DESIGNER produces a UI/UX layout document (markdown). The CODER produces working " +
        "JavaScript code. Neither talks to the other.",
    },
    { role: "user", content: task },
  ], 2500);
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim().match(/\{[\s\S]*\}/)[0]);
  } catch {
    throw new Error(`planner output unparseable: ${raw.slice(0, 150)}`);
  }
  return {
    designer: HandoffSchema.parse({
      taskId, role: "designer", instructions: String(parsed.designer?.instructions ?? ""),
      contextSlice: parsed.designer?.contextSlice ?? { task_summary: task },
    }),
    coder: HandoffSchema.parse({
      taskId, role: "coder", instructions: String(parsed.coder?.instructions ?? ""),
      contextSlice: parsed.coder?.contextSlice ?? { task_summary: task },
    }),
  };
}

async function runBuilder(handoff, forced) {
  const model = handoff.role === "coder" ? CODER_MODEL : DESIGNER_MODEL;
  if (forced?.builderTimeout === handoff.role || forced?.builderTimeout === "both") {
    await new Promise((r) => setTimeout(r, BRANCH_TIMEOUT_MS + 60000));
    return null; // unreachable if JobUtility kills us first
  }
  if (forced?.builderFail === handoff.role) throw new Error("forced failure (test control)");
  const prompt =
    handoff.role === "coder"
      ? `${handoff.instructions}\n\nContext: ${JSON.stringify(handoff.contextSlice)}\n` +
        "Return ONLY the complete JavaScript file content, no commentary."
      : `${handoff.instructions}\n\nContext: ${JSON.stringify(handoff.contextSlice)}\n` +
        "Return ONLY the layout document in markdown.";
  return chat(model, [{ role: "user", content: prompt }], handoff.role === "coder" ? 3500 : 2500);
}

/** PUT artifact bytes to the copyparty DMZ; returns the canonical artifact path. */
async function putToDmz(relPath, bodyText) {
  const url = `${DMZ_BASE}/${relPath}`;
  const auth = "Basic " + Buffer.from(`${DMZ_USER}:${DMZ_PASS}`).toString("base64");
  let res;
  try {
    res = await fetch(url, {
      method: "PUT", headers: { authorization: auth, "content-type": "text/plain" },
      body: bodyText, signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new Error(`DMZ PUT failed: ${err.message}`);
  }
  // 201 created / 204 overwritten both count; also accept 200 (copyparty quirk)
  if (![200, 201, 204].includes(res.status)) {
    throw new Error(`DMZ PUT HTTP ${res.status} for ${relPath}`);
  }
  return `/dmz/${relPath}`;
}

async function getFromDmz(relPath) {
  const auth = "Basic " + Buffer.from(`${DMZ_USER}:${DMZ_PASS}`).toString("base64");
  const res = await fetch(`${DMZ_BASE}/${relPath}`, {
    headers: { authorization: auth }, signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`DMZ GET ${res.status}`);
  return res.text();
}

/** The actual bureau run: plan -> fan out -> join -> synthesize. */
async function orchestrate(taskId, task, forced) {
  log({ event: "plan_start", taskId });
  const handoffs = await makeHandoffs(taskId, task, forced);
  log({ event: "handoffs_built", taskId, roles: Object.keys(handoffs) });

  // Promise.allSettled — neither branch should reject its sibling; each is
  // individually wrapped in a JobUtility job (hard timeout + validation).
  // NOTE: jobs.start() returns the id synchronously, not a promise — chain
  // through Promise.resolve().then().
  const branch = (role) => async () => {
    const handoff = role === "coder" ? handoffs.coder : handoffs.designer;
    const jobId = jobs.start(() => runBuilder(handoff, forced), {
      schema: z.string(), timeoutMs: BRANCH_TIMEOUT_MS, label: `${taskId}:${role}`,
    });
    const terminal = await jobs.waitForTerminal(jobId, { timeoutMs: BRANCH_TIMEOUT_MS + 1000 });
    if (terminal !== "done") throw new Error(`${role} ${terminal}`);
    return jobs.result(jobId);
  };
  const settled = await Promise.allSettled([branch("designer")(), branch("coder")()]);

  /** Condensed reference shape ONLY — content stays in the DMZ (spec). */
  const results = {};
  const artifacts = {};
  const roles = ["designer", "coder"];
  for (let i = 0; i < roles.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      const relPath = `bureau/${taskId}/${roles[i]}.${roles[i] === "coder" ? "js" : "md"}`;
      try {
        artifacts[roles[i]] = await putToDmz(relPath, outcome.value);
        results[roles[i]] = BuilderResultSchema.parse({ status: "success", artifact: artifacts[roles[i]] });
      } catch (err) {
        log({ event: "dmz_put_failed", taskId, role: roles[i], error: err.message });
        results[roles[i]] = BuilderResultSchema.parse({ status: "failed", artifact: "" });
      }
    } else {
      log({ event: "branch_failed", taskId, role: roles[i], reason: String(outcome.reason?.message ?? outcome.reason) });
      results[roles[i]] = BuilderResultSchema.parse({ status: "failed", artifact: "" });
    }
  }

  const anySuccess = Object.values(results).some((r) => r.status === "success");
  if (!anySuccess) throw new Error("both builder branches failed");

  // Synthesis: read back only through DMZ references; keep summary condensed.
  const okRoles = roles.filter((r) => results[r].status === "success");
  const digestParts = [];
  for (const r of okRoles) {
    const text = forced?.synthDigests?.[r]
      ?? (await getFromDmz(artifacts[r].replace("/dmz/", ""))).slice(0, 400);
    digestParts.push(`[${r}] ${text.slice(0, 120).replace(/\n/g, " ")}...`);
  }
  const synthesis = SynthesisSchema.parse({
    status: okRoles.length === 2 ? "complete" : "partial",
    summary:
      `Task "${task.slice(0, 80)}". Branches: ` +
      roles.map((r) => `${r}=${results[r].status}${results[r].artifact ? ` (${results[r].artifact})` : ""}`).join(", ") +
      ". Digests: " + digestParts.join(" | "),
    artifacts,
  });
  log({ event: "synthesized", taskId, status: synthesis.status });
  return synthesis;
}

let _testForced = {}; // test control

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", activeJobs: [...jobs.jobs.values()].filter((j) => j.status === "running").length }));
      return;
    }

    if (ALLOW_TEST_CONTROLS && req.method === "POST" && url.pathname === "/_test/set-controls") {
      let raw = ""; for await (const c of req) raw += c;
      _testForced = JSON.parse(raw || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, controls: _testForced }));
      return;
    }
    if (ALLOW_TEST_CONTROLS && req.method === "POST" && url.pathname === "/_test/reset") {
      _testForced = {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/design") {
      let raw = ""; for await (const c of req) raw += c;
      const { task } = JSON.parse(raw || "{}");
      if (!task?.trim()) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "task is required" }));
        return;
      }
      const taskId = `desk-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
      const jobId = jobs.start(
        () => orchestrate(taskId, task, { ..._testForced }),
        {
          schema: SynthesisSchema,
          timeoutMs: Math.max(BRANCH_TIMEOUT_MS * 2, 60000),
          label: taskId,
        },
      );
      log({ event: "accepted", taskId, jobId });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ taskId, jobId }));
      return;
    }

    const statusMatch = url.pathname.match(/^\/design\/([\w-]+)$/);
    if (req.method === "GET" && statusMatch && statusMatch[1] !== "health") {
      // Accept either desk-<ts> ids or jobId lookups
      const want = statusMatch[1];
      let rec = [...jobs.jobs.values()].find((j) => j.label === want || j.id === want);
      if (!rec) { res.writeHead(404); res.end(JSON.stringify({ error: "unknown taskId" })); return; }
      const snap = jobs.status(rec.id);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(snap));
      return;
    }
    const resultMatch = url.pathname.match(/^\/design\/([\w-]+)\/result$/);
    if (req.method === "GET" && resultMatch) {
      const rec = [...jobs.jobs.values()].find((j) => j.label === resultMatch[1] || j.id === resultMatch[1]);
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

if (isMain || process.env.HUBBLE_BUREAU_FORCE_LISTEN === "1") {
  server.listen(PORT, () => {
    log({ event: "listening", port: PORT, dmz: DMZ_BASE, planner: PLANNER_MODEL, coder: CODER_MODEL, designer: DESIGNER_MODEL, branchTimeoutMs: BRANCH_TIMEOUT_MS });
  });
}

// Shared export used by node --test contract tests (pure functions)
export { orchestrate, putToDmz };
