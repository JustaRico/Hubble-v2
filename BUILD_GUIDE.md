# Hubble Build Guide — Step-by-Step Construction & Test Plan

*Companion to `Hubble_2.0.md` — read that document first for what each component is and why it exists; this document is how to actually build it, in order, with a regression test added at every step. All commands below target the single Workstation machine (RTX 4080 Super, 64GB RAM) for ease of testing — see "Multi-Machine Split" at the end for what changes when the Homelab-tier services move to their own box.*

## How to use this guide

Each phase below has five parts:
- **What to build** — the concrete artifact (container, config file, plugin).
- **How it should function** — the behavior contract.
- **Definition of done** — the observable condition that proves it works.
- **Tests to add now** — new files added to `tests/`, permanently.
- **Integration point** — what it depends on, and what will depend on it.

**The regression rule, stated once, applied every phase:** every phase adds one new file to `tests/`. `./run_tests.sh` always runs *every* test file that exists so far, in order, from phase 1 onward — never just the newest one. A phase is not complete until `./run_tests.sh` is fully green. If a later phase breaks an earlier test, that is a regression and it blocks moving on, full stop.

**Test tooling:** infra-level checks (is a container up, does an HTTP endpoint respond correctly) are plain bash + `curl` + `jq`, one script per test, exiting non-zero on failure. Plugin/logic-level checks (Cordis plugin behavior, Zod schema validation, the Wake Gateway's shared-state logic) are TypeScript, run via `node --test`, matching DSH's own ecosystem. Both are invoked by the same `run_tests.sh`.

```
Hubble-v2/
├── docker-compose.single-machine.yml   # phase 13 combines everything below onto one host
├── docker-compose.homelab.yml          # future split target
├── docker-compose.workstation.yml      # future split target
├── install-workstation.sh              # phase 13
├── install-homelab.sh                  # phase 13
├── tests/
│   ├── run_tests.sh
│   ├── 01_dmz.sh
│   ├── 02_llama_swap.sh
│   ├── ...
│   └── lib/common.sh                   # shared curl/assert helpers
└── plugins/
    ├── assistant/
    ├── escalation/
    ├── design-bureau/
    └── research-bureau/
```

---

## Phase 0 — Prerequisites

**What to build:** base OS packages, Docker + Docker Compose v2, NVIDIA driver + container toolkit (for the RTX 4080 Super), Node.js 20+ (DSH's minimum), Go (only if building `llama-swap` from source — the prebuilt CUDA image avoids this), and the NetBird client.

**How it should function:** `docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi` shows the GPU. `node --version` reports ≥20. NetBird is installed and can join a network, but is **not load-bearing yet** — Phase 0 through Phase 12 all run on `localhost`, and NetBird's only job right now is to exist so the multi-machine split (final section) is a config change, not an install.

**Definition of done:** all four tools respond to a version/status check without error.

**Tests to add now:** `tests/00_prereqs.sh` — checks `docker --version`, `docker compose version`, `nvidia-smi` inside a test container, `node --version` ≥ 20, `netbird status` returns without error.

**Integration point:** nothing depends on this except everything else.

---

## Phase 1 — Shared DMZ (`copyparty`)

**What to build:** a `copyparty` container (source: [github.com/9001/copyparty](https://github.com/9001/copyparty)) mounted at `/mnt/storage/shared-dmz`, exposed on an internal port.

**How it should function:** accepts authenticated HTTP PUT/GET for file upload/download; no other Hubble component talks to it except by HTTP.

**Definition of done:** you can `curl -T` a file up and `curl` it back down with identical content.

**Tests to add now:** `tests/01_dmz.sh` — writes a random test file, uploads it, downloads it, diffs the two, fails loudly on mismatch. Cleans up after itself.

**Integration point:** foundation for the Design Bureau (10) and Research Bureau (11) later — nothing consumes it yet.

---

## Phase 2 — Local Model Serving (`llama-swap` + Qwen)

**What to build:** `llama-swap` ([github.com/mostlygeek/llama-swap](https://github.com/mostlygeek/llama-swap)) via its CUDA container image, `config.yaml` defining two models: `qwen2.5-27b` (the GGUF quant that fits the 16GB VRAM budget) and `nomic-embed-text`, each with a `checkEndpoint` health probe and a TTL for auto-unload.

**How it should function:** `GET /v1/models` lists both. A chat completion against `qwen2.5-27b` loads it into VRAM if not resident, serves the request, and unloads it after the configured idle TTL. A completion against `nomic-embed-text` swaps independently.

**Definition of done:** `nvidia-smi` shows VRAM rise on first request, and fall back to near-zero after the TTL elapses with no further requests.

**Tests to add now:** `tests/02_llama_swap.sh` — (a) `GET /v1/models` returns both model names; (b) a minimal chat completion against `qwen2.5-27b` returns a non-empty `choices[0].message.content`; (c) sleep past the configured TTL, assert VRAM usage (via `nvidia-smi --query-gpu=memory.used`) drops below a threshold.

**Integration point:** everything that needs the PI, Design Bureau local Builders, or Research Bureau local fallbacks depends on this being reachable.

---

## Phase 3 — Model Gateway (LiteLLM)

**What to build:** a `litellm` proxy container ([github.com/BerriAI/litellm](https://github.com/BerriAI/litellm)) with a `config.yaml` `model_list`: `assistant-model` → OpenRouter `deepseek/deepseek-v4-flash` (requires an `OPENROUTER_API_KEY`), `pi-model` → the `llama-swap` OpenAI-compatible endpoint from Phase 2.

**How it should function:** a single `POST /v1/chat/completions` with `model: "assistant-model"` or `model: "pi-model"` routes to the correct backend transparently; every call is logged with tokens and caller.

**Definition of done:** both aliases return valid completions through the one gateway endpoint, and the gateway's own logs show both calls.

**Tests to add now:** `tests/03_litellm.sh` — (a) call `assistant-model`, assert a real completion; (b) call `pi-model`, assert a real completion; (c) re-invoke `01_dmz.sh` and `02_llama_swap.sh` — first explicit regression check, confirms Phase 3 didn't disturb Phases 1–2.

**Integration point:** depends on Phase 2. Every plugin from Phase 7 onward calls only this gateway, never OpenRouter or `llama-swap` directly.

---

## Phase 4 — Workstation Auxiliary Services

**What to build:** three independent containers — `SearXNG` ([github.com/searxng/searxng](https://github.com/searxng/searxng)), `Firecrawl` ([github.com/mendableai/firecrawl](https://github.com/mendableai/firecrawl)), and `MCPHub` aggregating at least the local file-scanner tool over MCP ([github.com/modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol)).

**How it should function:** SearXNG returns JSON results for a query; Firecrawl scrapes a given URL to clean markdown; MCPHub lists at least one registered tool and can execute it.

**Definition of done:** all three respond correctly to a direct, un-proxied request (proxying through the Wake Gateway comes next phase).

**Tests to add now:** `tests/04_aux_services.sh` — (a) SearXNG query for a known term returns ≥1 result; (b) Firecrawl scrape of a stable test URL (e.g. `example.com`) returns non-empty markdown; (c) MCPHub tool list includes the file-scanner; (d) re-run `01`–`03`.

**Integration point:** depends on nothing new. Feeds the Wake Gateway (5), Escalation Plugin's fallback (8), and Research Bureau (11).

---

## Phase 5 — Wake Gateway

**What to build:** a small TypeScript service (Zod-validated route config, matching the rest of the stack) implementing a reverse proxy in front of the four Workstation routes from Phases 2 and 4, with:
- a per-route table (target host:port + health-check definition, reusing `llama-swap`'s own `checkEndpoint` for its route);
- one shared wake-state object per machine, not per route;
- true streaming-safe forwarding (no response buffering);
- a `SAME_HOST_MODE` flag that, when `true` (the case for now, since everything is local), skips the actual Wake-on-LAN send and jumps straight to health-check-then-forward — exercising the real proxy/health-check/coalescing logic today without a physical second machine to wake. Flipping this to `false` plus a real MAC address is the *only* change needed at the multi-machine split.

**How it should function:** any request to the gateway for a given route checks the shared wake state; if "asleep" (or, in `SAME_HOST_MODE`, on first health-check failure), it triggers the wake sequence once and every concurrent request for *any* route waits on that same in-flight sequence; once healthy, it forwards transparently, streaming included.

**Definition of done:** a single request round-trips correctly for all four routes; five simultaneous requests fired during a simulated "waking" window result in exactly one wake sequence, not five.

**Tests to add now:** `tests/05_wake_gateway.sh` + `tests/05_wake_gateway.test.ts` — (a) proxy forwards correctly to each of the four routes; (b) concurrency test: force a slow/failing health check, fire 5 parallel requests, assert the wake sequence (or, in `SAME_HOST_MODE`, the health-check retry loop) ran exactly once via a counter/log assertion, not five; (c) SSE streaming test: request a streaming endpoint (llama-swap chat completion with `stream: true`), assert chunks arrive incrementally (measure inter-chunk timing, not one blob at the end); (d) re-run `01`–`04`.

**Integration point:** depends on Phases 2 and 4. Every subsequent plugin (7, 8, 10, 11) that needs a Workstation service calls it only through this gateway.

---

## Phase 6 — DSH Instance

**What to build:** the DeepSeek Harness instance itself ([github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)), via `npx @deepseek-ai/dsh web` or a from-source build, with no custom plugins yet.

**How it should function:** the Web UI is reachable, the Cordis plugin runtime is active, and it starts without needing any Hubble-specific config yet.

**Definition of done:** `GET http://localhost:3080` returns 200 and the UI loads in a browser.

**Tests to add now:** `tests/06_dsh_boot.sh` — HTTP check on the Web UI port, plus a check that the process didn't exit non-zero on startup.

**Integration point:** depends only on Node.js from Phase 0. Everything from Phase 7 onward is a plugin mounted into this instance.

---

## Phase 7 — Assistant Agent Plugin

**What to build:** the first custom Cordis plugin — wires DSH's model adapter to call LiteLLM's `assistant-model` alias for ordinary chat, per DSH's own [Cordis plugin tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/index.md).

**How it should function:** a chat message sent through the DSH Web UI is answered by DeepSeek-V4-Flash, round-tripped through LiteLLM.

**Definition of done:** a real, coherent, on-topic response to a real question, through the full chain (browser → DSH → LiteLLM → OpenRouter → DeepSeek-V4-Flash → back).

**Tests to add now:** `tests/07_assistant_plugin.sh` — sends a known factual question through the DSH API, asserts the response contains the expected fact. Then **re-run the entire suite so far (`01`–`06`)** — this is the first phase where a regression in early infrastructure would be invisible without deliberately re-checking it, so make the re-run explicit in the script rather than assumed.

**Integration point:** depends on Phases 3 and 6. The Escalation Plugin and both Bureaus are siblings of this plugin, not built on top of it — they share the DSH instance, not each other's code.

---

## Phase 8 — Escalation Plugin

**What to build:** register the `request_private_data(reason, data_requested)` tool on the Assistant; on invocation, call the Wake Gateway, spin up a Qwen PI sub-session via `pi-model`, evaluate warrant against the last 6–10 messages, render the approval overlay on "warranted," and log every verdict + reasoning to the DSH session log.

**How it should function:** exactly as specified in `Hubble_2.0.md` section "Escalation Plugin" — the asymmetric gate, the async non-blocking notify on refusal, the default-deny timeout.

**Definition of done:** a prompt that plausibly needs private data produces, end to end: a Workstation wake if needed, a real PI verdict, and either an approval overlay or a web-search fallback, with a log entry either way.

**Tests to add now:** `tests/08_escalation_plugin.sh` + `.test.ts` — (a) force a "warranted" verdict (test double for the PI call), assert the approval overlay renders and approving completes the flow with injected context; (b) force "not warranted", assert async notify fires and the Assistant's response shows a web-search-sourced answer, with no blocking modal; (c) force an unanswered approval past timeout, assert default-deny fires *and* assert (via the llama-swap logs or `/v1/models` load state) that the idle TTL was reset during the wait, not left ticking; (d) fire two escalation triggers back-to-back while the Workstation is cold, assert (via Wake Gateway logs) only one wake sequence ran; (e) re-run `01`–`07`.

**Integration point:** depends on Phases 2, 3, 5, 6, 7.

---

## Phase 9 — Shared Background-Job Utility

**What to build:** one small internal TypeScript module — not a plugin itself, a library both Bureaus import — providing: start a job (returns a task ID), poll status (`pending` / `running` / `done` / `failed` / `cancelled`), cancel a job, and return a Zod-validated result. This mirrors the async-job/status-polling shape already used for the Wake Gateway's cold-boot problem, and matches how Odysseus's own `ResearchHandler` is built.

**How it should function:** a caller starts a long-running async function, gets a task ID immediately, can poll or cancel, and receives a typed, validated result on completion — never a raw thrown exception or an unvalidated blob.

**Definition of done:** a dummy job (e.g., `sleep(2s)` then return a fixed object) can be started, observed transitioning through its states, and its result validated against a Zod schema.

**Tests to add now:** `tests/09_job_utility.test.ts` — (a) full lifecycle test (start → poll pending → poll running → poll done → validated result); (b) cancellation mid-run leaves state `cancelled`, not `done`; (c) a job exceeding a configured hard timeout is force-failed rather than hanging; (d) re-run `01`–`08`.

**Integration point:** standalone; consumed by Phases 10 and 11, built before both so neither reinvents it.

---

## Phase 10 — Design Bureau Plugin

**What to build:** the Planner registers a complex-task tool on the Assistant; on invocation, dispatches Designer and Coder Builder subagents via `Promise.allSettled`, wrapped in the Phase 9 utility, using Zod-validated handoff payloads (task ID, role instructions, governed context slice) and DMZ pass-by-reference for artifacts; a synthesis step runs once both branches settle.

**How it should function:** exactly as specified in `Hubble_2.0.md` — per-role LiteLLM aliases, DMZ reuse (deliberate, for now), condensed return values, no framework.

**Definition of done:** a two-part task (e.g., "sketch a UI layout and write the function that populates it") produces both artifacts in the DMZ and one synthesized response referencing both by path.

**Tests to add now:** `tests/10_design_bureau.sh` + `.test.ts` — (a) both branches succeed → synthesis response references both DMZ artifacts; (b) force one branch to time out (test double) → synthesis still completes, acknowledging the partial result, and does not hang past the Phase 9 hard timeout; (c) assert the Planner's context after both branches return contains only the condensed `{status, artifact}` shape, not raw generated code inlined — a direct check on the "context compaction" design goal; (d) re-run `01`–`09`.

**Integration point:** depends on Phases 3, 5, 6, 7, 9. Optionally exercises the FreeLLMAPI alias if configured (Phase 10b, optional).

### Phase 10b (optional) — FreeLLMAPI as a Builder fallback backend

**What to build:** a self-hosted FreeLLMAPI instance ([github.com/tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi)) on the Homelab tier, with a `coder-model-free` LiteLLM alias configured as a fallback behind the primary `coder-model`.

**Definition of done:** killing/rate-limiting the primary `coder-model` backend causes LiteLLM to fail over to `coder-model-free` and the Coder subagent still completes.

**Tests to add now:** `tests/10b_freellmapi_fallback.sh` — force the primary alias to fail, assert the fallback serves the request and the Builder still succeeds.

---

## Phase 11 — Research Bureau Plugin

**What to build:** a single self-looping agent, matching the IterResearch pattern ([arxiv.org/abs/2511.07327](https://arxiv.org/abs/2511.07327)) and Odysseus's real-world precedent ([github.com/odysseus-dev/odysseus](https://github.com/odysseus-dev/odysseus)): generate a search query → search via SearXNG (extract full pages via Firecrawl when needed) → reconstruct a compact research-state object (question, evolving report, last observation) → check the goal → loop or synthesize, wrapped in the Phase 9 background-job utility.

**How it should function:** given a research question, it runs a bounded number of rounds, each one replacing (not appending to) the research state, and produces a synthesized report written to the DMZ.

**Definition of done:** a real research question produces a multi-source, factually grounded report in the DMZ within a bounded number of rounds.

**Tests to add now:** `tests/11_research_bureau.sh` + `.test.ts` — (a) end-to-end run on a known-answerable question, assert the report contains the expected fact and cites at least one real source; (b) round-cap test: force a non-convergent case (a test double that never reports the goal met), assert the loop stops at `MAX_ROUNDS` rather than running unbounded; (c) state-reconstruction test: assert the serialized research-state object's size does not grow monotonically across rounds — a direct, automatable check against context suffocation; (d) re-run `01`–`10`.

**Integration point:** depends on Phases 3, 4, 5, 6, 7, 9. Optionally uses `research-model-free` (FreeLLMAPI) for per-round calls, same pattern as Phase 10b.

---

## Phase 12 — GPM Client End-to-End

**What to build/verify:** nothing new to build — this phase is verification that a real browser client, connecting the way a GPM actually will (over NetBird once split, over LAN for now), renders and can act on the approval overlay from Phase 8.

**Definition of done:** from a second device on the network, you can trigger an escalation, see the approval overlay render, and approve or deny it, with the correct downstream effect.

**Tests to add now:** `tests/12_gpm_e2e.md` — a manual checklist (this one phase is intentionally manual, since it verifies human-facing UI rendering, not a scriptable API contract) — plus re-running the full automated suite `01`–`11` immediately before and after, to bound the manual step between two known-green states.

**Integration point:** depends on everything above.

---

## Phase 13 — Single Build/Install Script Per Machine Class

**What to build:**
- `docker-compose.single-machine.yml` — everything from Phases 1–11, as it's actually run today, on the one Workstation box.
- `docker-compose.homelab.yml` / `docker-compose.workstation.yml` — the same services, split by the zone assignments in `Hubble_2.0.md` (DSH, LiteLLM, Wake Gateway, DMZ on Homelab; `llama-swap`, MCPHub, SearXNG, Firecrawl on Workstation) — written now, exercised later.
- `install-workstation.sh` / `install-homelab.sh` — idempotent scripts that install Phase 0 prerequisites, pull/build images, apply config, join NetBird, and finish by running the appropriate subset of `tests/run_tests.sh` as a post-install smoke test.

**How it should function:** running one script on a clean machine of a given class reproduces its entire portion of the stack and self-verifies via the accumulated test suite.

**Definition of done:** `./install-workstation.sh` on a freshly wiped Workstation reproduces Phases 1–11 in full, and `./tests/run_tests.sh` exits 0.

**Tests to add now:** none new — the full accumulated suite *is* the test for this phase. A green `run_tests.sh` after a from-scratch `install-workstation.sh` run is the literal definition of done.

**Integration point:** everything.

---

## Multi-Machine Split (when you're ready)

This is the payoff for the discipline above: because every service was addressed by hostname/config rather than assumed to be `localhost`, and the Wake Gateway's `SAME_HOST_MODE` flag was the only thing standing in for real Wake-on-LAN, the split is a configuration change, not a rewrite:

1. Provision the Homelab box, run `install-homelab.sh` (DSH, LiteLLM, Wake Gateway, DMZ).
2. On the Workstation, run `install-workstation.sh` in its now-standalone form (`llama-swap`, MCPHub, SearXNG, Firecrawl only).
3. Join both to the NetBird network for real (it's already installed from Phase 0).
4. Flip `SAME_HOST_MODE=false` on the Wake Gateway, and set the Workstation's real MAC address and NetBird IP.
5. Re-run the *entire* accumulated `tests/run_tests.sh` against the two-machine topology — every test written since Phase 1 should still pass unmodified, since none of them assumed a specific machine boundary. Any test that fails only now was quietly relying on same-host behavior, and that's exactly what this final run exists to catch.
