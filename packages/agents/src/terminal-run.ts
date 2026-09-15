import type { AgentRunEvent, AgentRunHandle, WorkspaceSession } from './types';

export interface TerminalRunOptions {
  command: string;
  args: string[];
  cwd: string;
  title: string;
  env?: Record<string, string>;
  maxMinutes: number;
  /** Turns raw output into events; return an empty array to swallow. */
  parseLine: (line: string) => AgentRunEvent[];
  /** Called once when the process exits, to produce the final event. */
  onExit: (exitCode: number | null, state: { cancelled: boolean; timedOut: boolean; sawFinished: boolean }) => AgentRunEvent;
}

/**
 * Runs a command in a watchable terminal session and turns its output lines into
 * an async event stream. Humans can attach to the same session in the UI while
 * the runtime consumes it.
 */
export async function startTerminalRun(session: WorkspaceSession, options: TerminalRunOptions): Promise<AgentRunHandle> {
  const { sessionId } = await session.createTerminal({
    cols: 200,
    rows: 50,
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    title: options.title,
    env: options.env,
    attach: true,
  });

  const queue: AgentRunEvent[] = [];
  let waiter: (() => void) | null = null;
  let ended = false;
  let cancelled = false;
  let timedOut = false;
  let sawFinished = false;
  let buffer = '';

  const push = (event: AgentRunEvent) => {
    if (event.type === 'finished') sawFinished = true;
    queue.push(event);
    waiter?.();
    waiter = null;
  };

  push({ type: 'started', sessionId, at: new Date().toISOString() });

  const offOutput = session.onTerminalOutput(sessionId, (data) => {
    buffer += data.replace(/\r/g, '');
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      for (const event of options.parseLine(line)) push(event);
      index = buffer.indexOf('\n');
    }
  });

  const timer = setTimeout(() => {
    timedOut = true;
    void session.killTerminal(sessionId).catch(() => undefined);
  }, options.maxMinutes * 60 * 1000);

  const offExit = session.onTerminalExit(sessionId, (exitCode) => {
    clearTimeout(timer);
    if (buffer.trim()) for (const event of options.parseLine(buffer)) push(event);
    buffer = '';
    push(options.onExit(exitCode, { cancelled, timedOut, sawFinished }));
    ended = true;
    waiter?.();
    waiter = null;
    offOutput();
    offExit();
  });

  const events: AsyncIterable<AgentRunEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<AgentRunEvent>> {
          for (;;) {
            const event = queue.shift();
            if (event) return { value: event, done: false };
            if (ended) return { value: undefined as never, done: true };
            await new Promise<void>((resolve) => {
              waiter = resolve;
            });
          }
        },
      };
    },
  };

  return {
    sessionId,
    events,
    cancel: async () => {
      cancelled = true;
      clearTimeout(timer);
      await session.killTerminal(sessionId).catch(() => undefined);
    },
  };
}

export function now(): string {
  return new Date().toISOString();
}
