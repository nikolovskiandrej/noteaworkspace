import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type Docker from 'dockerode';
import type { AgentExecRequest, AgentExecResult } from '@notea/protocol';
import { RuntimeError } from '../errors';
import { HOME_MOUNT_PATH } from './spec';

/** Output kept per stream for a buffered exec before it is cut. */
export const MAX_BUFFERED_OUTPUT = 8 * 1024 * 1024;
export const MAX_EXEC_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000;

/** Environment variable names Notea will inject. Deliberately narrow. */
export const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Names that must never be set through this endpoint. `PATH`/`LD_*` would let a
 * caller swap the binaries the agent runs; `NOTEA_*` is the container's own
 * namespace (it carries the workspace agent token); `HOME` decides where a CLI
 * looks for -- and writes -- its credentials.
 */
export const RESERVED_ENV_NAMES = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'IFS', 'BASH_ENV', 'ENV', 'NODE_OPTIONS']);
export const RESERVED_ENV_PREFIXES = ['LD_', 'NOTEA_'];

export interface AgentExecLimits {
  uidMin: number;
  uidMax: number;
  /** Primary gid every agent process runs with; the group that shares the project. */
  gid: number;
}

/**
 * Wrapper the agent process is started through. A fixed string: the orchestrator
 * never interpolates caller data into a shell command, so there is no place for
 * command injection. It does these things before handing over with `exec`:
 *
 *   - `umask 002`, so files the agent writes stay group-writable and the `dev`
 *     user (and the reaper) can still commit, rebase and delete them;
 *   - points HOME at a private per-uid directory (mode 0700), so a CLI's own
 *     credential file is readable only by the member it belongs to;
 *   - records its own pid, which is also its process-group id thanks to `setsid`,
 *     so cancellation can signal the whole tree rather than just the shell;
 *   - clears the credential variables this run must not see, so an agent can never
 *     inherit another authentication mode or another member's leftover export;
 *   - clears the workspace agent's own token, which every exec inherits from the
 *     container's environment. No agent process needs it, and whoever holds it can
 *     connect to the workspace agent as anyone.
 */
export const EXEC_WRAPPER = [
  'umask 002',
  'if [ -n "${NOTEA_EXEC_HOME:-}" ]; then mkdir -p "$NOTEA_EXEC_HOME" && chmod 700 "$NOTEA_EXEC_HOME" && HOME="$NOTEA_EXEC_HOME" && export HOME || exit 70; fi',
  'if [ -n "${NOTEA_EXEC_PIDFILE:-}" ]; then printf %s "$$" > "$NOTEA_EXEC_PIDFILE"; fi',
  'for __notea_v in ${NOTEA_EXEC_UNSET:-}; do unset "$__notea_v"; done',
  'unset NOTEA_EXEC_UNSET NOTEA_EXEC_PIDFILE NOTEA_EXEC_HOME NOTEA_AGENT_TOKEN __notea_v',
  'exec "$@"',
].join('\n');

export function pidFilePath(execId: string): string {
  return `/tmp/.notea-exec-${execId}.pid`;
}

/**
 * Private HOME for an agent uid, on the workspace's persistent volume.
 *
 * Each uid gets its own, created mode 0700 by the wrapper, because HOME is where
 * the vendor CLIs keep their own credential files (`~/.claude/.credentials.json`
 * and friends). Without this every agent would write into the shared `dev` HOME --
 * which it cannot do anyway, since that directory belongs to uid 1000 -- and one
 * member's CLI login would be readable by every other member of the workspace.
 * The caller cannot choose it: HOME is a reserved environment name.
 */
export function agentHomePath(uid: number): string {
  return `${HOME_MOUNT_PATH}/.notea/agents/${uid}`;
}

/**
 * Validates a request and turns it into Docker exec options.
 *
 * Pure, so the security-relevant invariants are unit-testable: the uid is inside
 * the agent range (never 0, never the `dev` user), the gid is fixed by the
 * orchestrator rather than the caller, the command is an argv array that is never
 * concatenated into a shell string, and reserved environment names are refused.
 */
export function buildAgentExecOptions(
  request: AgentExecRequest,
  limits: AgentExecLimits,
  execId: string,
): Docker.ExecCreateOptions {
  if (!Number.isInteger(request.uid) || request.uid < limits.uidMin || request.uid > limits.uidMax) {
    throw new RuntimeError(400, 'bad_request', `uid must be an integer in [${limits.uidMin}, ${limits.uidMax}]`);
  }
  if (!Array.isArray(request.cmd) || request.cmd.length === 0 || request.cmd.length > 64) {
    throw new RuntimeError(400, 'bad_request', 'cmd must be an argv array of 1-64 entries');
  }
  for (const arg of request.cmd) {
    if (typeof arg !== 'string' || arg.length > 1_000_000) throw new RuntimeError(400, 'bad_request', 'cmd entries must be strings');
  }
  if (request.cwd !== undefined && (typeof request.cwd !== 'string' || !request.cwd.startsWith('/') || request.cwd.includes('\0'))) {
    throw new RuntimeError(400, 'bad_request', 'cwd must be an absolute path');
  }

  const env: string[] = [];
  for (const [name, value] of Object.entries(request.env ?? {})) {
    assertAssignableEnvName(name);
    if (typeof value !== 'string' || value.includes('\0')) throw new RuntimeError(400, 'bad_request', `invalid value for ${name}`);
    env.push(`${name}=${value}`);
  }
  const unset = [...new Set(request.unsetEnv ?? [])];
  for (const name of unset) assertAssignableEnvName(name);

  env.push(`NOTEA_EXEC_HOME=${agentHomePath(request.uid)}`);
  env.push(`NOTEA_EXEC_PIDFILE=${pidFilePath(execId)}`);
  if (unset.length > 0) env.push(`NOTEA_EXEC_UNSET=${unset.join(' ')}`);

  return {
    // setsid -w: a new session, so the pid recorded by the wrapper is also the
    // process-group id and cancellation reaches the CLI's children; -w keeps the
    // exec attached to the real process instead of returning at fork time.
    Cmd: ['setsid', '-w', '/bin/sh', '-c', EXEC_WRAPPER, 'notea-agent-exec', ...request.cmd],
    Env: env,
    User: `${request.uid}:${limits.gid}`,
    WorkingDir: request.cwd,
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: request.tty === true,
  };
}

function assertAssignableEnvName(name: string): void {
  if (!ENV_NAME_PATTERN.test(name)) throw new RuntimeError(400, 'bad_request', `invalid environment variable name: ${String(name).slice(0, 40)}`);
  if (RESERVED_ENV_NAMES.has(name) || RESERVED_ENV_PREFIXES.some((p) => name.startsWith(p))) {
    throw new RuntimeError(400, 'bad_request', `environment variable ${name} is reserved`);
  }
}

export function clampTimeout(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_EXEC_TIMEOUT_MS;
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_EXEC_TIMEOUT_MS;
  return Math.min(Math.round(requested), MAX_EXEC_TIMEOUT_MS);
}

export interface AgentExecHandle {
  execId: string;
  /** Resolves when the process has exited or been killed. */
  done: Promise<{ exitCode: number | null; timedOut: boolean }>;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
}

export interface AgentExecRunner {
  start(containerId: string, request: AgentExecRequest): Promise<AgentExecHandle>;
  /** Signals the process group of a running exec. Safe to call for an unknown id. */
  kill(containerId: string, execId: string, uid: number): Promise<void>;
}

/**
 * Starts processes inside a workspace container under a caller-chosen uid.
 *
 * Only the Docker daemon can change uid for a container process, which is why this
 * lives in the orchestrator rather than in the in-container agent: the agent runs
 * as `dev` with `CapDrop: ALL` and `no-new-privileges` and cannot `setuid` (both
 * were tested against a live container). Everything else about the container's
 * hardening is untouched -- the exec inherits the same empty capability set.
 */
export class DockerAgentExec implements AgentExecRunner {
  constructor(
    private readonly docker: Docker,
    private readonly limits: AgentExecLimits,
  ) {}

  async start(containerId: string, request: AgentExecRequest): Promise<AgentExecHandle> {
    const execId = randomUUID();
    const options = buildAgentExecOptions(request, this.limits, execId);
    const container = this.docker.getContainer(containerId);
    const exec = await container.exec(options);
    const raw = await exec.start({ hijack: true, stdin: false });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    if (options.Tty) {
      raw.pipe(stdout);
      raw.on('end', () => stderr.end());
    } else {
      container.modem.demuxStream(raw, stdout, stderr);
      const endBoth = () => {
        stdout.end();
        stderr.end();
      };
      raw.on('end', endBoth);
      raw.on('error', endBoth);
    }

    let timedOut = false;
    const timeoutMs = clampTimeout(request.timeoutMs);
    const timer = setTimeout(() => {
      timedOut = true;
      void this.kill(containerId, execId, request.uid).catch(() => undefined);
    }, timeoutMs);

    const done = (async () => {
      await new Promise<void>((resolve) => {
        raw.on('end', () => resolve());
        raw.on('close', () => resolve());
        raw.on('error', () => resolve());
      });
      clearTimeout(timer);
      // The stream ends a moment before the daemon records the exit status.
      let exitCode: number | null = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const info = await exec.inspect().catch(() => null);
        if (info && !info.Running) {
          exitCode = info.ExitCode ?? null;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { exitCode, timedOut };
    })();

    return { execId, done, stdout, stderr };
  }

  /**
   * Kills the process group recorded by the wrapper, as the same uid that owns it.
   * Docker has no "kill exec" call, and the orchestrator will not run a privileged
   * exec to get one: signalling from inside the container under the process's own
   * uid needs no capability at all.
   */
  async kill(containerId: string, execId: string, uid: number): Promise<void> {
    if (!Number.isInteger(uid) || uid < this.limits.uidMin || uid > this.limits.uidMax) return;
    if (!/^[0-9a-f-]{36}$/.test(execId)) return;
    const container = this.docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', KILL_SCRIPT, 'notea-agent-kill', pidFilePath(execId)],
      User: `${uid}:${this.limits.gid}`,
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
    });
    await exec.start({ hijack: false, stdin: false });
  }
}

/** `kill -- -PID` signals the group; the fallback covers a process that never became a leader. */
const KILL_SCRIPT = [
  'pid=$(cat "$1" 2>/dev/null) || exit 0',
  '[ -n "$pid" ] || exit 0',
  'kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true',
  'sleep 5',
  'kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true',
  'rm -f "$1" 2>/dev/null || true',
].join('\n');

/** Collects a handle's output into a buffered result, cutting at the output cap. */
export async function collectAgentExec(handle: AgentExecHandle): Promise<AgentExecResult> {
  let truncated = false;
  const read = async (stream: NodeJS.ReadableStream): Promise<string> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (size + buffer.length > MAX_BUFFERED_OUTPUT) {
        truncated = true;
        continue;
      }
      size += buffer.length;
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  };
  const [stdout, stderr, outcome] = await Promise.all([read(handle.stdout), read(handle.stderr), handle.done]);
  return { execId: handle.execId, exitCode: outcome.exitCode, stdout, stderr, timedOut: outcome.timedOut, truncated };
}
