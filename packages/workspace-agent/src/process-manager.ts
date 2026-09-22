import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { AgentError, errorMessage } from './errors';

export interface ProcessSpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface ProcessHandle {
  readonly pid: number;
  onStdout(callback: (chunk: Buffer) => void): void;
  onStderr(callback: (chunk: Buffer) => void): void;
  onExit(callback: (code: number | null, signal: string | null) => void): void;
  onError(callback: (error: Error) => void): void;
  writeStdin(data: string): void;
  endStdin(): void;
  kill(signal?: NodeJS.Signals): void;
}

export type ProcessFactory = (options: ProcessSpawnOptions) => ProcessHandle;

export interface ProcessManagerOptions {
  spawn: ProcessFactory;
  defaultCwd: string;
  baseEnv: Record<string, string>;
  maxProcesses: number;
  /** Total bytes of stdout+stderr allowed per process before it is killed. */
  maxOutputBytes: number;
  defaultTimeoutMs: number;
  killGraceMs?: number;
  idGenerator?: () => string;
}

export interface StartProcessInput {
  ownerId: string;
  command: string;
  args?: string[];
  shell?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ProcessEvents {
  output: [execId: string, ownerId: string, stream: 'stdout' | 'stderr', data: string];
  exit: [execId: string, ownerId: string, exitCode: number | null, signal: string | null, timedOut: boolean];
}

interface ManagedProcess {
  id: string;
  ownerId: string;
  handle: ProcessHandle;
  bytes: number;
  exited: boolean;
  /** Output passed maxOutputBytes: reported once, and nothing after it is forwarded. */
  overLimit: boolean;
  timedOut: boolean;
  timeoutTimer: NodeJS.Timeout;
  killTimer: NodeJS.Timeout | null;
}

/**
 * Non-interactive child processes ("exec"). Unlike terminal sessions they are bound
 * to the connection that started them: when that client disconnects, its processes
 * are killed. Long-running, watchable work belongs in a terminal session instead.
 */
export class ProcessManager extends EventEmitter<ProcessEvents> {
  private readonly processes = new Map<string, ManagedProcess>();

  constructor(private readonly opts: ProcessManagerOptions) {
    super();
  }

  start(input: StartProcessInput): { execId: string; pid: number } {
    if (this.processes.size >= this.opts.maxProcesses) {
      throw new AgentError('limit_exceeded', `at most ${this.opts.maxProcesses} concurrent processes`);
    }
    if (input.shell && input.args && input.args.length > 0) {
      throw new AgentError('bad_request', 'args cannot be combined with shell: true');
    }
    const command = input.shell ? '/bin/bash' : input.command;
    const args = input.shell ? ['-lc', input.command] : (input.args ?? []);
    const cwd = input.cwd ?? this.opts.defaultCwd;
    const env = { ...this.opts.baseEnv, ...(input.env ?? {}) };

    let handle: ProcessHandle;
    try {
      handle = this.opts.spawn({ command, args, cwd, env });
    } catch (err) {
      throw new AgentError('bad_request', `failed to start process: ${errorMessage(err)}`);
    }

    const id = (this.opts.idGenerator ?? randomUUID)();
    const timeoutMs = input.timeoutMs ?? this.opts.defaultTimeoutMs;
    const managed: ManagedProcess = {
      id,
      ownerId: input.ownerId,
      handle,
      bytes: 0,
      exited: false,
      overLimit: false,
      timedOut: false,
      timeoutTimer: setTimeout(() => {
        managed.timedOut = true;
        this.kill(id);
      }, timeoutMs),
      killTimer: null,
    };
    managed.timeoutTimer.unref();
    this.processes.set(id, managed);

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const onChunk = (stream: 'stdout' | 'stderr', decoder: StringDecoder) => (chunk: Buffer) => {
      if (managed.exited || managed.overLimit) return;
      managed.bytes += chunk.byteLength;
      const text = decoder.write(chunk);
      if (text) this.emit('output', id, managed.ownerId, stream, text);
      if (managed.bytes > this.opts.maxOutputBytes) {
        // A killed process keeps writing until it dies; say so once and drop the rest.
        managed.overLimit = true;
        this.emit('output', id, managed.ownerId, 'stderr', '\n[notea] output limit exceeded; process killed\n');
        this.kill(id);
      }
    };
    handle.onStdout(onChunk('stdout', stdoutDecoder));
    handle.onStderr(onChunk('stderr', stderrDecoder));
    handle.onError((error) => {
      // Spawn failures surface here asynchronously (e.g. ENOENT); report and finish.
      if (managed.exited) return;
      this.emit('output', id, managed.ownerId, 'stderr', `[notea] ${error.message}\n`);
      this.finish(managed, null, null);
    });
    handle.onExit((code, signal) => {
      const tail = stdoutDecoder.end();
      if (tail && !managed.overLimit) this.emit('output', id, managed.ownerId, 'stdout', tail);
      const errTail = stderrDecoder.end();
      if (errTail && !managed.overLimit) this.emit('output', id, managed.ownerId, 'stderr', errTail);
      this.finish(managed, code, signal);
    });

    return { execId: id, pid: handle.pid };
  }

  writeStdin(execId: string, ownerId: string, data: string, end: boolean): void {
    const managed = this.mustGet(execId, ownerId);
    if (data) managed.handle.writeStdin(data);
    if (end) managed.handle.endStdin();
  }

  /** SIGTERM, escalating to SIGKILL after the grace period. */
  kill(execId: string, ownerId?: string): void {
    const managed = this.mustGet(execId, ownerId);
    if (managed.exited) return;
    managed.handle.kill('SIGTERM');
    if (managed.killTimer) return;
    managed.killTimer = setTimeout(() => {
      if (!managed.exited) managed.handle.kill('SIGKILL');
    }, this.opts.killGraceMs ?? 5000);
    managed.killTimer.unref();
  }

  /** Kills every process owned by a client (on disconnect). */
  killOwnedBy(ownerId: string): void {
    for (const managed of this.processes.values()) {
      if (managed.ownerId === ownerId) this.kill(managed.id);
    }
  }

  get size(): number {
    return this.processes.size;
  }

  dispose(): void {
    for (const managed of this.processes.values()) {
      clearTimeout(managed.timeoutTimer);
      if (managed.killTimer) clearTimeout(managed.killTimer);
      try {
        managed.handle.kill('SIGKILL');
      } catch {
        // best effort
      }
    }
    this.processes.clear();
  }

  private finish(managed: ManagedProcess, code: number | null, signal: string | null): void {
    if (managed.exited) return;
    managed.exited = true;
    clearTimeout(managed.timeoutTimer);
    if (managed.killTimer) clearTimeout(managed.killTimer);
    this.processes.delete(managed.id);
    this.emit('exit', managed.id, managed.ownerId, code, signal, managed.timedOut);
  }

  private mustGet(execId: string, ownerId?: string): ManagedProcess {
    const managed = this.processes.get(execId);
    if (!managed || (ownerId !== undefined && managed.ownerId !== ownerId)) {
      throw new AgentError('not_found', `process ${execId} not found`);
    }
    return managed;
  }
}

/** Real implementation over child_process.spawn. */
export function createNodeProcessFactory(): ProcessFactory {
  // Imported lazily so unit tests on any OS can use a fake factory.
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  return (options) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });
    return {
      pid: child.pid ?? -1,
      onStdout: (callback) => child.stdout.on('data', callback),
      onStderr: (callback) => child.stderr.on('data', callback),
      onExit: (callback) => child.on('exit', (code, signal) => callback(code, signal)),
      onError: (callback) => child.on('error', callback),
      writeStdin: (data) => {
        if (child.stdin.writable) child.stdin.write(data);
      },
      endStdin: () => child.stdin.end(),
      kill: (signal) => {
        child.kill(signal);
      },
    };
  };
}
