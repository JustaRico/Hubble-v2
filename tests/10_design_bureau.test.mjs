/**
 * Phase 10 — Design Bureau contract tests (node --test, deterministic).
 * Stubs both the LiteLLM chat endpoint and the DMZ PUT/GET via global fetch,
 * so assertions are pure contract checks — no live LLM, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { orchestrate } from "../services/design-bureau/server.mjs";

function makeForced({ designerOk = true, coderOk = true } = {}) {
  return {
    skipPlanner: true,
    builderFail: !designerOk ? "designer" : !coderOk ? "coder" : null,
    synthDigests: {
      designer: "Layout: header + temp display + refresh button",
      coder: "IIFE registering a 5s polling interval for GPU temperature",
    },
  };
}

function installStubFetch({ bigArtifact = false } = {}) {
  const realFetch = globalThis.fetch;
  const seen = { puts: 0, gets: 0 };
  const fake = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/dmz/bureau/") && (opts.method ?? "GET") === "PUT") {
      seen.puts += 1;
      return new Response(null, { status: 201 });
    }
    if (u.includes("/dmz/bureau/")) {
      seen.gets += 1;
      return new Response(bigArtifact ? "x".repeat(400) : "stub artifact content", { status: 200 });
    }
    if (u.includes(":14000/v1/chat/completions")) {
      if (bigArtifact) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "x".repeat(5000) } }] }),
          { status: 200 },
        );
      }
      const body = JSON.parse(String(opts.body ?? "{}"));
      const userMsg = body.messages?.[0]?.content ?? "";
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: userMsg.includes("JavaScript") ? "// coder artifact" : "# designer artifact" } }],
        }),
        { status: 200 },
      );
    }
    throw new Error("unexpected fetch in test: " + u);
  };
  globalThis.fetch = fake;
  return { seen, restore: () => { globalThis.fetch = realFetch; } };
}

test("[c5] both branches succeed -> synthesis references both artifacts", async () => {
  const stub = installStubFetch();
  try {
    const synth = await orchestrate("t-c5", "Build X", makeForced({}));
    assert.equal(synth.status, "complete");
    assert.match(synth.artifacts.designer, /^\/dmz\/bureau\/.*designer\.md$/);
    assert.match(synth.artifacts.coder, /^\/dmz\/bureau\/.*coder\.js$/);
    assert.equal(stub.seen.puts, 2, "both artifacts PUT to DMZ exactly once each");
    // digest reads go through forced.synthDigests when provided, so no GET here
    assert.ok(synth.summary.includes("[designer]") && synth.summary.includes("[coder]"));
  } finally {
    stub.restore();
  }
});

test("[c6] forced branch failure -> synthesis completes as partial and does not hang", async () => {
  const stub = installStubFetch();
  try {
    const t0 = Date.now();
    const synth = await orchestrate("t-c6", "Build Y", makeForced({ coderOk: false }));
    const elapsed = Date.now() - t0;
    assert.equal(synth.status, "partial", "one branch failed -> partial");
    assert.ok(elapsed < 60000, `synthesis must not hang past hard timeout (took ${elapsed}ms)`);
    assert.equal(synth.artifacts.coder, undefined, "failed branch has no artifact path");
    assert.match(synth.summary, /coder=failed/);
    assert.ok(synth.artifacts.designer, "successful branch still yields its artifact");
  } finally {
    stub.restore();
  }
});

test("[c7] return shape carries only condensed references, never raw code blobs", async () => {
  const stub = installStubFetch({ bigArtifact: true });
  try {
    const synth = await orchestrate("t-c7", "Build Z", makeForced({}));
    const json = JSON.stringify(synth);
    assert.doesNotMatch(json, /x{100,}/, "no raw generated code blob may be inlined");
    for (const v of Object.values(synth.artifacts)) {
      assert.match(v, /^\/dmz\/bureau\//, `artifact value is a reference path: ${v}`);
      assert.ok(v.length < 120);
    }
    // digest slices are capped at 120 chars each in the summary
    assert.ok(json.length < 2500, `synthesis JSON stays condensed (got ${json.length} bytes)`);
  } finally {
    stub.restore();
  }
});
