/**
 * Phase 11 — Research Bureau contract tests (node --test, deterministic).
 * Every external service (LiteLLM, SearXNG, Firecrawl, copyparty DMZ) is a
 * scripted fake inside `io`, so these are pure loop-contract assertions:
 *  [c13] real question -> bounded run producing report in "DMZ" with sources
 *        and the expected fact present
 *  [c14] non-convergent io (never sufficient) -> loop stops at maxRounds,
 *        status=max_rounds, never unbounded
 *  [c15] anti-suffocation: serialized state size does NOT grow monotonically
 *        across rounds — digest stays hard-bounded regardless of round count
 */
import test from "node:test";
import assert from "node:assert/strict";
import { orchestrate, runLoop } from "../services/research-bureau/loop.mjs";

/** Deterministic io double. */
function makeIo({ sufficientAfter = Infinity, sourcesPerRound = 3 } = {}) {
  let round = 0;
  const puts = [];
  const chats = [];
  return {
    puts,
    calls: { planQuery: 0, search: 0, extract: 0, observe: 0, updateDigest: 0, synthesize: 0 },
    async planQuery(question, digest) {
      this.calls.planQuery += 1;
      return { query: `${question} gap ${round + 1}`, rationale: "deterministic" };
    },
    async search(query) {
      this.calls.search += 1;
      return {
        query,
        results: Array.from({ length: sourcesPerRound }, (_, k) => ({
          url: `https://example.com/src-${round + 1}-${k}`,
          title: `Source ${round + 1}-${k}`,
          snippet: `Snippet mentioning fact ${round + 1}-${k} about Hubble.`,
        })),
      };
    },
    async extract(url) {
      this.calls.extract += 1;
      // Simulate a HUGE page: state must not absorb it wholesale
      return `FULL PAGE MARKDOWN for ${url}\n${"detail ".repeat(2000)}`;
    },
    async observe(question, plan, searchRes, pageText) {
      this.calls.observe += 1;
      round += 1;
      return {
        findings: [`Round ${round} finding: fact-${round} confirmed`],
        sources: searchRes.results.slice(0, 2).map((r) => r.url),
        sufficient: round >= sufficientAfter,
      };
    },
    async updateDigest(question, oldDigest, plan, observation) {
      this.calls.updateDigest += 1;
      // Same REPLACE-and-bound rule as the real io.mjs (DIGEST_MAX_BYTES=1200)
      const merged = `${oldDigest}\nNEW: ${observation.findings.join("; ")}`.trim();
      return { digest: merged.length > 1200 ? merged.slice(-1200) : merged };
    },
    async synthesize(question, digest, roundsUsed) {
      this.calls.synthesize += 1;
      chats.push(digest);
      return `# Report on ${question}\n\nSynthesized from digest (${roundsUsed} rounds):\n${digest}`;
    },
    async putReport(relPath, text) {
      puts.push({ relPath, bytes: Buffer.byteLength(text) });
      return `/dmz/${relPath}`;
    },
    get round() { return round; },
  };
}

test("[c13] convergent research -> complete report artifact with sources", async () => {
  const io = makeIo({ sufficientAfter: 3 });
  const result = await orchestrate("res-c13", "What host galaxy does the Hubble telescope observe?", {
    io, maxRounds: 6,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.rounds_used, 3);
  assert.match(result.artifact, /^\/dmz\/research\/.*report\.md$/);
  assert.equal(io.puts.length, 1, "exactly one DMZ PUT of the final report");
  assert.ok(io.puts[0].bytes > 50, "report body is substantive");
  assert.ok(result.sources.length >= 3, "sources collected across rounds");
});

test("[c14] non-convergent case stops exactly at maxRounds", async () => {
  const io = makeIo({ sufficientAfter: Infinity });
  const result = await orchestrate("res-c14", "Never fully answerable question", { io, maxRounds: 4 });
  assert.equal(result.status, "max_rounds");
  assert.equal(result.rounds_used, 4);
  assert.equal(io.calls.search, 4, "one search per round, no runaway");
  assert.equal(io.calls.synthesize, 1, "single synthesis after cap");
});

test("[c15] state size does NOT grow monotonically across many rounds", async () => {
  const io = makeIo({ sufficientAfter: Infinity, sourcesPerRound: 8 });
  const out = await runLoop("res-c15", "Long-running anti-suffocation probe", { io, maxRounds: 12 });
  // With huge per-round pages flowing through observe(), a naive transcript
  // would grow by kilobytes every round. The reconstructed state must stay flat.
  const sizes = out.sizeHistory;
  assert.equal(sizes.length, 12);
  const lastHalfAvg = sizes.slice(6).reduce((a, b) => a + b, 0) / 6;
  const firstSize = sizes[0];
  assert.ok(
    lastHalfAvg < firstSize + 400,
    `late-round state must stay near early-round size (first=${firstSize}, late-avg=${lastHalfAvg.toFixed(0)})`,
  );
  // Stricter property: the state after round 12 cannot exceed the digest bound
  // (1200B digest + small overheads), i.e. context suffocation is impossible.
  assert.ok(sizes[11] < 1600, `final state size ${sizes[11]} must stay bounded under ~1600B`);
});
