/**
 * `startTerminalRun` turns a terminal session into the event stream the worker
 * consumes with `for await`. The worker has no independent timeout, and its
 * heartbeat keeps refreshing while it waits, so a stream that never ends leaves the
 * task `running` forever and out of reach of stale-run recovery. These tests pin
 * down that the stream always terminates.
 */
import { describe, expect, it } from 'vitest';
import { now, startTerminalRun } from '../src/terminal-run';
import type { AgentRunEvent, WorkspaceSession } from '../src/types';

interface Controls {
  session: WorkspaceSession;
  emitOutput: (data: string) => void;
  emitExit: (exitCode: number | null) => void;
  killed: string[];
}

/** A session that only does what the test tells it to; it never reports an exit on its own. */
function controllableSession(): Controls {
  let outputListener: ((data: string) => void) | null = null;
  let exitListener: ((exitCode: number | null) => void) | null = null;
  const killed: string[] = [];
  return {
    killed,
    emitOutput: (data) => outputListener?.(data),
    emitExit: (exitCode) => exitListener?.(exitCode),
    session: {
      createTerminal: async () => ({ sessionId: 'session-1' }),
      killTerminal: async (sessionId) => void killed.push(sessionId),
      onTerminalOutput: (_id, listener) => {
        outputListener = listener;
        return () => {
          outputListener = null;
        };
      },
      onTerminalExit: (_id, listener) => {
        exitListener = listener;
        return () => {
          exitListener = null;
        };
      },
      writeHostFile: async () => undefined,
      ensureHostFile: async () => undefined,
    },
  };
}

const options = {
  command: '/bin/bash',
  args: ['-lc', 'true'],
  cwd: '/home/dev/project',
  title: 'agent: test',
  exitGraceMs: 20,
  parseLine: (line: string): AgentRunEvent[] => (line.trim() ? [{ type: 'log' as const, level: 'info' as const, text: line, at: now() }] : []),
  onExit: (exitCode: number | null, state: { cancelled: boolean; timedOut: boolean; sawFinished: boolean }): AgentRunEvent => ({
    type: 'finished',
    outcome: state.cancelled ? 'cancelled' : state.timedOut ? 'timeout' : exitCode === 0 ? 'completed' : 'failed',
    summary: null,
    exitCode,
    at: now(),
  }),
};

async function drain(events: AsyncIterable<AgentRunEvent>): Promise<AgentRunEvent[]> {
  const collected: AgentRunEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe('startTerminalRun', () => {
  it('ends on the session exit notification', async () => {
    const controls = controllableSession();
    const handle = await startTerminalRun(controls.session, { ...options, maxMinutes: 30 });
    const collected = drain(handle.events);

    controls.emitOutput('hello\n');
    controls.emitExit(0);

    const events = await collected;
    expect(events.at(0)).toMatchObject({ type: 'started', sessionId: 'session-1' });
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'completed', exitCode: 0 });
  });

  it('flushes a trailing line that never got a newline', async () => {
    const controls = controllableSession();
    const handle = await startTerminalRun(controls.session, { ...options, maxMinutes: 30 });
    const collected = drain(handle.events);

    controls.emitOutput('no trailing newline');
    controls.emitExit(0);

    const events = await collected;
    expect(events.some((e) => e.type === 'log' && e.text === 'no trailing newline')).toBe(true);
  });

  it('times out and ends even when the exit notification never arrives', async () => {
    const controls = controllableSession();
    // 6 ms: the run is killed almost immediately, and the session stays silent.
    const handle = await startTerminalRun(controls.session, { ...options, maxMinutes: 0.0001 });

    const events = await drain(handle.events);

    expect(controls.killed).toEqual(['session-1']);
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'timeout', exitCode: null });
  });

  it('cancels and ends even when the exit notification never arrives', async () => {
    const controls = controllableSession();
    const handle = await startTerminalRun(controls.session, { ...options, maxMinutes: 30 });
    const collected = drain(handle.events);

    await handle.cancel();

    const events = await collected;
    expect(controls.killed).toEqual(['session-1']);
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'cancelled', exitCode: null });
  });

  it('keeps the real exit when it arrives inside the grace period after a cancel', async () => {
    const controls = controllableSession();
    const handle = await startTerminalRun(controls.session, { ...options, maxMinutes: 30 });
    const collected = drain(handle.events);

    await handle.cancel();
    controls.emitExit(143);

    const events = await collected;
    const finished = events.filter((e) => e.type === 'finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ outcome: 'cancelled', exitCode: 143 });
  });
});
