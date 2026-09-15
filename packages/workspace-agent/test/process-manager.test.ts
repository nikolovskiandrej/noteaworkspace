import { describe, expect, it, vi } from 'vitest';
import { AgentError } from '../src/errors';
import { ProcessManager, type ProcessManagerOptions } from '../src/process-manager';
import { fakeProcessFactory } from '../src/testing';

function makeManager(overrides: Partial<ProcessManagerOptions> = {}, fakeOptions: { exitOnKill?: boolean } = {}) {
  const { factory, spawned } = fakeProcessFactory(fakeOptions);
  let counter = 0;
  const manager = new ProcessManager({
    spawn: factory,
    defaultCwd: '/home/dev/project',
    baseEnv: { PATH: '/usr/bin', HOME: '/home/dev' },
    maxProcesses: 2,
    maxOutputBytes: 64,
    defaultTimeoutMs: 60_000,
    idGenerator: () => `e${++counter}`,
    ...overrides,
  });
  return { manager, spawned };
}

describe('ProcessManager', () => {
  it('spawns with merged environment and streams output to the owner', () => {
    const { manager, spawned } = makeManager();
    const output = vi.fn();
    const exit = vi.fn();
    manager.on('output', output);
    manager.on('exit', exit);

    const { execId, pid } = manager.start({ ownerId: 'c1', command: 'git', args: ['status'], env: { GIT_PAGER: 'cat' } });
    expect(execId).toBe('e1');
    expect(pid).toBe(spawned[0]?.pid);
    expect(spawned[0]?.options).toEqual({
      command: 'git',
      args: ['status'],
      cwd: '/home/dev/project',
      env: { PATH: '/usr/bin', HOME: '/home/dev', GIT_PAGER: 'cat' },
    });

    spawned[0]?.emitStdout('clean\n');
    spawned[0]?.emitStderr('warn\n');
    spawned[0]?.emitExit(0);
    expect(output).toHaveBeenNthCalledWith(1, 'e1', 'c1', 'stdout', 'clean\n');
    expect(output).toHaveBeenNthCalledWith(2, 'e1', 'c1', 'stderr', 'warn\n');
    expect(exit).toHaveBeenCalledWith('e1', 'c1', 0, null, false);
    expect(manager.size).toBe(0);
  });

  it('runs shell commands through bash -lc and rejects args with shell', () => {
    const { manager, spawned } = makeManager();
    manager.start({ ownerId: 'c1', command: 'git status && ls', shell: true });
    expect(spawned[0]?.options.command).toBe('/bin/bash');
    expect(spawned[0]?.options.args).toEqual(['-lc', 'git status && ls']);
    expect(() => manager.start({ ownerId: 'c1', command: 'ls', shell: true, args: ['-la'] })).toThrow(AgentError);
  });

  it('reassembles multi-byte characters split across chunks', () => {
    const { manager, spawned } = makeManager();
    const output = vi.fn();
    manager.on('output', output);
    manager.start({ ownerId: 'c1', command: 'x' });
    const euro = Buffer.from('€');
    spawned[0]?.emitStdout(euro.subarray(0, 2));
    spawned[0]?.emitStdout(euro.subarray(2));
    expect(output.mock.calls.map((c) => c[3]).join('')).toBe('€');
  });

  it('enforces ownership, limits and stdin semantics', () => {
    const { manager, spawned } = makeManager();
    const { execId } = manager.start({ ownerId: 'c1', command: 'cat' });
    manager.writeStdin(execId, 'c1', 'hello', true);
    expect(spawned[0]?.stdin).toEqual(['hello']);
    expect(spawned[0]?.stdinEnded).toBe(true);
    expect(() => manager.writeStdin(execId, 'c2', 'x', false)).toThrow(/not found/);
    expect(() => manager.kill(execId, 'c2')).toThrow(/not found/);

    manager.start({ ownerId: 'c2', command: 'sleep' });
    expect(() => manager.start({ ownerId: 'c1', command: 'x' })).toThrow(/at most 2/);
  });

  it('kills processes that exceed the output limit', () => {
    const { manager, spawned } = makeManager();
    const exit = vi.fn();
    manager.on('exit', exit);
    manager.start({ ownerId: 'c1', command: 'yes' });
    spawned[0]?.emitStdout('x'.repeat(65));
    expect(spawned[0]?.killSignals).toEqual(['SIGTERM']);
    expect(exit).toHaveBeenCalledWith('e1', 'c1', null, 'SIGTERM', false);
  });

  it('times out, escalates to SIGKILL and reports timedOut', () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeManager({ defaultTimeoutMs: 1000, killGraceMs: 100 }, { exitOnKill: false });
      const exit = vi.fn();
      manager.on('exit', exit);
      manager.start({ ownerId: 'c1', command: 'sleep' });
      vi.advanceTimersByTime(1001);
      expect(spawned[0]?.killSignals).toEqual(['SIGTERM']);
      vi.advanceTimersByTime(101);
      expect(spawned[0]?.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(exit).toHaveBeenCalledWith('e1', 'c1', null, 'SIGKILL', true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills every process of a disconnecting owner and reports spawn errors', () => {
    const { manager, spawned } = makeManager();
    manager.start({ ownerId: 'c1', command: 'a' });
    manager.start({ ownerId: 'c2', command: 'b' });
    manager.killOwnedBy('c1');
    expect(spawned[0]?.killSignals).toEqual(['SIGTERM']);
    expect(spawned[1]?.killSignals).toEqual([]);

    const exit = vi.fn();
    const output = vi.fn();
    manager.on('exit', exit);
    manager.on('output', output);
    const { execId } = manager.start({ ownerId: 'c3', command: 'missing-binary' });
    spawned[2]?.emitError(new Error('spawn missing-binary ENOENT'));
    expect(output).toHaveBeenCalledWith(execId, 'c3', 'stderr', '[notea] spawn missing-binary ENOENT\n');
    expect(exit).toHaveBeenCalledWith(execId, 'c3', null, null, false);
  });
});
