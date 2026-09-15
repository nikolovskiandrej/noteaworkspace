import type { ProcessFactory, ProcessHandle, ProcessSpawnOptions } from './process-manager';
import type { PtyExitEvent, PtyFactory, PtyProcess, PtySpawnOptions } from './pty';

export class FakeProcess implements ProcessHandle {
  static nextPid = 5000;

  readonly pid = FakeProcess.nextPid++;
  readonly stdin: string[] = [];
  stdinEnded = false;
  killSignals: string[] = [];
  exited = false;

  private readonly stdoutCallbacks: Array<(chunk: Buffer) => void> = [];
  private readonly stderrCallbacks: Array<(chunk: Buffer) => void> = [];
  private readonly exitCallbacks: Array<(code: number | null, signal: string | null) => void> = [];
  private readonly errorCallbacks: Array<(error: Error) => void> = [];

  constructor(
    public readonly options: ProcessSpawnOptions,
    private readonly exitOnKill = true,
  ) {}

  onStdout(callback: (chunk: Buffer) => void): void {
    this.stdoutCallbacks.push(callback);
  }
  onStderr(callback: (chunk: Buffer) => void): void {
    this.stderrCallbacks.push(callback);
  }
  onExit(callback: (code: number | null, signal: string | null) => void): void {
    this.exitCallbacks.push(callback);
  }
  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.push(callback);
  }
  writeStdin(data: string): void {
    this.stdin.push(data);
  }
  endStdin(): void {
    this.stdinEnded = true;
  }
  kill(signal?: NodeJS.Signals): void {
    this.killSignals.push(signal ?? 'SIGTERM');
    if (this.exitOnKill || signal === 'SIGKILL') this.emitExit(null, signal ?? 'SIGTERM');
  }
  emitStdout(text: string | Buffer): void {
    const chunk = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
    for (const callback of this.stdoutCallbacks) callback(chunk);
  }
  emitStderr(text: string): void {
    for (const callback of this.stderrCallbacks) callback(Buffer.from(text, 'utf8'));
  }
  emitError(error: Error): void {
    for (const callback of this.errorCallbacks) callback(error);
  }
  emitExit(code: number | null, signal: string | null = null): void {
    if (this.exited) return;
    this.exited = true;
    for (const callback of this.exitCallbacks) callback(code, signal);
  }
}

export function fakeProcessFactory(options: { exitOnKill?: boolean; failSpawn?: boolean } = {}) {
  const spawned: FakeProcess[] = [];
  const factory: ProcessFactory = (spawnOptions) => {
    if (options.failSpawn) throw new Error('spawn failed (fake)');
    const proc = new FakeProcess(spawnOptions, options.exitOnKill ?? true);
    spawned.push(proc);
    return proc;
  };
  return { factory, spawned };
}

export class FakePty implements PtyProcess {
  static nextPid = 1000;

  readonly pid = FakePty.nextPid++;
  readonly written: string[] = [];
  cols: number;
  rows: number;
  killSignals: string[] = [];
  exited = false;

  private readonly dataCallbacks: Array<(data: string) => void> = [];
  private readonly exitCallbacks: Array<(event: PtyExitEvent) => void> = [];

  constructor(
    public readonly options: PtySpawnOptions,
    private readonly exitOnKill = true,
  ) {
    this.cols = options.cols;
    this.rows = options.rows;
  }

  onData(callback: (data: string) => void): void {
    this.dataCallbacks.push(callback);
  }

  onExit(callback: (event: PtyExitEvent) => void): void {
    this.exitCallbacks.push(callback);
  }

  write(data: string): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  kill(signal?: string): void {
    this.killSignals.push(signal ?? 'SIGHUP');
    if (this.exitOnKill || signal === 'SIGKILL') this.emitExit(0, signal === 'SIGKILL' ? 9 : 1);
  }

  emitData(data: string): void {
    for (const callback of this.dataCallbacks) callback(data);
  }

  emitExit(exitCode: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const callback of this.exitCallbacks) callback({ exitCode, signal });
  }
}

export function fakePtyFactory(options: { exitOnKill?: boolean; failSpawn?: boolean } = {}) {
  const spawned: FakePty[] = [];
  const factory: PtyFactory = (spawnOptions) => {
    if (options.failSpawn) throw new Error('spawn failed (fake)');
    const pty = new FakePty(spawnOptions, options.exitOnKill ?? true);
    spawned.push(pty);
    return pty;
  };
  return { factory, spawned };
}
