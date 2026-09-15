import type { AgentRunEvent, AgentRunHandle, WorkspaceSession } from './types';

/**
 * How long to wait for a session's exit notification after we kill it (timeout or
 * cancellation) before ending the stream without one. Generous enough for a healthy
 * container to report the exit, short enough that a lost notification does not
 * strand the run.
 */
export const EXIT_GRACE_MS = 10_000;

export interface TerminalRunOptions {
  command: string;
  args: string[];
  cwd: string;
  title: string;
  env?: Record<string, string>;
  maxMinutes: number;
  /** Overrides {@link EXIT_GRACE_MS}; tests use a short value. */
  exitGraceMs?: number;
  /** Turns raw output into events; return an empty array to swallow. */
  parseLine: (line: string) => AgentRunEvent[];
  /**
   * Called once when the process exits, to produce the final event. `state.summary`
   * carries the summary of a `finished` event the parser already emitted, so a
   * runtime that overrides the outcome on a non-zero exit can keep the CLI's own
   * explanation instead of reporting a bare failure.
   */
  onExit: (
    exitCode: number | null,
    state: { cancelled: boolean; timedOut: boolean; sawFinished: boolean; summary: string | null },
  ) => AgentRunEvent;
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
  let lastSummary: string | null = null;
  let buffer = '';

  const push = (event: AgentRunEvent) => {
    if (event.type === 'finished') {
      sawFinished = true;
      if (event.summary) lastSummary = event.summary;
    }
    queue.push(event);
    waiter?.();
    waiter = null;
  };

  push({ type: 'started', sessionId, at: new Date().toISOString() });

  let offOutput: () => void = () => undefined;
  let offExit: () => void = () => undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let grace: ReturnType<typeof setTimeout> | null = null;

  /**
   * Ends the stream exactly once.
   *
   * Everything terminal goes through here, including the fallback below: if the
   * session's exit notification never arrives (a dropped workspace connection, a
   * kill that is not acknowledged), the consumer's `for await` would block forever
   * while the run's heartbeat kept refreshing — so stale-run recovery, which looks
   * for a *stopped* heartbeat, would never reclaim the task and it would sit in
   * `running` permanently.
   */
  const settle = (event: AgentRunEvent) => {
    if (ended) return;
    if (timer) clearTimeout(timer);
    if (grace) clearTimeout(grace);
    if (buffer.trim()) for (const e of options.parseLine(buffer)) push(e);
    buffer = '';
    push(event);
    ended = true;
    waiter?.();
    waiter = null;
    offOutput();
    offExit();
  };

  /** Gives the session a moment to report the exit before we end the stream ourselves. */
  const settleAfterKill = () => {
    if (grace || ended) return;
    grace = setTimeout(() => settle(options.onExit(null, { cancelled, timedOut, sawFinished, summary: lastSummary })), options.exitGraceMs ?? EXIT_GRACE_MS);
  };

  offOutput = session.onTerminalOutput(sessionId, (data) => {
    buffer += data.replace(/\r/g, '');
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      for (const event of options.parseLine(line)) push(event);
      index = buffer.indexOf('\n');
    }
  });

  timer = setTimeout(() => {
    timedOut = true;
    void session.killTerminal(sessionId).catch(() => undefined);
    settleAfterKill();
  }, options.maxMinutes * 60 * 1000);

  offExit = session.onTerminalExit(sessionId, (exitCode) => {
    settle(options.onExit(exitCode, { cancelled, timedOut, sawFinished, summary: lastSummary }));
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
      if (timer) clearTimeout(timer);
      await session.killTerminal(sessionId).catch(() => undefined);
      settleAfterKill();
    },
  };
}

export function now(): string {
  return new Date().toISOString();
}

/** Removes ANSI escape sequences (colours, cursor control) from CLI output lines. */
const ESC = String.fromCharCode(27);
// Patterns are built from strings without backslashes: `[[]` is a literal `[`.
const ANSI_CSI = new RegExp(ESC + '[[][0-9;?]*[ -/]*[@-~]', 'g');
const ANSI_CHARSET = new RegExp(ESC + '[()][A-Z0-9]', 'g');
export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI, '').replace(ANSI_CHARSET, '');
}
