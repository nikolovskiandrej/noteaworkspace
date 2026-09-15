#!/usr/bin/env bash
# Container entrypoint. The orchestrator starts containers with Docker's init
# process (`--init`) so zombie reaping and signal forwarding are handled for us.
set -euo pipefail

# A freshly created volume is seeded from the image, but a volume created by an
# older image may lack the project directory.
mkdir -p "${NOTEA_PROJECT_DIR:-$HOME/project}"

# Persist git identity defaults if the user has none (they can override in the shell).
if ! git config --global user.name >/dev/null 2>&1; then
  git config --global user.name "${NOTEA_GIT_NAME:-Notea Workspace}"
  git config --global user.email "${NOTEA_GIT_EMAIL:-workspace@notea.local}"
fi

exec node /opt/notea/agent/agent.cjs
