# Hubble DSH — final-shape containerization (built this way from day one so
# the multi-machine split is config-only).
#
# Topology (mirrors the community reference architecture):
#   browser -> :3080 Caddy (basic auth) -> 127.0.0.1:3081 dsh web
#
# Why Caddy lives INSIDE this container: `dsh web` refuses --host 0.0.0.0 by
# design, binding loopback only — which no sibling container can reach. The
# supervisor pattern (proxy + DSH sharing one network namespace) is the
# reference image's own solution.
#
# DSH is BAKED at build time (pinned 0.1.1-rc.2 into /opt/dsh): the runtime
# never invokes npm/npx, so container boot has no network dependency and no
# npm lockfile races (npx's ECOMPROMISED flake on overlayfs).
#
# At the multi-machine split this exact image moves to the Homelab tier;
# only compose wiring changes (networks/ports, NetBird addressing).
FROM caddy:2 AS caddy

FROM node:24-bookworm-slim
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy

RUN apt-get update && apt-get install -y --no-install-recommends bash tini && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@10

ENV DSH_HOME=/data/dsh-home \
    NODE_PATH=/opt/dsh/node_modules

WORKDIR /opt/dsh
COPY package.json ./
RUN npm install --no-audit --no-fund --loglevel=warn

VOLUME /data/dsh-home
WORKDIR /workspace

COPY Caddyfile /opt/hubble/Caddyfile
COPY entrypoint.sh /opt/hubble/entrypoint.sh
RUN chmod +x /opt/hubble/entrypoint.sh

EXPOSE 3080
# tini reaps the dsh/caddy child trees (same supervisor role as the reference)
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/hubble/entrypoint.sh"]
