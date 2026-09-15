import type { PtyExitEvent, PtyFactory, PtyProcess, PtySpawnOptions } from './pty';

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
