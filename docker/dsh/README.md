# Hubble DSH container — design notes

## Why a raw TCP forwarder instead of Caddy (current phase)

The community reference image (moelin/deepseek-harness) fronts DSH with Caddy.
Inspecting its Caddyfile shows Caddy earns its place through three jobs:

1. **Authentication**: caddy-security identity portal (local user store, JWT
   cookie sessions, login rate-limiting).
2. **Security headers**: CSP, X-Frame-Options, nosniff, HSTS.
3. **Trust-fence delegation**: for `AUTH_MODE=none`, it rewrites `Host` to
   `127.0.0.1:<internal>` on the privileged settings/credentials API routes,
   moving the loopback trust boundary out to its own authenticated portal.

DSH's own protection (`dsh-client-connection`, "/api browser-trust fence"):
every `/api` request must carry a `Host` that is a loopback authority or a
declared `--trusted-host`; the privileged method set (settings, credentials,
host.pickDirectory, agentPreset authoring) is pinned to loopback outright.

For the single-machine run everything is reached as `http://localhost:3080`,
and `localhost` IS a loopback authority — so a plain L4 forwarder preserves
every built-in guard: privileged APIs stay loopback-only, WebSocket upgrades
pass through untouched, and no auth bypass exists to introduce.

## When this changes

The moment DSH is reachable by a non-loopback authority (the multi-machine
split, GPM browsers over NetBird), the forwarder is replaced by **Caddy**
(mature, accepted dependency) configured like the reference's security file:
authenticated portal + the same header hygiene. That lands with
docker-compose.homelab.yml in Phase 13.
