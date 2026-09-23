import { PassThrough } from 'node:stream';
import type { AgentTerminalIdentity, AgentTerminalSize, AgentTtyHandle, AgentTtyRunner } from '../src/docker/agent-terminal';

/** A terminal process that exists only in memory: tests print to it and end it. */
export class FakeTty {
  readonly output = new PassThrough();
  readonly written: string[] = [];
  readonly sizes: AgentTerminalSize[] = [];
  exited = false;
  private resolveDone!: (code: number | null) => void;
  readonly handle: AgentTtyHandle;

  constructor(
    readonly containerId: string,
    readonly identity: AgentTerminalIdentity,
    readonly size: AgentTerminalSize,
  ) {
    const done = new Promise<number | null>((resolve) => {
      this.resolveDone = resolve;
    });
    this.handle = {
      output: this.output,
      write: (data) => {
        this.written.push(data);
      },
      resize: async (next) => {
        this.sizes.push(next);
      },
      done,
    };
  }

  print(text: string | Buffer): void {
    this.output.write(text);
  }

  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.output.end();
    this.resolveDone(code);
  }
}

/** Stands in for the Docker daemon in {@link AgentTerminals} and route tests. */
export class FakeTtyRunner implements AgentTtyRunner {
  readonly started: FakeTty[] = [];
  readonly stops: Array<{ containerId: string; uid: number }> = [];
  readonly prepared: string[] = [];
  failStart: Error | null = null;
  /** Holds `start` until released, to test what happens while a terminal is starting. */
  gate: Promise<void> | null = null;

  async prepare(containerId: string): Promise<void> {
    this.prepared.push(containerId);
  }

  async start(containerId: string, identity: AgentTerminalIdentity, size: AgentTerminalSize): Promise<AgentTtyHandle> {
    if (this.gate) await this.gate;
    if (this.failStart) throw this.failStart;
    const tty = new FakeTty(containerId, identity, size);
    this.started.push(tty);
    return tty.handle;
  }

  async stop(containerId: string, uid: number): Promise<void> {
    this.stops.push({ containerId, uid });
    // Like SIGHUP to the process group: the process ends and its stream with it.
    for (const tty of this.started) {
      if (tty.identity.uid === uid && tty.containerId === containerId && !tty.exited) tty.exit(129);
    }
  }

  /** The most recent terminal started for a uid. */
  last(uid: number): FakeTty {
    const tty = [...this.started].reverse().find((t) => t.identity.uid === uid);
    if (!tty) throw new Error(`no terminal started for uid ${uid}`);
    return tty;
  }
}
