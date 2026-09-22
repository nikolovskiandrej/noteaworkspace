import type { AgentExecFrame, AgentExecRequest, AgentExecResult } from '@notea/protocol';
import { AGENT_GIT_ENV } from './layout';
import { allCredentialEnvNames } from './providers';
import type { CommandRunner, ExecOutcome, WorkspaceSession } from './types';

/**
 * The orchestrator calls this session needs. Structural on purpose: `OrchestratorClient`
 * satisfies it, and tests can supply a fake without a container.
 */
export interface AgentExecTransport {
  agentExec(workspaceId: string, request: AgentExecRequest): Promise<AgentExecResult>;
  agentExecStream(
    workspaceId: string,
    request: AgentExecRequest,
  ): Promise<{ execId: string; frames: AsyncIterable<AgentExecFrame>; kill: () => Promise<void> }>;
}

export interface IsolatedAgentSessionOptions {
  workspaceId: string;
  /** The task owner's Unix uid inside the container (users.agent_uid). */
  uid: number;
  /** Default timeout for one-shot commands (git, setup). */
  commandTimeoutMs?: number;
  /** Largest file {@link IsolatedAgentSession.writeHostFile} will write (argv limit). */
  maxFileBytes?: number;
  /**
   * Environment added to every process this session starts. Defaults to
   * {@link AGENT_GIT_ENV}, which git needs because the agent uid is not the uid that
   * owns the repository. Never a place for credentials: those are per-run.
   */
  baseEnv?: Record<string, string>;
  /** Pause between attempts to stop a process whose stream was lost; tests shorten it. */
  lostProcessRetryMs?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const LOST_PROCESS_RETRY_MS = 2_000;
/** Attempts at stopping a process whose stream was lost: about half a minute at the default pause. */
const LOST_PROCESS_ATTEMPTS = 15;
/** Linux caps a single argv entry at 128 KiB; stay well below it. */
const DEFAULT_MAX_FILE_BYTES = 96 * 1024;

/**
 * Runs an agent's processes inside a workspace container **as the owning member's
 * own Unix uid**, through the orchestrator.
 *
 * This is the isolation boundary the product depends on. Every process started here
 * belongs to one Notea user: the kernel then refuses `/proc/<pid>/environ` to every
 * other uid in the container (`ptrace_may_access`), so a collaborator's shell — or a
 * *different member's agent* — cannot read the provider credential of a run in
 * flight. The same uid owns the agent's private HOME, so a CLI login is private too.
 *
 * It implements both {@link WorkspaceSession} (what the runtimes need to start and
 * watch a process) and {@link CommandRunner} (what the git helpers need), so nothing
 * above it has to know isolation exists: the runtimes stay provider- and
 * transport-agnostic.
 */
export class IsolatedAgentSession implements WorkspaceSession, CommandRunner {
  private readonly execs = new Map<string, ExecState>();

  constructor(
    private readonly transport: AgentExecTransport,
    private readonly options: IsolatedAgentSessionOptions,
  ) {}

  get uid(): number {
    return this.options.uid;
  }

  /** Shell command line, run to completion. Never throws on a non-zero exit. */
  async run(command: string, options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<ExecOutcome> {
    const result = await this.transport.agentExec(this.options.workspaceId, {
      uid: this.options.uid,
      cmd: ['/bin/bash', '-lc', command],
      cwd: options.cwd,
      env: this.envFor(options.env),
      unsetEnv: scrubList(options.env),
      timeoutMs: options.timeoutMs ?? this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    });
    return {
      exitCode: result.exitCode,
      signal: null,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async createTerminal(input: Parameters<WorkspaceSession['createTerminal']>[0]): Promise<{ sessionId: string }> {
    const started = await this.transport.agentExecStream(this.options.workspaceId, {
      uid: this.options.uid,
      cmd: [input.command, ...input.args],
      cwd: input.cwd,
      env: this.envFor(input.env),
      unsetEnv: scrubList(input.env),
      // No pty: the CLIs write their machine-readable stream to stdout either way,
      // and without one stderr stays separate and the output carries no escape codes.
      tty: false,
      // Backstop only: the run's own deadline in startTerminalRun fires first and
      // reports a proper `timeout` outcome. This keeps a lost process from living
      // past the run if that timer never fires.
      timeoutMs: input.timeoutMs ?? this.options.commandTimeoutMs,
    });

    const state: ExecState = { kill: started.kill, pendingOutput: [], exit: undefined, ended: false, outputListeners: [], exitListeners: [] };
    this.execs.set(started.execId, state);

    // Frames are pumped in the background and buffered until the caller attaches its
    // listeners, which it can only do after this method returns.
    void (async () => {
      try {
        for await (const frame of started.frames) {
          if (frame.type === 'out' || frame.type === 'err') emitOutput(state, frame.data);
          else if (frame.type === 'exit') settle(state, frame.exitCode);
        }
      } catch {
        /* the stream died; the exit below keeps the consumer from hanging */
      } finally {
        // No exit frame: the stream was lost, not the process, which may still be
        // running. Stop it rather than leave it editing a worktree the run is about
        // to commit, unwatched.
        if (!state.ended) void stopLostProcess(started.kill, this.options.lostProcessRetryMs ?? LOST_PROCESS_RETRY_MS);
        settle(state, state.exit ?? null);
      }
    })();

    return { sessionId: started.execId };
  }

  async killTerminal(sessionId: string): Promise<void> {
    await this.execs.get(sessionId)?.kill();
  }

  onTerminalOutput(sessionId: string, listener: (data: string) => void): () => void {
    const state = this.execs.get(sessionId);
    if (!state) return () => undefined;
    state.outputListeners.push(listener);
    const buffered = state.pendingOutput.splice(0);
    for (const data of buffered) listener(data);
    return () => {
      const index = state.outputListeners.indexOf(listener);
      if (index !== -1) state.outputListeners.splice(index, 1);
    };
  }

  onTerminalExit(sessionId: string, listener: (exitCode: number | null) => void): () => void {
    const state = this.execs.get(sessionId);
    if (!state) return () => undefined;
    if (state.ended) {
      listener(state.exit ?? null);
      return () => undefined;
    }
    state.exitListeners.push(listener);
    return () => {
      const index = state.exitListeners.indexOf(listener);
      if (index !== -1) state.exitListeners.splice(index, 1);
    };
  }

  async writeHostFile(path: string, content: string): Promise<void> {
    await this.write(path, content, false);
  }

  async ensureHostFile(path: string, content: string): Promise<void> {
    await this.write(path, content, true);
  }

  /**
   * Writes a file as the agent's own uid, so the run's artefacts belong to the member
   * the run belongs to. The content travels as base64 in argv rather than through a
   * shell string, so no quoting of user text is involved; argv is capped by the
   * kernel, hence the size guard.
   */
  private async write(path: string, content: string, onlyIfMissing: boolean): Promise<void> {
    const encoded = Buffer.from(content, 'utf8').toString('base64');
    const limit = this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (encoded.length > limit) throw new Error(`cannot write ${path}: content exceeds ${limit} bytes`);
    const script = [
      onlyIfMissing ? '[ -e "$2" ] && exit 0' : ':',
      'mkdir -p "$(dirname "$2")"',
      'printf %s "$1" | base64 -d > "$2"',
    ].join('\n');
    const result = await this.execArgv(['/bin/sh', '-c', script, 'notea-write', encoded, path]);
    if (result.exitCode !== 0) throw new Error(`failed to write ${path}: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`);
  }

  private async execArgv(cmd: string[]): Promise<AgentExecResult> {
    return this.transport.agentExec(this.options.workspaceId, {
      uid: this.options.uid,
      cmd,
      env: this.envFor(undefined),
      unsetEnv: scrubList(undefined),
      timeoutMs: 60_000,
    });
  }

  private envFor(env: Record<string, string> | undefined): Record<string, string> {
    return { ...(this.options.baseEnv ?? AGENT_GIT_ENV), ...(env ?? {}) };
  }
}

interface ExecState {
  kill: () => Promise<void>;
  pendingOutput: string[];
  exit: number | null | undefined;
  ended: boolean;
  outputListeners: ((data: string) => void)[];
  exitListeners: ((exitCode: number | null) => void)[];
}

function emitOutput(state: ExecState, data: string): void {
  if (state.outputListeners.length === 0) state.pendingOutput.push(data);
  else for (const listener of [...state.outputListeners]) listener(data);
}

/**
 * Keeps trying for a while, because the usual reason a stream is lost is an
 * orchestrator restart (a deploy): the kill fails until it is back, seconds later.
 * The orchestrator's own deadline for the process died with the old instance, so
 * nothing else would stop it.
 */
async function stopLostProcess(kill: () => Promise<void>, retryMs: number): Promise<void> {
  for (let attempt = 1; attempt <= LOST_PROCESS_ATTEMPTS; attempt += 1) {
    try {
      await kill();
      return;
    } catch {
      if (attempt < LOST_PROCESS_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

function settle(state: ExecState, exitCode: number | null): void {
  if (state.ended) return;
  state.ended = true;
  state.exit = exitCode;
  for (const listener of [...state.exitListeners]) listener(exitCode);
  state.exitListeners.length = 0;
}

/**
 * Every provider credential variable the process is *not* being given.
 *
 * Clearing them is what makes "this run uses a Claude subscription" a fact rather
 * than a hope: no ambient key from the image, a shell profile or a previous exec can
 * survive into the agent and quietly switch it to metered API billing.
 */
function scrubList(env: Record<string, string> | undefined): string[] {
  const provided = new Set(Object.keys(env ?? {}));
  return allCredentialEnvNames().filter((name) => !provided.has(name));
}
