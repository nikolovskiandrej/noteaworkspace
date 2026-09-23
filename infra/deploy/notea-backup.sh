#!/usr/bin/env bash
# Nightly backup of the Notea Workspace data (docs/DEPLOYMENT.md §7), run as root by
# notea-backup.timer and installed as /usr/local/sbin/notea-backup. Each run writes one
# directory, /var/backups/notea/<UTC time>/, holding
#   notea-ws-<id>-home.tar.zst  each workspace's home volume: the project, the task
#                               worktrees and the agent homes, without node_modules
#                               and caches
#   database.dump               the control-plane database (pg_dump custom format)
# and the newest seven are kept. Everything is root-only: the dump holds password
# hashes and encrypted credentials, and a volume can hold keys a member created.
set -euo pipefail
umask 077

BACKUP_ROOT=${NOTEA_BACKUP_ROOT:-/var/backups/notea}
KEEP=${NOTEA_BACKUP_KEEP:-7}
ENV_FILE=${NOTEA_ENV_FILE:-/opt/notea-workspace/app/.env}
MIN_FREE_GB=${NOTEA_BACKUP_MIN_FREE_GB:-10}

mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"

# A full disk would take the workspaces down with it; skip the night instead.
free_gb=$(df --output=avail -BG "$BACKUP_ROOT" | tail -1 | tr -dc '0-9')
if (( free_gb < MIN_FREE_GB )); then
  echo "only ${free_gb} GB free under $BACKUP_ROOT (need $MIN_FREE_GB); no backup taken" >&2
  exit 1
fi

stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
work="$BACKUP_ROOT/.$stamp.partial"
mkdir "$work"
trap 'rm -rf -- "$work"' EXIT

for volume in $(docker volume ls -q --filter name=notea-ws-); do
  mountpoint=$(docker volume inspect -f '{{.Mountpoint}}' "$volume")
  # Read the volume in place: no helper container, and numeric owners keep each
  # member's agent uid on restore. Exit status 1 only means a file changed while it
  # was read (someone was working), which is no reason to lose the whole night.
  status=0
  tar --zstd --numeric-owner --warning=no-file-ignored \
    --exclude=node_modules --exclude=.cache --exclude=.npm \
    -cf "$work/$volume.tar.zst" -C "$mountpoint" . || status=$?
  if (( status > 1 )); then
    echo "tar failed for $volume (exit $status)" >&2
    exit 1
  fi
  echo "backed up $volume ($(du -h "$work/$volume.tar.zst" | cut -f1))"
done

# The connection URL is split into libpq's environment variables, so the password
# never appears on a command line, where any local user could read it.
DUMP_FILE="$work/database.dump" node --env-file="$ENV_FILE" - <<'JS'
const { spawnSync } = require('node:child_process');
const url = new URL(process.env.DATABASE_URL);
const env = {
  PATH: process.env.PATH,
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  PGSSLMODE: url.searchParams.get('sslmode') ?? 'require',
};
for (const [param, name] of [['channel_binding', 'PGCHANNELBINDING'], ['options', 'PGOPTIONS']]) {
  const value = url.searchParams.get(param);
  if (value) env[name] = value;
}
const dump = spawnSync('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${process.env.DUMP_FILE}`], { env, stdio: 'inherit' });
process.exit(dump.status ?? 1);
JS
echo "backed up the database ($(du -h "$work/database.dump" | cut -f1))"

mv -- "$work" "$BACKUP_ROOT/$stamp"
trap - EXIT

# Keep the newest $KEEP complete backups.
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -printf '%f\n' | sort | head -n -"$KEEP" |
  while read -r old; do
    rm -rf -- "${BACKUP_ROOT:?}/$old"
    echo "removed backup $old"
  done
echo "backup $stamp complete"
