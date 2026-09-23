import { describe, expect, it } from 'vitest';
import type { AgentTerminalServerMessage } from '@notea/protocol';
import { AgentTerminals } from '../src/agent-terminals';
import { FakeTtyRunner } from './fake-tty';

const WS = 'ws-1';
const CONTAINER = 'container-1';
const andrej = { uid: 20_003, name: 'Andrej', email: 'andrej@notea.mk' };
const niche = { uid: 20_004, name: 'Niche', email: 'niche@notea.mk' };
const size = { cols: 80, rows: 24 };

function recorder() {
  const messages: AgentTerminalServerMessage[] = [];
  return {
    messages,
    listener: (message: AgentTerminalServerMessage) => messages.push(message),
    statuses: () => messages.flatMap((m) => (m.type === 'state' ? [m.terminal.status] : [])),
    output: () => messages.flatMap((m) => (m.type === 'output' ? [m.data] : [])).join(''),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('AgentTerminals', () => {
  it('starts a member’s terminal once, streams it to every viewer, and forwards input', async () => {
    const runner = new FakeTtyRunner();
    const terminals = new AgentTerminals(runner);
    const own = recorder();
    const watcher = recorder();
    const a = await terminals.attach(WS, andrej.uid, own.listener);
    a.resume();
    const b = await terminals.attach(WS, andrej.uid, watcher.listener);
    b.resume();
    expect(a.terminal.status).toBe('idle');

    await Promise.all([terminals.start(WS, CONTAINER, andrej, size), terminals.start(WS, CONTAINER, andrej, size)]);
    expect(runner.started).toHaveLength(1);
    expect(runner.prepared).toEqual([CONTAINER]);
    // Anything an earlier orchestrator left running is ended first.
    expect(runner.stops).toEqual([{ containerId: CONTAINER, uid: andrej.uid }]);
    expect(own.statuses()).toEqual(['starting', 'running']);
    expect(own.messages[0]).toEqual({ type: 'clear' });

    runner.last(andrej.uid).print('Welcome to Claude Code\r\n');
    await settle();
    expect(own.output()).toBe('Welcome to Claude Code\r\n');
    expect(watcher.output()).toBe('Welcome to Claude Code\r\n');

    terminals.input(WS, andrej.uid, 'hello\r');
    expect(runner.last(andrej.uid).written).toEqual(['hello\r']);
    // Another member's terminal is a different process.
    terminals.input(WS, niche.uid, 'nope');
    expect(runner.last(andrej.uid).written).toEqual(['hello\r']);
  });

  it('decodes characters split across chunks', async () => {
    const runner = new FakeTtyRunner();
    const terminals = new AgentTerminals(runner);
    const own = recorder();
    (await terminals.attach(WS, andrej.uid, own.listener)).resume();
    await terminals.start(WS, CONTAINER, andrej, size);
    const bytes = Buffer.from('│ ✻ Claude', 'utf8');
    runner.last(andrej.uid).print(bytes.subarray(0, 2));
    runner.last(andrej.uid).print(bytes.subarray(2));
    await settle();
    expect(own.output()).toBe('│ ✻ Claude');
  });

  it('gives a late viewer the screen so far, then only what is new', async () => {
    const runner = new FakeTtyRunner();
    const terminals = new AgentTerminals(runner);
    await terminals.start(WS, CONTAINER, andrej, size);
    const tty = runner.last(andrej.uid);
    tty.print('line one\r\n\u001b[32mgreen\u001b[0m line two\r\n');
    await settle();

    const late = recorder();
    const attached = await terminals.attach(WS, andrej.uid, late.listener);
    tty.print('line three\r\n');
    await settle();
    // Nothing is delivered before the snapshot has been sent.
    expect(late.messages).toEqual([]);
    attached.resume();
    expect(attached.terminal.status).toBe('running');
    expect(attached.screen).toContain('line one');
    expect(attached.screen).toContain('green');
    expect(attached.screen).not.toContain('line three');
    expect(late.output()).toBe('line three\r\n');
  });

  it('remembers the hyperlinks printed in a run, for viewers who arrive later', async () => {
    const runner = new FakeTtyRunner();
    const terminals = new AgentTerminals(runner);
    await terminals.start(WS, CONTAINER, andrej, size);
    const tty = runner.last(andrej.uid);
    const signIn = 'https://claude.com/cai/oauth/authorize?code=true&state=abc';
    const link = (uri: string, text: string) => `\u001b]8;;${uri}\u0007${text}\u001b]8;;\u0007`;
    tty.print(`${link(signIn, 'https://claude.com/cai/oauth/')}\r\n${link(signIn, 'authorize?code=true&state=abc')}\r\n`);
    tty.print(`${link('file:///etc/passwd', 'not a web link')} ${link('https://docs.example/a', 'docs')} ${link(signIn, 'again')}\r\n`);
    await settle();
    const attached = await terminals.attach(WS, andrej.uid, () => undefined);
    // Web links only, each once, the most recent last.
    expect(attached.links).toEqual(['https://docs.example/a', signIn]);
    // The snapshot itself has the text but not the links.
    expect(attached.screen).toContain('authorize?code=true&state=abc');
    expect(attached.screen).not.toContain('\u001b]8;');

    tty.exit(0);
    await settle();
    await terminals.start(WS, CONTAINER, andrej, size);
    await settle();
    expect((await terminals.attach(WS, andrej.uid, () => undefined)).links).toEqual([]);
  });

  it('keeps running without viewers, and records the exit', async () => {
    const runner = new FakeTtyRunner();
    const terminals = new AgentTerminals(runner);
    const own = recorder();
    const attached = await terminals.attach(WS, andrej.uid, own.listener);
    attached.resume();
    await terminals.start(WS, CONTAINER, andrej, size);
    attached.detach();
    expect(terminals.info(WS, andrej.uid)?.status).toBe('running');

    const watcher = recorder();
    (await terminals.attach(WS, andrej.uid, watcher.listener)).resume();
    runner.last(andrej.uid).exit(0);
    await settle();
    expect(watcher.statuses()).toEqual(['exited']);
    expect(terminals.info(WS, andrej.uid)).toMatchObject({ status: 'exited', exitCode: 0 });
  });

  it('forgets a terminal that has ended once nobody watches it', async () => {
    const runner = new FakeTtyRunner();
    const terminals = new AgentTerminals(runner);
    await terminals.start(WS, CONTAINER, andrej, size);
    runner.last(andrej.uid).exit(0);
    await settle();
    expect(terminals.size).toBe(0);
    expect(terminals.info(WS, andrej.uid)).toBeNull();
  });

  it('starts again after an exit, with an empty screen', async () => {
    const runner = new FakeTtyRunner();
    const terminals = new AgentTerminals(runner);
    const own = recorder();
    (await terminals.attach(WS, andrej.uid, own.listener)).resume();
    await terminals.start(WS, CONTAINER, andrej, size);
    runner.last(andrej.uid).print('first run\r\n');
    runner.last(andrej.uid).exit(1);
    await settle();
    await terminals.start(WS, CONTAINER, andrej, { cols: 120, rows: 40 });
    expect(runner.started).toHaveLength(2);
    expect(own.messages.filter((m) => m.type === 'clear')).toHaveLength(2);
    const second = await terminals.attach(WS, andrej.uid, () => undefined);
    expect(second.screen).not.toContain('first run');
    expect(second.terminal).toMatchObject({ status: 'running', cols: 120, rows: 40, exitCode: null });
  });

  it('reports a start that fails', async () => {
    const runner = new FakeTtyRunner();
    runner.failStart = new Error('container is not running');
    const terminals = new AgentTerminals(runner);
    const own = recorder();
    (await terminals.attach(WS, andrej.uid, own.listener)).resume();
    await terminals.start(WS, CONTAINER, andrej, size);
    expect(terminals.info(WS, andrej.uid)).toMatchObject({ status: 'exited', error: 'Claude could not start: container is not running' });
    expect(own.statuses()).toEqual(['starting', 'exited']);
  });

  it('resizes the pty and tells viewers the new size', async () => {
    const runner = new FakeTtyRunner();
    const terminals = new AgentTerminals(runner);
    const watcher = recorder();
    (await terminals.attach(WS, andrej.uid, watcher.listener)).resume();
    await terminals.start(WS, CONTAINER, andrej, size);
    await terminals.resize(WS, andrej.uid, { cols: 132, rows: 43 });
    await terminals.resize(WS, andrej.uid, { cols: 132, rows: 43 });
    expect(runner.last(andrej.uid).sizes).toEqual([{ cols: 132, rows: 43 }]);
    const last = watcher.messages.at(-1);
    expect(last).toMatchObject({ type: 'state', terminal: { cols: 132, rows: 43 } });
  });

  it('stops a running terminal, one that is still starting, and one it never knew', async () => {
    const runner = new FakeTtyRunner();
    const terminals = new AgentTerminals(runner);
    await terminals.start(WS, CONTAINER, andrej, size);
    await terminals.stop(WS, andrej.uid);
    await settle();
    expect(runner.last(andrej.uid).exited).toBe(true);

    let release!: () => void;
    runner.gate = new Promise((resolve) => {
      release = resolve;
    });
    const starting = terminals.start(WS, CONTAINER, niche, size);
    await settle();
    await terminals.stop(WS, niche.uid);
    release();
    await starting;
    await settle();
    expect(runner.last(niche.uid).exited).toBe(true);
    runner.gate = null;

    // After a restart the orchestrator has no entry, but the container may still run one.
    const fresh = new AgentTerminals(runner);
    await fresh.stop(WS, 20_009, CONTAINER);
    expect(runner.stops.at(-1)).toEqual({ containerId: CONTAINER, uid: 20_009 });
  });

  it('ends every terminal on shutdown', async () => {
    const runner = new FakeTtyRunner();
    const terminals = new AgentTerminals(runner);
    await terminals.start(WS, CONTAINER, andrej, size);
    await terminals.start('ws-2', 'container-2', niche, size);
    await terminals.shutdown();
    expect(runner.started.every((tty) => tty.exited)).toBe(true);
    expect(terminals.size).toBe(0);
    // Nothing starts once shutting down.
    await terminals.start(WS, CONTAINER, andrej, size);
    expect(runner.started).toHaveLength(2);
  });
});
