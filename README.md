# Hubble 2.0

A self-hosted, privacy-boundary-respecting multi-agent infrastructure: a DeepSeek
Harness (DSH) orchestrator running four custom plugins — an **Assistant**, an
**Escalation privacy gate** (local-LLM "Private Investigator" + human approval),
a **Design Bureau** (parallel Designer/Coder subagents) and a **Research Bureau**
(IterResearch-style bounded web research) — over shared infrastructure: LiteLLM
model gateway, copyparty DMZ for artifacts, a Wake Gateway, SearXNG, Firecrawl
and MCPHub.

- **Architecture & rationale:** [`Hubble_2.0.md`](Hubble_2.0.md)
- **Phase-by-phase build plan & test contract:** [`BUILD_GUIDE.md`](BUILD_GUIDE.md)

Everything currently runs on **one machine** (the GPU workstation). The
multi-machine split (Homelab + Workstation via NetBird) is a config change —
see [Multi-machine split](#multi-machine-split) at the bottom.

---

## Repository layout

```
Hubble-v2/
├── docker-compose.single-machine.yml  # the full stack, one host (use this)
├── docker-compose.homelab.yml         # split target: control plane tier
├── docker-compose.workstation.yml     # split target: compute/GPU tier
├── install-workstation.sh             # idempotent installer + smoke test
├── install-homelab.sh                 # split-time installer
├── config/                            # litellm / searxng / mcphub settings
├── services/
│   ├── wake-gateway/                  # streaming-safe proxy + WoL coalescing
│   ├── escalation/                    # PI-gated privacy escalation service
│   ├── design-bureau/                 # Planner -> parallel builders service
│   ├── research-bureau/               # IterResearch loop service
│   └── job-utility/                   # shared background-job library
├── plugins/
│   ├── assistant/escalation-tool/     # Cordis plugin: request_private_data tool
│   └── file-scanner-mcp/              # MCP tool aggregated by MCPHub
├── docker/dsh/                        # DSH image (Caddy front door, baked DSH)
├── tests/                             # numbered suite; run via npm test
└── scripts/                           # DSH start/plugin-install helpers
```

---

## Prerequisites

| Requirement | Version | Why |
|---|---|---|
| Docker Desktop / Engine | any recent (Compose v2 included) | all services are containers |
| Node.js | ≥ 20 | DSH runtime, test tooling, plugin tooling |
| jq | any | infra tests parse JSON |
| NVIDIA driver + GPU | RTX-class, ~16 GB VRAM free for LLMs | llama-swap model serving |
| Git | any | clone/push |

Optional / conditional:
- **OpenRouter API key** — required for cloud models (`assistant-model`,
  `planner-model`, `coder-model`). Local models work without it.
- **NetBird** — *not* needed on a single machine. Required only before the
  multi-machine split.
- **Firecrawl stack** — this build reuses an existing Firecrawl deployment
  (`FIRECRAWL_URL` in `.env`). A fresh Firecrawl `docker compose` deployment
  works equally well; point `.env` at it.

> Model choice note: OpenRouter's data-policy guardrails have begun to 404 the
> bare `deepseek/deepseek-v4-flash` slug. All Hubble configs therefore pin the
> dated slug **`deepseek/deepseek-v4-flash-0731`**.

---

## Step-by-step install

### 1 — Clone and configure

```bash
git clone https://github.com/JustaRico/Hubble-v2.git
cd Hubble-v2
cp .env.example .env
```

Edit `.env`:

| Variable | Set to | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | your key | cloud model access |
| `DMZ_PASS` | a password | copyparty DMZ account (`hubble`) |
| `DSH_BASIC_AUTH_B64` | see step 5 | generated during install if missing |
| `WORKSTATION_MAC` | leave empty | single machine only |
| `SAME_HOST_MODE` | `true` | skips real Wake-on-LAN |
| `HUBBLE_ALLOW_TEST_CONTROLS` | `true` (dev) / `false` (prod) | enables deterministic test stubs in escalation |

Ports can stay at defaults unless they collide with existing services
(13923, 14000, 8180, 13100, 8811, 8812, 8813, 8814, 3080).

### 2 — Run the installer

```bash
bash install-workstation.sh
```

The installer is idempotent and:
1. verifies Docker/Compose/Node/GPU,
2. generates the DSH web password hash into `.env` on first run,
3. installs npm deps for the workspace and each service,
4. builds every container image,
5. starts the full stack with `docker compose up -d`,
6. runs `npm test` — the accumulated test suite — as its smoke test.

A clean exit of `install-workstation.sh` means every phase test is green.

If your box does not already run llama-swap, stand up a llama-swap instance
serving two models named exactly:

- `gemma4-12b` — chat model used by the PI / designers / researcher
- `qwen3-embed` — embedding model

and make sure it listens on port `10123` (or change `LLAMA_SWAP_URL` /
`LITELLM_LLAMA_SWAP_URL_V1` in `.env`). Any OpenAI-compatible server that
exposes those two model ids will do.

### 3 — Install the Hubble plugins into DSH

The escalation tool is registered inside the DSH profile by a patch layer:

```bash
bash scripts/install_hubble_plugins.sh
```

This writes `data/dsh-home/profiles/web/cordis.patch.yml` (pointing the loader
at `/opt/hubble/escalation-tool/lib/index.js` inside the DSH container), copies
the plugin tree there, restarts the `hubble-dsh` container, and waits for the
health check. The Research Bureau likewise expects
`data/dsh-home/profiles/headless/cordis.patch.yml` to insert its row.

### 4 — Start order cheat sheet

```bash
docker compose -f docker-compose.single-machine.yml up -d   # everything else
docker start llama-swap                                     # if standalone
curl http://localhost:8811/health    # wake gateway    -> {"status":"ok",...}
curl http://localhost:8812/health    # escalation      -> {"status":"ok",...}
curl http://localhost:8813/health    # design bureau   -> {"status":"ok",...}
curl http://localhost:8814/health    # research bureau -> {"status":"ok",...}
curl -u hubble:<DMZ_PASS> http://localhost:3080/   # DSH Web UI (basic auth)
```

The DSH UI lives behind Caddy basic auth. The bcrypt credential is what you
entered during install (user `hubble`); store the base64-encoded bcrypt hash
in `DSH_BASIC_AUTH_B64`.

---

## Verifying the install

```bash
npm test        # runs tests/run_tests.sh -> every numbered phase test in order
```

Expected output ends with:

```
RESULT: 15 passed, 0 failed
```

Each script maps to a BUILD_GUIDE phase:

| Test file | Phase | What it proves |
|---|---|---|
| `00_prereqs.sh` | 0 | docker / compose / node / GPU reachable |
| `01_dmz.sh` | 1 | DMZ PUT→GET round trip byte-identical |
| `02_llama_swap.sh` | 2 | both models listed; chat + embeddings answer; TTL idle unload (with `HUBBLE_LONG_TESTS=1`) |
| `03_litellm.sh` | 3 | gateway routes assistant- and pi-model; logs calls |
| `04_aux_services.sh` | 4 | SearXNG JSON search; Firecrawl scrape; MCPHub executes file-scanner |
| `05_wake_gateway.sh` + `05_wake_state.test.mjs` | 5 | forwarding, wake coalescing (12 requests → 1 sequence), SSE streaming intact |
| `06_dsh_boot.sh` | 6 | auth gate, stable UI, headless model round-trip answers a fact correctly |
| `07_assistant_plugin.sh` | 7 | request_private_data tool registered and returns structured JSON when invoked |
| `08_escalation_plugin.sh` | 8 | warranted → approval flow; not-warranted → non-blocking fallback; default-deny timeout; audit log entries with reasoning |
| `09_job_utility.test.mjs` | 9 | job lifecycle, cancellation, hard timeout, Zod validation |
| `10_design_bureau.{sh,test.mjs}` | 10 | parallel designer/coder branches, DMZ artifacts, synthesis references paths only |
| `11_research_bureau.{sh,test.mjs}` | 11 | bounded research loop, report artifact in DMZ with sources, anti-context-suffocation property |

Long tests are gated: set `HUBBLE_LONG_TESTS=1` before running `npm test` to
include the ~10-minute llama-swap idle-unload wait.

---

## Everyday operation

| Task | Command |
|---|---|
| Start everything | `docker compose -f docker-compose.single-machine.yml up -d` |
| Stop everything | `docker compose -f docker-compose.single-machine.yml down` |
| Tail a service | `docker logs -f hubble-<name>` |
| Design Bureau task | `curl -X POST localhost:8813/design -H "content-type: application/json" -d '{"task":"..."}'` then poll `GET :8813/design/<taskId>` |
| Research Bureau question | `curl -X POST localhost:8814/research -H "content-type: application/json" -d '{"question":"..."}'` then poll `GET :8814/research/<taskId>` |
| Pending private-data approvals | `GET :8812/pending`; approve/deny `POST :8812/approve/<id>?decision=approve|deny` |
| Privacy audit trail | `data/audit/escalation.log` |

Artifacts land in `data/dmz/` (bureau outputs under `bureau/<taskId>/`,
research reports under `research/<taskId>/report.md`).

### Pointing the bureaus at better models

Model quality is a config edit, never a code change — swap any alias in
`config/litellm/config.yaml`. E.g. upgrade research quality from local
gemma4-12b to DeepSeek-V4-Flash:

```yaml
  - model_name: research-model
    litellm_params:
      model: openrouter/deepseek/deepseek-v4-flash-0731
      api_key: os.environ/OPENROUTER_API_KEY
```

Then `docker compose -f docker-compose.single-machine.yml up -d litellm-gateway`.

---

## Multi-machine split

When ready to move Homelab-tier services to their own always-on box:

1. Provision the Homelab, install NetBird, then run
   `bash install-homelab.sh` there (it refuses to continue without
   `WORKSTATION_NETBIRD_IP` and `WORKSTATION_MAC` in its `.env`).
2. On the Workstation keep only the compute tier
   (`llama-swap`, `searxng`, `mcphub`, Firecrawl).
3. In the Homelab's `.env` set `SAME_HOST_MODE=false` — the Wake Gateway now
   sends real Wake-on-LAN magic packets on the physical LAN interface (WoL is
   L2 broadcast and cannot traverse NetBird, which is why the gateway uses
   `network_mode: host` in `docker-compose.homelab.yml`).
4. Re-run the whole suite against the split topology. Nothing was written
   assuming `localhost`: the bureaus/gateway take URLs from env, so this is
   the moment hidden same-host assumptions would surface.

Recommended extra hardening at split time (documented in
[`docker/dsh/README.md`](docker/dsh/README.md)): replace the DSH container's
Caddy basic-auth stanza with the Caddy security-portal pattern — identity
store, JWT sessions, login rate limiting — since basic auth has no logout or
rate limiting.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `SearXNG returned no results` | DuckDuckGo CAPTCHAs self-hosted instances intermittently. Tests and the research bureau pin `engines=bing,wikipedia,google,ddg` which stays resilient. |
| `404 ... guardrail restrictions and data policy` from OpenRouter | Use the dated slug `deepseek/deepseek-v4-flash-0731` (already pinned in all configs). |
| `npx ECOMPROMISED / Lock compromised` | Do not use `npx @deepseek-ai/dsh` at runtime — the shipped image bakes DSH into `/opt/dsh` at build time precisely to avoid this npm-on-overlayfs race. |
| DSH container exits immediately | DSH refuses `--host 0.0.0.0` by design. Never remove the Caddy sidecar from `docker/dsh/entrypoint.sh`; bind changes happen via `INTERNAL_PORT`/caddy, not the dsh flags. |
| `Cannot find package '@hubble/...'` | Plugin rows reference absolute container paths (`/opt/hubble/...`); re-run `scripts/install_hubble_plugins.sh` after recreating the DSH container. |
| Wake Gateway stuck `waking` | With `SAME_HOST_MODE=true` it health-polls all four Workstation routes. Check each target manually; ensure llama-swap is actually listening. |
| Empty model content under load | All LLM-facing tests retry with backoff; persistent empties mean llama-swap/VRAM pressure — check `nvidia-smi` and consider unloading desktop apps. |
