# Phase 12 — GPM Client End-to-End (Manual Checklist)

*This phase is intentionally manual: it verifies human-facing UI rendering and
interaction, not a scriptable API contract. Perform every step **from a second
device** on the network — a phone or laptop other than the machine running the
stack — to prove remote usability. On a LAN without NetBird, use
`http://<workstation-LAN-IP>:3080`. After the multi-machine split, connect over
the NetBird mesh address instead. Nothing else about the checklist changes.*

Run `tests/run_tests.sh` immediately before starting and after finishing this
checklist, so the manual pass is bounded by two known-green automated states.

## Preconditions

- [ ] Stack is up: `docker compose -f docker-compose.single-machine.yml ps`
      shows all containers `Up` (dsh, litellm, copyparty-dmz, searxng, mcphub,
      wake-gw, escalation, design-bureau, research-bureau, llama-swap)
- [ ] Full automated suite green: `npm test` exits 0
- [ ] Second device joined to the same network (NetBird post-split)

## A. DSH Web UI reachability from the GPM

- [ ] Browser opens `http://<host>:3080` and shows the Caddy basic-auth prompt
- [ ] Wrong password is refused; correct credentials (`hubble` / DMZ password)
      render the DeepSeek Harness Web UI
- [ ] The UI stays loaded across refresh (no blank page / 502)

## B. Ordinary chat round-trip (Assistant)

- [ ] Send a factual question ("What is 2+3?") in a new session
- [ ] An answer arrives through the full chain
      browser → DSH → LiteLLM/OpenRouter → DeepSeek-V4-Flash → back

## C. Escalation & approval overlay (privacy gate)

Trigger something that plausibly needs private data:

- [ ] The assistant calls `request_private_data` (visible as tool activity)
- [ ] One of:
      - PI verdict "warranted" → an approval request appears on the GPM
        (`GET http://<host>:8812/pending` lists its id if the overlay UI is
        not yet wired), and **approving** via
        `POST /approve/<id>?decision=approve` completes the flow returning a
        minimal context package (no raw files)
      - or verdict "not warranted" → the assistant answers from web search
        WITHOUT blocking on any modal
- [ ] Leaving an approval unanswered for ~2 minutes results in default-deny
      (`denied_timeout`) — verify in the service log:
      `data/audit/escalation.log` contains `verdict` entries WITH reasoning,
      plus the `approval ... decision=timeout` line
- [ ] No private content appears anywhere unless explicitly approved above

## D. Design Bureau task

- [ ] Hand a two-part creative/coding task to the bureau
      (`POST :8813/design {"task": ...}`) — e.g.
      "sketch a settings page layout and write the JS toggle handler"
- [ ] Status endpoint polls pending → running → done
- [ ] Result references TWO artifacts under `/dmz/bureau/<taskId>/…`
- [ ] Both artifacts download from copyparty on the GPM's own browser
      (`http://<host>:13923/dmz/bureau/<taskId>/designer.md`, `coder.js`)
      using the shared credentials

## E. Research Bureau report

- [ ] Kick off `POST :8814/research {"question": "..."}`
- [ ] Status polls through running → done within the bounded rounds
- [ ] Result references `/dmz/research/<taskId>/report.md`; opening it on the
      GPM shows a multi-source markdown report with real source URLs
- [ ] Report body does NOT balloon contextually — the loop used fewer than the
      configured max rounds OR stopped when sufficient (visible in the result's
      `rounds_used`)

## F. Wake Gateway visibility (status, not spinner)

- [ ] During any of the above, distinct states are observable rather than one
      undifferentiated wait: gateway `/health` flips between `"ok"`/`"waking"`,
      bureau tasks show pending → running → done, escalation shows
      awaiting-approval vs declined
- [ ] `curl http://<host>:8811/stats` on the GPM shows wake coalescing stats

## Sign-off

- [ ] All boxes ticked from the second device
- [ ] `tests/run_tests.sh` re-run afterwards: exit 0 (suite still green)
