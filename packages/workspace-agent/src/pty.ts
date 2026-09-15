/**
 * PTY abstraction. The session manager depends only on this interface so it can be
 * unit-tested with a fake on any OS, while the real implementation (node-pty) is
 * loaded lazily inside the Linux workspace container.
 */
export interface PtySpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface PtyExitEvent {
  exitCode: number;
  signal?: number;
}

export interface PtyProcess {
  readonly pid: number;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: PtyExitEvent) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type PtyFactory = (options: PtySpawnOptions) => PtyProcess;

/**
 * Real PTY factory backed by node-pty. Imported dynamically because node-pty is a
 * native module that is only guaranteed to be present inside the workspace image.
 */
export async function createNodePtyFactory(): Promise<PtyFactory> {
  const pty = await import('node-pty');
  return (options) => {
    const proc = pty.spawn(options.command, options.args, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
    });
    return {
      pid: proc.pid,
      onData: (callback) => {
        proc.onData(callback);
      },
      onExit: (callback) => {
        proc.onExit(callback);
      },
      write: (data) => proc.write(data),
      resize: (cols, rows) => proc.resize(cols, rows),
      kill: (signal) => proc.kill(signal),
    };
  };
}
