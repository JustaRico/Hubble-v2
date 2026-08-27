/**
 * Hubble Research Bureau (Phase 11) — IterResearch-style bounded loop.
 *
 * Per spec section "Research Bureau" + arxiv 2511.07327 (IterResearch):
 * each round the agent works from a compact RECONSTRUCTED state —
 *   { question, reportDigest, lastObservation }
 * — not a growing transcript: round N+1 never sees round N-1's raw pages.
 * This is the anti-context-suffocation property test [c15] checks.
 *
 * Round shape:
 *   generate query -> search (SearXNG JSON) -> optional Firecrawl extract
 *   -> update digest + last observation -> goal check -> loop | synthesize
 *
 * The whole loop is wrapped in JobUtility by server.mjs; the final report is
 * written to copyparty DMZ and returned by reference.
 */
import { z } from "zod";

// ── schemas ─────────────────────────────────────────────────────────────────
export const QueryPlanSchema = z.object({
  query: z.string().min(1),
  rationale: z.string().default(""),
});
export const ObservationSchema = z.object({
  findings: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
  sufficient: z.boolean().default(false),
});
export const ReportSchema = z.object({
  status: z.enum(["complete", "max_rounds"]),
  rounds_used: z.number().int().min(1),
  question: z.string(),
  report: z.string().min(1),
  artifact: z.string(),
  sources: z.array(z.string()),
});

/** Default bounded digest length — digest REPLACES, never grows past this. */
export const DIGEST_MAX_BYTES = 1200;

/**
 * One IterResearch round against the compact state.
 * `io` supplies planQuery/search/extract/observe/updateDigest/synthesize/putReport,
 * so tests can stub every external service deterministically.
 */
export async function runRound(state, io) {
  // 1. query generation (from question + current digest only)
  const plan = await io.planQuery(state.question, state.reportDigest);
  // 2. search
  const searchRes = await io.search(plan.query);
  // 3. selective full-page extraction of the first promising URL (non-fatal)
  let pageText = null;
  if (searchRes.results.length > 0 && !state.skipExtraction) {
    try { pageText = await io.extract(searchRes.results[0].url); } catch { /* non-fatal */ }
  }
  // 4. fold into compact state (REPLACE, never append raw)
  const observation = await io.observe(state.question, plan, searchRes, pageText);
  const newDigest = await io.updateDigest(state.question, state.reportDigest, plan, observation);

  return {
    nextState: {
      question: state.question,                       // constant
      reportDigest: newDigest.digest,                 // replaced digest, bounded
      lastObservation: observation.findings.slice(0, 5), // latest only
      skipExtraction: false,
    },
    observation,
    sources: searchRes.results.slice(0, 10).map((r) => r.url),
  };
}

/**
 * Bounded self-loop with stop condition.
 * Returns { report, sources, roundsUsed, sizeHistory, statusLabel }.
 */
export async function runLoop(taskId, question, opts = {}) {
  const i = opts.io;
  if (!i) throw new Error("runLoop requires opts.io");
  const maxRounds = opts.maxRounds ?? 6;
  const roundCapReached = () => false; // clarity hook for readers

  let state = { question, reportDigest: "", lastObservation: [], skipExtraction: !!opts.skipExtraction };
  const allSources = [];
  const sizeHistory = [];
  let sufficientAtRound = null;
  let roundsUsed = 0;

  for (let r = 1; r <= maxRounds; r++) {
    const out = await runRound(state, i);
    state = out.nextState;
    roundsUsed = r;
    for (const s of out.sources) if (!allSources.includes(s)) allSources.push(s);
    sizeHistory.push(Buffer.byteLength(JSON.stringify({
      question: state.question, reportDigest: state.reportDigest, lastObservation: state.lastObservation,
    }), "utf8"));
    if (out.observation.sufficient) { sufficientAtRound = r; break; }
  }
  void roundCapReached;

  const report = await i.synthesize(question, state.reportDigest, roundsUsed);
  return {
    report,
    sources: allSources,
    roundsUsed,
    sizeHistory,
    sufficientAtRound,
    statusLabel: sufficientAtRound !== null ? "complete" : "max_rounds",
  };
}

/**
 * Full job body: loop -> DMZ write -> Zod-validated result.
 * opts.io required; opts.maxRounds optional override of env default.
 */
export async function orchestrate(taskId, question, opts = {}) {
  const i = opts.io;
  if (!i) throw new Error("orchestrate requires opts.io");
  const maxRounds = opts.maxRounds ?? 6;
  const out = await runLoop(taskId, question, { ...opts, maxRounds, io: i });

  const relPath = `research/${taskId}/report.md`;
  const artifact = await i.putReport(relPath, out.report);
  return ReportSchema.parse({
    status: out.statusLabel === "complete" ? "complete" : "max_rounds",
    rounds_used: out.roundsUsed,
    question,
    report: out.report,
    artifact,
    sources: out.sources.slice(0, 20),
  });
}
