import { describe, expect, it, vi } from 'vitest';
import { AgentError } from '../src/errors';
import { SessionManager, type SessionManagerOptions } from '../src/session-manager';
import { fakePtyFactory } from '../src/testing';

function makeManager(overrides: Partial<SessionManagerOptions> = {}) {
  const { factory, spawned } = fakePtyFactory({ exitOnKill: overrides.spawn ? true : true });
  let counter = 0;
  const manager = new SessionManager({
    spawn: factory,
    defaultCwd: '/home/dev/project',
    defaultCommand: '/bin/bash',
    defaultArgs: ['-l'],
    env: { PATH: '/usr/bin' },
    maxSessions: 3,
    scrollbackBytes: 1024,
    idGenerator: () => `s${++counter}`,
    now: () => new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });
  return { manager, spawned };
}

const creator = { userId: 'u1', name: 'Andrej', kind: 'user' as const };

describe('SessionManager', () => {
  it('creates a session with the default shell and emits opened', () => {
    const { manager, spawned } = makeManager();
    const opened = vi.fn();
    manager.on('opened', opened);

    const info = manager.create({ cols: 80, rows: 24, createdBy: creator });

    expect(info.id).toBe('s1');
    expect(info.command).toBe('/bin/bash');
    expect(info.args).toEqual(['-l']);
    expect(info.cwd).toBe('/home/dev/project');
    expect(info.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(info.pid).toBe(spawned[0]?.pid);
    expect(opened).toHaveBeenCalledWith(info);
    expect(spawned[0]?.options.env.PATH).toBe('/usr/bin');
  });

  it('resolves a relative working directory against the project directory', () => {
    const { manager, spawned } = makeManager();
    const relative = manager.create({ cols: 80, rows: 24, cwd: 'src/app', createdBy: creator });
    const absolute = manager.create({ cols: 80, rows: 24, cwd: '/home/dev/.notea/worktrees/t1', createdBy: creator });
    expect(relative.cwd).toBe('/home/dev/project/src/app');
    expect(spawned[0]?.options.cwd).toBe('/home/dev/project/src/app');
    expect(absolute.cwd).toBe('/home/dev/.notea/worktrees/t1');
  });

  it('uses no default args when a custom command is given', () => {
    const { manager } = makeManager();
    const info = manager.create({ cols: 80, rows: 24, command: 'htop', createdBy: null });
    expect(info.command).toBe('htop');
    expect(info.args).toEqual([]);
  });

  it('replays scrollback on attach and forwards output', () => {
    const { manager, spawned } = makeManager();
    const output = vi.fn();
    manager.on('output', output);
    const { id } = manager.create({ cols: 80, rows: 24, createdBy: creator });

    spawned[0]?.emitData('line one\r\n');
    const attached = manager.attach(id, 'c1');

    expect(attached.scrollback).toBe('line one\r\n');
    expect(attached.session.attachedClientIds).toEqual(['c1']);
    expect(output).toHaveBeenCalledWith(id, 'line one\r\n');
    expect(manager.attachedClients(id)).toEqual(['c1']);
  });

  it('writes input to the pty and resizes it', () => {
    const { manager, spawned } = makeManager();
    const resized = vi.fn();
    manager.on('resized', resized);
    const { id } = manager.create({ cols: 80, rows: 24, createdBy: creator });

    manager.input(id, 'ls\r');
    manager.resize(id, 120, 40);
    manager.resize(id, 120, 40); // no-op

    expect(spawned[0]?.written).toEqual(['ls\r']);
    expect(spawned[0]?.cols).toBe(120);
    expect(resized).toHaveBeenCalledTimes(1);
    expect(manager.get(id)?.rows).toBe(40);
  });

  it('detaches a client from every session on detachAll', () => {
    const { manager } = makeManager();
    const a = manager.create({ cols: 80, rows: 24, createdBy: creator });
    const b = manager.create({ cols: 80, rows: 24, createdBy: creator });
    manager.attach(a.id, 'c1');
    manager.attach(b.id, 'c1');
    manager.attach(b.id, 'c2');

    const affected = manager.detachAll('c1');

    expect(affected.sort()).toEqual([a.id, b.id].sort());
    expect(manager.attachedClients(a.id)).toEqual([]);
    expect(manager.attachedClients(b.id)).toEqual(['c2']);
  });

  it('removes the session and emits exit when the process ends', () => {
    const { manager, spawned } = makeManager();
    const exit = vi.fn();
    manager.on('exit', exit);
    const { id } = manager.create({ cols: 80, rows: 24, createdBy: creator });

    spawned[0]?.emitExit(3);

    expect(exit).toHaveBeenCalledWith(id, 3, null);
    expect(manager.get(id)).toBeNull();
    expect(manager.size).toBe(0);
    expect(() => manager.input(id, 'x')).toThrow(AgentError);
  });

  it('enforces the session limit', () => {
    const { manager } = makeManager();
    manager.create({ cols: 80, rows: 24, createdBy: creator });
    manager.create({ cols: 80, rows: 24, createdBy: creator });
    manager.create({ cols: 80, rows: 24, createdBy: creator });
    expect(() => manager.create({ cols: 80, rows: 24, createdBy: creator })).toThrow(
      /at most 3 terminal sessions/,
    );
  });

  it('translates spawn failures into bad_request errors', () => {
    const { factory } = fakePtyFactory({ failSpawn: true });
    const { manager } = makeManager({ spawn: factory });
    try {
      manager.create({ cols: 80, rows: 24, createdBy: creator });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AgentError);
      expect((err as AgentError).code).toBe('bad_request');
    }
  });

  it('kills with SIGHUP first and escalates to SIGKILL after the grace period', () => {
    vi.useFakeTimers();
    try {
      const { factory, spawned } = fakePtyFactory({ exitOnKill: false });
      const { manager } = makeManager({ spawn: factory, killGraceMs: 100 });
      const { id } = manager.create({ cols: 80, rows: 24, createdBy: creator });

      manager.kill(id);
      expect(spawned[0]?.killSignals).toEqual(['SIGHUP']);
      expect(manager.get(id)).not.toBeNull();

      vi.advanceTimersByTime(101);
      expect(spawned[0]?.killSignals).toEqual(['SIGHUP', 'SIGKILL']);
      expect(manager.get(id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills every session on dispose', () => {
    const { manager, spawned } = makeManager();
    manager.create({ cols: 80, rows: 24, createdBy: creator });
    manager.create({ cols: 80, rows: 24, createdBy: creator });
    manager.dispose();
    expect(manager.size).toBe(0);
    expect(spawned.every((p) => p.killSignals.includes('SIGKILL'))).toBe(true);
  });
});
