import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WS_CLOSE,
  type AgentMessage,
  type AgentMessageOf,
  type ClientIdentity,
  type ClientMessage,
} from '@notea/protocol';
import { FsService } from '../src/fs-service';
import { AgentHub } from '../src/hub';
import { silentLogger } from '../src/logger';
import { createAgentServer, type AgentServer } from '../src/server';
import { ProcessManager } from '../src/process-manager';
import { SessionManager } from '../src/session-manager';
import { fakeProcessFactory, fakePtyFactory, type FakeProcess, type FakePty } from '../src/testing';

const TOKEN = 'test-token-with-enough-length';

class TestClient {
  private readonly queue: AgentMessage[] = [];
  private readonly waiters: Array<(message: AgentMessage) => void> = [];
  readonly closed: Promise<number>;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as AgentMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
    this.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  }

  static async connect(url: string): Promise<TestClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new TestClient(ws);
  }

  send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  next(timeoutMs = 2000): Promise<AgentMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  async nextOfType<T extends AgentMessage['type']>(type: T): Promise<AgentMessageOf<T>> {
    for (;;) {
      const message = await this.next();
      if (message.type === type) return message as AgentMessageOf<T>;
    }
  }

  /** Waits until one message of each listed type has arrived, in any order. */
  async collectTypes<T extends AgentMessage['type']>(types: T[]): Promise<Map<T, AgentMessageOf<T>>> {
    const found = new Map<T, AgentMessageOf<T>>();
    while (found.size < types.length) {
      const message = await this.next();
      if (types.includes(message.type as T) && !found.has(message.type as T)) {
        found.set(message.type as T, message as AgentMessageOf<T>);
      }
    }
    return found;
  }

  close(): void {
    this.ws.close();
  }
}

let server: AgentServer;
let port: number;
let spawned: FakePty[];
let spawnedProcesses: FakeProcess[];
let sessions: SessionManager;
let processes: ProcessManager;
let projectDir: string;

function identity(overrides: Partial<ClientIdentity> = {}): ClientIdentity {
  return { id: 'conn-1', userId: 'u1', name: 'Andrej', kind: 'user', role: 'owner', ...overrides };
}

async function connectIdentified(id: ClientIdentity): Promise<TestClient> {
  const client = await TestClient.connect(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
  client.send({ type: 'identify', client: id });
  const hello = await client.nextOfType('hello');
  expect(hello.you.id).toBe(id.id);
  return client;
}

beforeEach(async () => {
  projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'notea-hub-'));
  await fsp.writeFile(path.join(projectDir, 'hello.txt'), 'hi\n');
  const fake = fakePtyFactory();
  spawned = fake.spawned;
  let counter = 0;
  sessions = new SessionManager({
    spawn: fake.factory,
    defaultCwd: projectDir,
    defaultCommand: '/bin/bash',
    defaultArgs: ['-l'],
    env: {},
    maxSessions: 4,
    scrollbackBytes: 1024,
    idGenerator: () => `s${++counter}`,
  });
  const fakeProcs = fakeProcessFactory();
  spawnedProcesses = fakeProcs.spawned;
  let execCounter = 0;
  processes = new ProcessManager({
    spawn: fakeProcs.factory,
    defaultCwd: projectDir,
    baseEnv: { PATH: '/usr/bin' },
    maxProcesses: 4,
    maxOutputBytes: 1024 * 1024,
    defaultTimeoutMs: 60_000,
    idGenerator: () => `e${++execCounter}`,
  });
  const hub = new AgentHub({
    sessions,
    processes,
    fs: new FsService(projectDir),
    workspaceId: 'ws-test',
    projectDir,
    agentVersion: 'test',
    log: silentLogger,
    identifyTimeoutMs: 300,
  });
  server = createAgentServer({
    port: 0,
    host: '127.0.0.1',
    token: TOKEN,
    hub,
    log: silentLogger,
    workspaceId: 'ws-test',
    agentVersion: 'test',
  });
  port = (await server.listen()).port;
});

afterEach(async () => {
  await server.close();
  sessions.dispose();
  processes.dispose();
  await fsp.rm(projectDir, { recursive: true, force: true });
});

describe('agent server + hub', () => {
  it('rejects the upgrade without a valid token', async () => {
    await expect(TestClient.connect(`ws://127.0.0.1:${port}/ws?token=wrong`)).rejects.toThrow(/401/);
    await expect(TestClient.connect(`ws://127.0.0.1:${port}/ws`)).rejects.toThrow(/401/);
  });

  it('closes connections whose first frame is not identify', async () => {
    const client = await TestClient.connect(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    client.send({ type: 'term.list', reqId: 'r1' });
    expect(await client.closed).toBe(WS_CLOSE.PROTOCOL_ERROR);
  });

  it('closes connections that never identify', async () => {
    const client = await TestClient.connect(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    expect(await client.closed).toBe(WS_CLOSE.UNAUTHORIZED);
  });

  it('serves the health endpoint', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, workspaceId: 'ws-test' });
  });

  it('creates a terminal, streams output and accepts input', async () => {
    const client = await connectIdentified(identity());
    client.send({ type: 'term.create', reqId: 'r1', cols: 100, rows: 30, title: 'main' });

    const created = await client.nextOfType('term.created');
    expect(created.reqId).toBe('r1');
    expect(created.attached).toBe(true);
    expect(created.session.title).toBe('main');
    expect(created.session.createdBy).toEqual({ userId: 'u1', name: 'Andrej', kind: 'user' });
    expect(created.session.attachedClientIds).toEqual(['conn-1']);

    spawned[0]?.emitData('$ ');
    const output = await client.nextOfType('term.output');
    expect(output).toEqual({ type: 'term.output', sessionId: 's1', data: '$ ' });

    client.send({ type: 'term.input', sessionId: 's1', data: 'echo hi\r' });
    client.send({ type: 'term.resize', sessionId: 's1', cols: 120, rows: 40 });
    const resized = await client.nextOfType('term.resized');
    expect(resized).toMatchObject({ sessionId: 's1', cols: 120, rows: 40 });
    expect(spawned[0]?.written).toEqual(['echo hi\r']);
    client.close();
  });

  it('shares a terminal between two clients and reports presence', async () => {
    const alice = await connectIdentified(identity({ id: 'conn-a', userId: 'alice', name: 'Alice' }));
    alice.send({ type: 'term.create', reqId: 'r1', cols: 80, rows: 24 });
    await alice.nextOfType('term.created');
    spawned[0]?.emitData('before bob joined\r\n');
    expect((await alice.nextOfType('term.output')).data).toBe('before bob joined\r\n');

    const bob = await connectIdentified(
      identity({ id: 'conn-b', userId: 'bob', name: 'Bob', role: 'editor' }),
    );
    bob.send({ type: 'term.attach', reqId: 'r2', sessionId: 's1' });
    const attached = await bob.nextOfType('term.attached');
    expect(attached.scrollback).toBe('before bob joined\r\n');
    expect(attached.session.attachedClientIds.sort()).toEqual(['conn-a', 'conn-b']);

    // Alice was told about Bob joining (and attaching) through presence broadcasts.
    for (;;) {
      const presence = await alice.nextOfType('presence');
      const bobPresence = presence.clients.find((c) => c.userId === 'bob');
      if (bobPresence?.attachedSessionIds.includes('s1')) {
        expect(presence.clients.map((c) => c.userId).sort()).toEqual(['alice', 'bob']);
        break;
      }
    }

    spawned[0]?.emitData('live\r\n');
    expect((await alice.nextOfType('term.output')).data).toBe('live\r\n');
    expect((await bob.nextOfType('term.output')).data).toBe('live\r\n');

    bob.close();
    for (;;) {
      const message = await alice.nextOfType('presence');
      if (message.clients.length === 1) {
        expect(message.clients[0]?.userId).toBe('alice');
        break;
      }
    }
    expect(sessions.attachedClients('s1')).toEqual(['conn-a']);
    alice.close();
  });

  it('broadcasts terminal exit and removes the session', async () => {
    const client = await connectIdentified(identity());
    client.send({ type: 'term.create', reqId: 'r1', cols: 80, rows: 24 });
    await client.nextOfType('term.created');
    client.send({ type: 'term.kill', reqId: 'r2', sessionId: 's1' });
    // The fake pty exits synchronously, so `term.exit` may precede the `term.killed` ack.
    const messages = await client.collectTypes(['term.killed', 'term.exit']);
    expect(messages.get('term.killed')?.sessionId).toBe('s1');
    expect(messages.get('term.exit')?.sessionId).toBe('s1');
    client.send({ type: 'term.list', reqId: 'r3' });
    expect((await client.nextOfType('term.listed')).sessions).toEqual([]);
    client.close();
  });

  it('denies mutating actions to viewers', async () => {
    const owner = await connectIdentified(identity());
    owner.send({ type: 'term.create', reqId: 'r1', cols: 80, rows: 24 });
    await owner.nextOfType('term.created');

    const viewer = await connectIdentified(identity({ id: 'conn-v', userId: 'v', name: 'Viewer', role: 'viewer' }));
    viewer.send({ type: 'term.create', reqId: 'r2', cols: 80, rows: 24 });
    const denied = await viewer.nextOfType('error');
    expect(denied).toMatchObject({ reqId: 'r2', code: 'unauthorized' });

    viewer.send({ type: 'term.attach', reqId: 'r3', sessionId: 's1' });
    await viewer.nextOfType('term.attached');
    viewer.send({ type: 'term.input', sessionId: 's1', data: 'rm -rf /\r' });
    expect((await viewer.nextOfType('error')).code).toBe('unauthorized');
    expect(spawned[0]?.written).toEqual([]);

    viewer.send({ type: 'fs.write', reqId: 'r4', path: 'x.txt', content: 'x' });
    expect((await viewer.nextOfType('error')).code).toBe('unauthorized');
    viewer.close();
    owner.close();
  });

  it('answers file requests', async () => {
    const client = await connectIdentified(identity());
    client.send({ type: 'fs.list', reqId: 'r1', path: '' });
    const listed = await client.nextOfType('fs.listed');
    expect(listed.entries.map((e) => e.name)).toEqual(['hello.txt']);

    client.send({ type: 'fs.read', reqId: 'r2', path: 'hello.txt' });
    const content = await client.nextOfType('fs.content');
    expect(content.content).toBe('hi\n');

    client.send({ type: 'fs.write', reqId: 'r3', path: 'hello.txt', content: 'bye\n', expectedEtag: 'stale' });
    expect((await client.nextOfType('error')).code).toBe('conflict');

    client.send({ type: 'fs.write', reqId: 'r4', path: 'hello.txt', content: 'bye\n', expectedEtag: content.etag });
    expect((await client.nextOfType('fs.written')).path).toBe('hello.txt');
    client.close();
  });

  it('runs exec processes for the requesting client only and kills them on disconnect', async () => {
    const owner = await connectIdentified(identity());
    const other = await connectIdentified(identity({ id: 'conn-2', userId: 'u2', name: 'Other', role: 'editor' }));

    owner.send({ type: 'exec.start', reqId: 'x1', command: 'git status', shell: true, env: { GIT_PAGER: 'cat' } });
    const started = await owner.nextOfType('exec.started');
    expect(started).toMatchObject({ reqId: 'x1', execId: 'e1' });
    expect(spawnedProcesses[0]?.options.args).toEqual(['-lc', 'git status']);
    expect(spawnedProcesses[0]?.options.env).toEqual({ PATH: '/usr/bin', GIT_PAGER: 'cat' });

    spawnedProcesses[0]?.emitStdout('clean\n');
    expect(await owner.nextOfType('exec.output')).toEqual({ type: 'exec.output', execId: 'e1', stream: 'stdout', data: 'clean\n' });

    // Another client cannot write to or kill somebody else's process.
    other.send({ type: 'exec.kill', reqId: 'k1', execId: 'e1' });
    expect((await other.nextOfType('error')).code).toBe('not_found');

    owner.send({ type: 'exec.stdin', execId: 'e1', data: 'q', end: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(spawnedProcesses[0]?.stdin).toEqual(['q']);
    expect(spawnedProcesses[0]?.stdinEnded).toBe(true);

    spawnedProcesses[0]?.emitExit(0);
    expect(await owner.nextOfType('exec.exit')).toEqual({ type: 'exec.exit', execId: 'e1', exitCode: 0, signal: null, timedOut: false });

    // Reserved environment names are rejected by validation.
    owner.send({ type: 'exec.start', reqId: 'x2', command: 'env', env: { PATH: '/tmp' } });
    expect((await owner.nextOfType('error')).code).toBe('bad_request');

    owner.send({ type: 'exec.start', reqId: 'x3', command: 'sleep', args: ['100'] });
    await owner.nextOfType('exec.started');
    owner.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(spawnedProcesses[1]?.killSignals).toEqual(['SIGTERM']);
    other.close();
  });

  it('broadcasts fs.changed after file writes and passes env to terminals', async () => {
    const writer = await connectIdentified(identity());
    const watcher = await connectIdentified(identity({ id: 'conn-w', userId: 'w', name: 'Watcher', role: 'viewer' }));
    writer.send({ type: 'fs.write', reqId: 'w1', path: 'notes.md', content: 'x' });
    const written = await writer.nextOfType('fs.written');
    const changed = await watcher.nextOfType('fs.changed');
    expect(changed).toMatchObject({ path: 'notes.md', kind: 'write', etag: written.etag, by: { userId: 'u1', kind: 'user' } });

    writer.send({ type: 'term.create', reqId: 't1', cols: 80, rows: 24, env: { ANTHROPIC_API_KEY: 'sk-test' } });
    await writer.nextOfType('term.created');
    expect(spawned[0]?.options.env).toMatchObject({ ANTHROPIC_API_KEY: 'sk-test' });
    writer.close();
    watcher.close();
  });

  it('reports validation errors without closing identified connections', async () => {
    const client = await connectIdentified(identity());
    client.ws.send('{"type":"term.resize","sessionId":"s1","cols":0,"rows":1}');
    const error = await client.nextOfType('error');
    expect(error.code).toBe('bad_request');
    client.send({ type: 'ping', reqId: 'p1' });
    expect((await client.nextOfType('pong')).reqId).toBe('p1');
    client.close();
  });
});
