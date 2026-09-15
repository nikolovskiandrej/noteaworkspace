# syntax=docker/dockerfile:1.7
#
# Base workspace image. Every workspace container runs this image (until per-project
# images exist). Build from the repository root AFTER `npm run build:agent`:
#
#   docker build -f infra/workspace-image/Dockerfile -t notea/workspace:dev .
#
# Layout inside the container:
#   /opt/notea/agent      workspace agent (root-owned, read-only for `dev`)
#   /home/dev             persistent volume (HOME): shell history, tool auth, caches
#   /home/dev/project     the project files (NOTEA_PROJECT_DIR)
#
# The container runs as the unprivileged user `dev` (uid 1000). There is no sudo:
# system packages belong in the image, not in a mutable container.

FROM node:24-bookworm-slim

ARG DEV_UID=1000
ARG DEV_GID=1000

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git openssh-client less procps \
    python3 make g++ ripgrep jq unzip nano vim-tiny locales \
  && sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen \
  && locale-gen \
  && rm -rf /var/lib/apt/lists/*

# The node image ships a `node` user with uid 1000; replace it with `dev`.
RUN userdel -r node 2>/dev/null || true \
  && groupadd -g ${DEV_GID} dev \
  && useradd -m -u ${DEV_UID} -g dev -s /bin/bash dev

# Workspace agent: bundled JS plus its single native dependency (node-pty).
COPY packages/workspace-agent/image/package.json /opt/notea/agent/package.json
RUN cd /opt/notea/agent \
  && npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force \
  && test -f node_modules/node-pty/build/Release/pty.node \
  && node -e "require('node-pty'); console.log('node-pty ok')"
COPY packages/workspace-agent/dist/agent.cjs /opt/notea/agent/agent.cjs
COPY infra/workspace-image/entrypoint.sh /opt/notea/entrypoint.sh
RUN chmod 0755 /opt/notea/entrypoint.sh && chown -R root:root /opt/notea

# Sensible defaults for interactive shells and tools.
COPY --chown=dev:dev infra/workspace-image/bashrc.d.sh /home/dev/.bashrc.d/notea.sh
RUN echo '[ -f "$HOME/.bashrc.d/notea.sh" ] && . "$HOME/.bashrc.d/notea.sh"' >> /home/dev/.bashrc \
  && mkdir -p /home/dev/project && chown -R dev:dev /home/dev

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    HOME=/home/dev \
    SHELL=/bin/bash \
    NOTEA_AGENT_PORT=7070 \
    NOTEA_PROJECT_DIR=/home/dev/project

USER dev
WORKDIR /home/dev/project
EXPOSE 7070

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7070/healthz >/dev/null || exit 1

ENTRYPOINT ["/opt/notea/entrypoint.sh"]
