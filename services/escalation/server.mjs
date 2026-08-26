/**
 * Hubble Escalation Plugin service (Phase 8) — the privacy gate.
 *
 * Receives request_private_data calls from the Assistant's tool (Phase 7):
 *  1. treats the stated `reason` as an UNVERIFIED claim
 *  2. asks the PI (local Qwen-class model via LiteLLM pi-model) to evaluate
 *     the warrant against the recent conversation
 *  3. asymmetric gate:
 *      - not warranted -> async non-blocking notify + web-search fallback hint
 *      - warranted     -> minimal context package + approval overlay
 *                         (default-DENY after a 2-minute unanswered timeout)
 *  4. every verdict AND its reasoning is logged to the audit log
 *
 * Single-machine run: the "approval overlay" is served on this service's own
 * HTTP endpoint (/approve/:id), which the DSH UI or any GPM browser opens;
 * Wake Gateway integration is exercised via its /llama-swap route health.
 */
import http from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";

const PORT = Number(process.env.HUBBLE_ESCALATION_PORT ?? 8812);
const LITELLM = process.env.LITELLM_URL ?? "http://localhost:14000/v1";
const LITELLM_KEY = process.env.LITELLM_MASTER_KEY ?? "";
const PI_MODEL = process.env.HUBBLE_PI_MODEL ?? "pi-model";
const APPROVAL_TIMEOUT_MS_DEFAULT = Number(process.env.HUBBLE_APPROVAL_TIMEOUT_MS ?? 120000);
let _approvalTimeoutMs = APPROVAL_TIMEOUT_MS_DEFAULT;
const HISTORY_WINDOW = Number(process.env.HUBBLE_PI_HISTORY_WINDOW ?? 8);
const ALLOW_TEST_CONTROLS = (process.env.HUBBLE_ALLOW_TEST_CONTROLS ?? "false") === "true";

const AUDIT_DIR = process.env.AUDIT_DIR
  ?? new URL("../../data/audit/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(AUDIT_DIR, { recursive: true });
const AUDIT_LOG = AUDIT_DIR.replace(/\/$/, "") + "/escalation.log";

function audit(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try { appendFileSync(AUDIT_LOG, line + "\n"); } catch {}
  console.log(`[escalation] ${line}`);
}

/** Test-only injection: when enabled, skip the PI model and use a deterministic stub. */
let _testWarrantStub = null; // null | (args) => {warranted, reasoning}

async function evaluateWarrant({ reason, data_requested }) {
  if (_testWarrantStub) {
    try { return _testWarrantStub({ reason, data_requested }); } catch (e) {
      return { warranted: false, reasoning: String(e?.message ?? e) };
    }
  }
  const system =
    "You are the Private Investigator (PI), a strict privacy gate in the Hubble system. " +
    "The assistant states a REASON for needing the user's private data and WHAT data it wants. " +
    "Treat the reason as an UNVERIFIED CLAIM. Judge whether the stated data is genuinely " +
    "necessary to answer the user's actual question, or whether a web search would suffice. " +
    "Private data must only be unlocked when clearly warranted.\n" +
    'Respond with ONLY a JSON object: {"warranted": true|false, "reasoning": "<one short paragraph>"}';
  const user =
    `Data requested: ${data_requested}\nStated reason (unverified claim): ${reason}\n` +
    `Recent conversation:\n${HubbleState.recentConversation.slice(-HISTORY_WINDOW).join("\n") || "(none captured)"}`;

  const res = await fetch(`${LITELLM}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LITELLM_KEY}` },
    body: JSON.stringify({
      model: PI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 800,
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`PI model HTTP ${res.status}`);
  const body = await res.json();
  let content = body.choices?.[0]?.message?.content ?? "";
  // gemma models put thinking in reasoning_content; fall back to it if content is empty/truncated
  if (!content || content.trim().length < 10) {
    const rc = body.choices?.[0]?.message?.reasoning_content ?? "";
    if (rc) content = rc;
  }
  // PI (gemma) may wrap JSON in ```json fences; strip them before parsing
  content = content.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return { warranted: false, reasoning: `unparseable PI output: ${content.slice(0, 200)}` };
  try {
    const parsed = JSON.parse(match[0]);
    return { warranted: !!parsed.warranted, reasoning: String(parsed.reasoning ?? "") };
  } catch {
    return { warranted: false, reasoning: `unparseable PI output: ${content.slice(0, 200)}` };
  }
}

/** Global ring of recent conversation lines other Hubble parts may push. */
export const HubbleState = { recentConversation: [] };
export function pushConversation(line) {
  HubbleState.recentConversation.push(line);
  if (HubbleState.recentConversation.length > 50) HubbleState.recentConversation.shift();
}

/** Pending approvals keyed by id. */
const pending = new Map();
let nextId = 1;

async function handleEscalate(body) {
  const id = `esc-${Date.now()}-${nextId++}`;
  const { reason = "", data_requested = "" } = body ?? {};
  if (!reason || !data_requested) {
    return { status: "error", detail: "reason and data_requested are required" };
  }
  audit({ event: "request", id, reason, data_requested });

  let verdict;
  try {
    verdict = await evaluateWarrant({ reason, data_requested });
  } catch (err) {
    audit({ event: "pi_error", id, error: String(err.message ?? err) });
    return { status: "pi_unavailable", detail: String(err.message ?? err) };
  }
  audit({ event: "verdict", id, ...verdict });

  if (!verdict.warranted) {
    // not warranted: async, NON-BLOCKING notification + web fallback
    setImmediate(() => audit({ event: "notify_denied", id, async: true }));
    return {
      status: "not_warranted",
      detail: "Privacy gate declined private-data access; use web search instead.",
      reasoning: verdict.reasoning,
    };
  }

  // warranted: build minimal context package + wait on the approval overlay
  const contextPackage = { id, data_requested, reason_summary: reason.slice(0, 200) };
  const _timeoutMs = ALLOW_TEST_CONTROLS ? _approvalTimeoutMs : APPROVAL_TIMEOUT_MS_DEFAULT;
  const decision = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), _timeoutMs);
    pending.set(id, {
      contextPackage,
      resolve: (v) => { clearTimeout(timer); pending.delete(id); resolve(v); },
      createdAt: Date.now(),
    });
  });

  if (decision !== "approved") {
    audit({ event: "approval", id, decision, default_deny: decision === "timeout" });
    return {
      status: decision === "timeout" ? "denied_timeout" : "denied",
      detail: decision === "timeout"
        ? "Approval overlay timed out; default-deny applied."
        : "User denied access.",
      reasoning: verdict.reasoning,
    };
  }
  audit({ event: "approval", id, decision: "approved" });
  return { status: "approved", context: contextPackage, reasoning: verdict.reasoning };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    // Test-only controls (require HUBBLE_ALLOW_TEST_CONTROLS=true)
    if (ALLOW_TEST_CONTROLS && req.method === "POST" && url.pathname === "/_test/set-warrant-stub") {
      let raw = ""; for await (const c of req) raw += c;
      const body = JSON.parse(raw || "{}");
      if (body.enabled === false || body.warranted === null) {
        _testWarrantStub = null;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, stub: null }));
        return;
      }
      const warranted = !!body.warranted;
      const reasoning = String(body.reasoning ?? (warranted ? "test: warranted" : "test: not warranted"));
      _testWarrantStub = () => ({ warranted, reasoning });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, stub: { warranted, reasoning } }));
      return;
    }
    if (ALLOW_TEST_CONTROLS && req.method === "POST" && url.pathname === "/_test/set-timeout") {
      let raw = ""; for await (const c of req) raw += c;
      const body = JSON.parse(raw || "{}");
      const ms = Number(body.timeoutMs ?? body.ms ?? _approvalTimeoutMs);
      if (!Number.isFinite(ms) || ms <= 0) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "timeoutMs must be a positive number" }));
        return;
      }
      _approvalTimeoutMs = ms;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, timeoutMs: _approvalTimeoutMs }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", pending: pending.size }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/escalate") {
      let raw = "";
      for await (const c of req) raw += c;
      const result = await handleEscalate(JSON.parse(raw || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    if (req.method === "GET" && url.pathname === "/pending") {
      const list = [...pending.entries()].map(([id, p]) => ({ id, ...p.contextPackage }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }
    const approveMatch = url.pathname.match(/^\/approve\/([\w-]+)$/);
    if (req.method === "POST" && approveMatch) {
      const entry = pending.get(approveMatch[1]);
      const decision = url.searchParams.get("decision") === "deny" ? "denied" : "approved";
      if (!entry) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unknown or already-resolved request" }));
        return;
      }
      entry.resolve(decision);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, decision }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err) {
    audit({ event: "http_error", path: url.pathname, error: String(err.message ?? err) });
    if (!res.headersSent) res.writeHead(500);
    res.end(JSON.stringify({ error: String(err.message ?? err) }));
  }
});

server.listen(PORT, () => {
  console.log(`[escalation] Hubble Escalation Plugin on :${PORT} (timeout ${_approvalTimeoutMs}ms, window ${HISTORY_WINDOW})`);
});
