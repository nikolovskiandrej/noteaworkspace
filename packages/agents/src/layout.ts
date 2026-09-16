import { runOrThrow, shellQuote } from './command-runner';
import type { GitPaths } from './git';
import type { CommandRunner } from './types';

/** Root of Notea's own state on the workspace volume. */
export const DEFAULT_NOTEA_DIR = '/home/dev/.notea';
/** Where a run's artefacts (the brief handed to the CLI) live inside the container. */
export const DEFAULT_RUNS_DIR = `${DEFAULT_NOTEA_DIR}/runs`;
/** Per-uid private HOME directories for agent processes (created mode 0700 by the orchestrator). */
export const DEFAULT_AGENTS_DIR = `${DEFAULT_NOTEA_DIR}/agents`;

export function runDirectory(runId: string, runsDir: string = DEFAULT_RUNS_DIR): string {
  return `${runsDir}/${runId}`;
}

export function runBriefPath(runId: string, runsDir: string = DEFAULT_RUNS_DIR): string {
  return `${runDirectory(runId, runsDir)}/brief.md`;
}

/** Marker recording that a container has had the shared layout applied. */
export const SHARED_LAYOUT_MARKER = 'notea-shared-layout-v1';

/**
 * Git configuration handed to *agent* processes, which run as a different uid than
 * the one that owns the repository.
 *
 * Git refuses to operate on a repository owned by another user ("dubious
 * ownership"), which is a protection against being tricked into running hooks from
 * someone else's repository on a shared machine. Inside a workspace container that
 * protection is not meaningful: every uid there is one Notea allocated, the
 * repository is the workspace's own project, and the exception is set through the
 * process environment of this one exec rather than written into any config file, so
 * it does not widen anything for the container's human shells.
 */
export const AGENT_GIT_ENV: Record<string, string> = {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'safe.directory',
  GIT_CONFIG_VALUE_0: '*',
};

/**
 * Makes a container's project and Notea directories shareable between the `dev`
 * user (who owns the main tree and performs integration) and the per-member agent
 * uids (who own their runs' files).
 *
 * Idempotent, and cheap after the first time: the expensive recursive `chmod` is
 * guarded by a marker inside `.git`, and `core.sharedRepository=group` makes git
 * itself keep new objects group-writable from then on.
 *
 * Everything here grants access to the *group* (`dev`, gid 1000), which every agent
 * uid has as its primary group. It grants nothing to `other`, and it does not make
 * one member's HOME or environment readable by another — that separation is the uid.
 */
export function sharedLayoutScript(paths: GitPaths, noteaDir: string = DEFAULT_NOTEA_DIR): string {
  const dirs = [noteaDir, paths.worktreesDir, `${noteaDir}/runs`, `${noteaDir}/agents`].map(shellQuote).join(' ');
  const marker = `.git/${SHARED_LAYOUT_MARKER}`;
  return [
    'set -e',
    `mkdir -p ${dirs}`,
    // setgid (2) so everything created below inherits the shared group.
    `chmod 2775 ${dirs}`,
    `cd ${shellQuote(paths.projectDir)}`,
    'git config core.sharedRepository group',
    `if [ ! -e ${shellQuote(marker)} ]; then`,
    // Only what this user owns. Objects an agent wrote belong to that member's uid,
    // and `dev` cannot chmod them -- nor does it need to: they are already
    // group-writable, because agents run with umask 002. Using `chmod -R` here
    // fails the whole setup, and therefore the run, as soon as one agent has
    // committed anything.
    '  find .git -user "$(id -u)" -exec chmod g+rwX {} +',
    '  find .git -user "$(id -u)" -type d -exec chmod g+s {} +',
    `  : > ${shellQuote(marker)}`,
    'fi',
  ].join('\n');
}

/**
 * Applies {@link sharedLayoutScript} through a runner that acts as the repository's
 * owner (`dev`). Safe to call before every run.
 */
export async function ensureSharedLayout(runner: CommandRunner, paths: GitPaths, noteaDir: string = DEFAULT_NOTEA_DIR): Promise<void> {
  await runOrThrow(runner, sharedLayoutScript(paths, noteaDir), { cwd: paths.projectDir });
}
