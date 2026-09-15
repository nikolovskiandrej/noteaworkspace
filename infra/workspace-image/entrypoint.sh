#!/usr/bin/env bash
# Container entrypoint. The orchestrator starts containers with Docker's init
# process (`--init`) so zombie reaping and signal forwarding are handled for us.
set -euo pipefail

# A freshly created volume is seeded from the image, but a volume created by an
# older image may lack the project directory.
mkdir -p "${NOTEA_PROJECT_DIR:-$HOME/project}"

# Notea's own directories on the volume, shared with the per-member agent uids.
#
# Agent processes run as a uid of their own (that is what keeps one member from
# reading another's credential out of /proc), with `dev` as their primary group. They
# need to create their worktree, their run directory and their private HOME here, so
# these are group-writable and setgid; everything an agent then creates inherits the
# shared group. Nothing is granted to `other`.
notea_dir="${NOTEA_STATE_DIR:-$HOME/.notea}"
mkdir -p "$notea_dir/worktrees" "$notea_dir/runs" "$notea_dir/agents"
chmod 2775 "$notea_dir" "$notea_dir/worktrees" "$notea_dir/runs" "$notea_dir/agents"

# Persist git identity defaults if the user has none (they can override in the shell).
if ! git config --global user.name >/dev/null 2>&1; then
  git config --global user.name "${NOTEA_GIT_NAME:-Notea Workspace}"
  git config --global user.email "${NOTEA_GIT_EMAIL:-workspace@notea.local}"
fi

exec node /opt/notea/agent/agent.cjs
