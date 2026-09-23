import { PassThrough } from 'node:stream';
import type Docker from 'dockerode';
import { RuntimeError } from '../errors';
import { EXEC_WRAPPER, agentHomePath, type AgentExecLimits } from './agent-exec';
import { HOME_MOUNT_PATH } from './spec';

/** The project every member's Claude works in: the workspace's main tree. */
export const PROJECT_DIR = `${HOME_MOUNT_PATH}/project`;

/** What a member's terminal runs: the Claude Code CLI, interactively. */
export const AGENT_TERMINAL_COMMAND: readonly string[] = ['claude'];

/**
 * In the environment of a terminal and, by inheritance, of everything it starts.
 * Stopping a terminal ends every process of the member's uid that carries it: that
 * reaches what the CLI detached into a session of its own, and never one of the
 * member's agent runs, which share the uid but not the marker. A member has at most
 * one terminal per workspace, so the marker needs no terminal id.
 */
export const AGENT_TERMINAL_MARKER = 'NOTEA_AGENT_TERMINAL=1';

export interface AgentTerminalSize {
  cols: number;
  rows: number;
}

/** The member a terminal runs as. */
export interface AgentTerminalIdentity {
  uid: number;
  /** Author and committer of the commits their Claude makes. */
  name: string;
  email: string;
}

/**
 * Pure: the Docker exec options for a member's interactive terminal.
 *
 * The same boundary as agent-exec (D-039): the uid must be inside the agent range
 * (never root, never `dev`), the gid is the orchestrator's, the command is a fixed
 * argv, and the process goes through {@link EXEC_WRAPPER}, which gives it the
 * member's private HOME — where the CLI keeps its login — and `umask 002`, so what it
 * writes into the shared project stays writable for the other members.
 *
 * Unlike agent-exec, not through `setsid`: Docker already makes the exec a session
 * leader with the pty as its controlling terminal, and a new session would lose it.
 * The CLI would then get no SIGWINCH when the terminal is resized, and a shell no
 * job control. Stopping does not need the process group (see STOP_TERMINAL_SCRIPT).
 */
export function buildAgentTerminalExecOptions(
  identity: AgentTerminalIdentity,
  limits: AgentExecLimits,
  size: AgentTerminalSize,
  command: readonly string[] = AGENT_TERMINAL_COMMAND,
): Docker.ExecCreateOptions {
  const { uid } = identity;
  if (!Number.isInteger(uid) || uid < limits.uidMin || uid > limits.uidMax) {
    throw new RuntimeError(400, 'bad_request', `uid must be an integer in [${limits.uidMin}, ${limits.uidMax}]`);
  }
  const cols = clampSize(size.cols, 10, 500);
  const rows = clampSize(size.rows, 4, 300);
  const name = gitIdentityValue(identity.name) || `Member ${uid}`;
  const email = gitIdentityValue(identity.email) || `member-${uid}@notea.local`;
  return {
    Cmd: ['/bin/sh', '-c', EXEC_WRAPPER, 'notea-agent-terminal', ...command],
    Env: [
      'TERM=xterm-256color',
      'COLORTERM=truecolor',
      AGENT_TERMINAL_MARKER,
      // The project's repository belongs to whichever uid created it, and git refuses
      // to work in another user's repository. Per process, as for agent runs (see
      // AGENT_GIT_ENV in @notea/agents), so no config file is widened.
      'GIT_CONFIG_COUNT=1',
      'GIT_CONFIG_KEY_0=safe.directory',
      'GIT_CONFIG_VALUE_0=*',
      `GIT_AUTHOR_NAME=${name}`,
      `GIT_AUTHOR_EMAIL=${email}`,
      `GIT_COMMITTER_NAME=${name}`,
      `GIT_COMMITTER_EMAIL=${email}`,
      // The image pins the CLI, and a member's uid could not replace it anyway.
      'DISABLE_AUTOUPDATER=1',
      `NOTEA_EXEC_HOME=${agentHomePath(uid)}`,
    ],
    User: `${uid}:${limits.gid}`,
    WorkingDir: PROJECT_DIR,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    ConsoleSize: [rows, cols],
  };
}

function clampSize(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Names and e-mails come from the control plane; keep control characters out of the environment. */
function gitIdentityValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
}

/**
 * Run as `dev`, which owns the project directory, before a terminal starts. Makes
 * the project shared through the `dev` group, the way the task worktrees already
 * are: directories group-writable and setgid (what a member's Claude creates below
 * them belongs to the group), files group-writable. It only touches what `dev`
 * owns; a member's files are shared already, because their processes run with
 * umask 002. Git refuses a repository another uid owns, and the project's belongs
 * to whichever member's Claude ran `git init`, so `dev` (the worker's integration,
 * the reaper) trusts every repository in its own container too.
 *
 * Failures of the `find`s are not fatal: an unreadable corner must not keep anyone
 * from their Claude.
 */
export const SHARE_PROJECT_SCRIPT = [
  'project="$1"',
  'mkdir -p "$project" || exit 1',
  'find "$project" -user "$(id -u)" -type d ! -perm -2070 -exec chmod g+rwxs {} + 2>/dev/null',
  'find "$project" -user "$(id -u)" -type f ! -perm -060 -exec chmod g+rw {} + 2>/dev/null',
  "git config --global --get-all safe.directory 2>/dev/null | grep -qxF '*' || git config --global --add safe.directory '*'",
  'if [ -d "$project/.git" ]; then git -C "$project" config core.sharedRepository group 2>/dev/null; fi',
  'exit 0',
].join('\n');

/**
 * Run as the member's uid, which can read its own processes' environments and no
 * one else's. Ends every process carrying {@link AGENT_TERMINAL_MARKER}: SIGHUP, as
 * when a terminal closes, then SIGKILL for whatever is left after five seconds.
 */
export const STOP_TERMINAL_SCRIPT = [
  'me=$(id -u)',
  'pids=""',
  'for dir in /proc/[0-9]*; do',
  '  pid=${dir#/proc/}',
  '  [ "$pid" = "$$" ] && continue',
  '  [ "$(stat -c %u "$dir" 2>/dev/null)" = "$me" ] || continue',
  `  tr '\\0' '\\n' < "$dir/environ" 2>/dev/null | grep -qxF '${AGENT_TERMINAL_MARKER}' && pids="$pids $pid"`,
  'done',
  '[ -n "$pids" ] || exit 0',
  'kill -HUP $pids 2>/dev/null',
  'i=0',
  'while [ "$i" -lt 20 ]; do',
  '  alive=""',
  '  for pid in $pids; do kill -0 "$pid" 2>/dev/null && alive="$alive $pid"; done',
  '  [ -n "$alive" ] || exit 0',
  '  sleep 0.25',
  '  i=$((i + 1))',
  'done',
  'kill -KILL $alive 2>/dev/null',
  'exit 0',
].join('\n');

/** A running terminal process, as the Docker daemon hands it over. */
export interface AgentTtyHandle {
  /** What the terminal prints. Ends when the process ends or the stream is lost. */
  output: NodeJS.ReadableStream;
  write(data: string): void;
  resize(size: AgentTerminalSize): Promise<void>;
  /** The exit code once the process has ended (null when Docker could not say). */
  done: Promise<number | null>;
}

export interface AgentTtyRunner {
  /** Makes the project writable for the members' uids ({@link SHARE_PROJECT_SCRIPT}). */
  prepare(containerId: string): Promise<void>;
  start(containerId: string, identity: AgentTerminalIdentity, size: AgentTerminalSize): Promise<AgentTtyHandle>;
  /**
   * Ends this member's terminal in the container, if one runs: the current one, or
   * one an earlier orchestrator left behind (Docker has no way to re-attach to an
   * exec, so a terminal whose stream was lost can only be ended).
   */
  stop(containerId: string, uid: number): Promise<void>;
}

/**
 * Starts members' terminals through the Docker daemon, which is the only thing that
 * can give a container process another uid (D-039). The pty is Docker's; this class
 * hands over its stream.
 */
export class DockerAgentTty implements AgentTtyRunner {
  constructor(
    private readonly docker: Docker,
    private readonly limits: AgentExecLimits,
    /** Tests replace the CLI with a shell. */
    private readonly command: readonly string[] = AGENT_TERMINAL_COMMAND,
  ) {}

  async prepare(containerId: string): Promise<void> {
    const result = await runScript(this.docker.getContainer(containerId), 'dev', SHARE_PROJECT_SCRIPT, [PROJECT_DIR]);
    if (result.exitCode !== 0) {
      throw new RuntimeError(500, 'prepare_failed', `could not share the project directory (exit ${String(result.exitCode)}): ${result.output.trim().slice(0, 300)}`);
    }
  }

  async start(containerId: string, identity: AgentTerminalIdentity, size: AgentTerminalSize): Promise<AgentTtyHandle> {
    const options = buildAgentTerminalExecOptions(identity, this.limits, size, this.command);
    const exec = await this.docker.getContainer(containerId).exec(options);
    const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
    const output = new PassThrough();
    stream.pipe(output);
    const done = (async () => {
      await new Promise<void>((resolve) => {
        stream.on('end', () => resolve());
        stream.on('close', () => resolve());
        stream.on('error', () => resolve());
      });
      output.end();
      // The stream ends a moment before the daemon records the exit status.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const info = await exec.inspect().catch(() => null);
        if (info && !info.Running) return info.ExitCode ?? null;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    })();
    return {
      output,
      write: (data) => {
        if (!stream.destroyed && stream.writable) stream.write(data);
      },
      resize: async ({ cols, rows }) => {
        await exec.resize({ h: clampSize(rows, 4, 300), w: clampSize(cols, 10, 500) });
      },
      done,
    };
  }

  async stop(containerId: string, uid: number): Promise<void> {
    if (!Number.isInteger(uid) || uid < this.limits.uidMin || uid > this.limits.uidMax) return;
    await runScript(this.docker.getContainer(containerId), `${uid}:${this.limits.gid}`, STOP_TERMINAL_SCRIPT, []);
  }
}

/** Runs a fixed script in the container and waits for it. Arguments arrive as `$1`…, never inside the script. */
async function runScript(container: Docker.Container, user: string, script: string, args: string[]): Promise<{ exitCode: number | null; output: string }> {
  const exec = await container.exec({
    Cmd: ['/bin/sh', '-c', script, 'notea-agent-terminal', ...args],
    User: user,
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const collected = new PassThrough();
  container.modem.demuxStream(stream, collected, collected);
  const chunks: Buffer[] = [];
  collected.on('data', (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve) => {
    stream.on('end', () => resolve());
    stream.on('close', () => resolve());
    stream.on('error', () => resolve());
  });
  let exitCode: number | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const info = await exec.inspect().catch(() => null);
    if (info && !info.Running) {
      exitCode = info.ExitCode ?? null;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { exitCode, output: Buffer.concat(chunks).toString('utf8') };
}
