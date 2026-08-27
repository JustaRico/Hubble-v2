/**
 * Default IO surface for the Research Bureau: real LiteLLM, SearXNG,
 * Firecrawl and copyparty DMZ calls behind ONE injectable object
 * (io.planQuery / io.search / io.extract / io.observe / io.updateDigest /
 *  io.synthesize / io.putReport) so contract tests can stub everything.
 */
import { DIGEST_MAX_BYTES } from "./loop.mjs";

export function makeDefaultIo(cfg) {
  const auth = "Basic " + Buffer.from(`${cfg.dmzUser}:${cfg.dmzPass}`).toString("base64");

  async function chat(messages, maxTokens = 1200) {
    const res = await fetch(`${cfg.litellmUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.litellmKey}` },
      body: JSON.stringify({ model: cfg.researchModel, messages, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(Math.max(cfg.roundTimeoutMs - 5000, 30000)),
    });
    if (!res.ok) throw new Error(`research-model HTTP ${res.status}`);
    const body = await res.json();
    const content = body.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) throw new Error("research-model returned empty content");
    return content;
  }

  /** Parse a JSON object out of a possibly-fenced model reply; null on failure. */
  function parseJson(raw) {
    try {
      const m = raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim().match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : null;
    } catch { return null; }
  }

  return {
    /** Turn question + digest into the next search query. */
    async planQuery(question, digest) {
      const raw = await chat([
        { role: "system", content:
          "You are the Hubble Research Bureau query planner. Given the research question and " +
          "the current report digest, output ONLY JSON: {\"query\": \"<web search query>\", \"rationale\": \"<one line>\"}. " +
          "Pick a query that fills the biggest gap in the digest. If the digest says no evidence was " +
          "found yet, try a DIFFERENT, simpler or better-known phrasing of the question." },
        { role: "user", content: `Question: ${question}\nDigest so far: ${digest || "(empty)"}` },
      ], 400);
      const parsed = parseJson(raw);
      if (parsed?.query) return parsed;
      // deterministic fallbacks: vary the phrasing per attempt so repeated
      // rounds do not repeat a failing query
      const n = (digest.match(/\nNEW:/g) ?? []).length + 1;
      return {
        query: `${question} explained${n > 1 ? ` simple guide part ${n}` : ""}`,
        rationale: "fallback: unparseable planner output",
      };
    },

    /** SearXNG JSON search. Multi-engine with fallback: DuckDuckGo
     * intermittently CAPTCHAs self-hosted instances, so the default
     * !general engine mix can return zero results — pin a resilient set
     * (bing first, wikipedia/google as backups) and verify non-empty. */
    async search(query) {
      const engines = "bing,wikipedia,google,ddg";
      const doSearch = async (q) => {
        const res = await fetch(
          `${cfg.searxngBase}/search?q=${encodeURIComponent(q)}&format=json&engines=${engines}`,
          { signal: AbortSignal.timeout(60000) },
        );
        if (!res.ok) throw new Error(`searxng HTTP ${res.status}`);
        const body = await res.json();
        return {
          query: q,
          results: (body.results ?? []).slice(0, 8).map((r) => ({
            url: r.url, title: r.title ?? "", snippet: (r.content ?? "").slice(0, 300),
          })),
        };
      };
      let out = await doSearch(query);
      if (out.results.length === 0) {
        // zero-result resilience: strip to core terms and retry once
        const stripped = query.replace(/[^a-zA-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
        if (stripped && stripped !== query) out = await doSearch(stripped);
      }
      return out;
    },

    /** Firecrawl full-page markdown extraction for one promising URL. */
    async extract(url) {
      const headers = { "content-type": "application/json" };
      if (cfg.firecrawlKey) headers.authorization = `Bearer ${cfg.firecrawlKey}`;
      const res = await fetch(`${cfg.firecrawlBase}/v2/scrape`, {
        method: "POST", headers,
        body: JSON.stringify({ url, formats: ["markdown"] }),
        signal: AbortSignal.timeout(90000),
      });
      if (!res.ok) throw new Error(`firecrawl HTTP ${res.status}`);
      const body = await res.json();
      return body?.data?.markdown ?? null;
    },

    /** Distill this round's evidence into bounded findings + sufficiency flag. */
    async observe(question, plan, searchRes, pageText) {
      const evidence = [
        ...searchRes.results.slice(0, 5).map((r) => `- ${r.title}: ${r.snippet}`),
        pageText ? `- FULL PAGE (${searchRes.results[0]?.url}): ${pageText.slice(0, 1500)}` : "",
      ].filter(Boolean).join("\n");
      let parsed = null;
      try {
        parsed = parseJson(await chat([
          { role: "system", content:
            "You are the Hubble Research Bureau analyst. From the SEARCH EVIDENCE below output ONLY JSON: " +
            "{\"findings\": [\"...\"], \"sources\": [\"url\"], \"sufficient\": true|false}. " +
            "Extract concrete facts from the evidence — never answer that no evidence exists if any " +
            "snippet or page text is present. sufficient=true only when the evidence fully answers the question." },
          { role: "user", content: `Question: ${question}\nQuery tried: ${plan.query}\nEvidence:\n${evidence}` },
        ], 900));
      } catch { /* falls through to empty observation */ }
      if (!parsed || typeof parsed !== "object") parsed = {};
      // hard-bound findings to keep the reconstructed state compact
      const findings = (Array.isArray(parsed.findings) ? parsed.findings : []).slice(0, 5).map(String);
      // If the model claims no evidence but search results exist, salvage the
      // snippets directly as findings (defends against analyst under-extraction)
      const salvaged = findings.length === 0 && searchRes.results.length > 0
        ? searchRes.results.slice(0, 3).map((r) => `${r.title}: ${r.snippet}`)
        : [];
      return {
        findings: findings.length > 0 ? findings : salvaged,
        sources: (Array.isArray(parsed.sources) ? parsed.sources : []).slice(0, 5).map(String),
        // never declare sufficiency on a round that produced nothing
        sufficient: !!parsed.sufficient && (findings.length > 0 || salvaged.length > 0),
      };
    },

    /**
     * Rebuild the compact report digest. IterResearch property: this REPLACES
     * the previous digest and is hard-bounded, so state can never grow past
     * DIGEST_MAX_BYTES no matter how many rounds run.
     */
    async updateDigest(question, oldDigest, plan, observation) {
      const merged = `${oldDigest}\nNEW: ${observation.findings.join("; ")}`.trim();
      return { digest: merged.length > DIGEST_MAX_BYTES ? merged.slice(-DIGEST_MAX_BYTES) : merged };
    },

    /** Final markdown synthesis of the whole report. */
    async synthesize(question, digest, roundsUsed) {
      return chat([
        { role: "system", content:
          "You are the Hubble Research Bureau writer. Produce the final markdown research report " +
          "(# title, ## sections, cite source URLs inline like [1](url)). Ground every claim in the " +
          "digest; do not invent facts." },
        { role: "user", content: `Question: ${question}\nResearch digest after ${roundsUsed} round(s):\n${digest}` },
      ], 2500);
    },

    /** PUT final report into the DMZ. */
    async putReport(relPath, reportText) {
      const res = await fetch(`${cfg.dmzBase}/${relPath}`, {
        method: "PUT", headers: { authorization: auth, "content-type": "text/markdown" },
        body: reportText, signal: AbortSignal.timeout(30000),
      });
      if (![200, 201, 204].includes(res.status)) throw new Error(`DMZ PUT HTTP ${res.status}`);
      return `/dmz/${relPath}`;
    },
  };
}
