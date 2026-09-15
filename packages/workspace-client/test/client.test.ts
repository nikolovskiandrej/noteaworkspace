import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClientIdentity } from '@notea/protocol';
import { AgentHub, FsService, ProcessManager, SessionManager, createAgentServer, silentLogger, type AgentServer } from '@notea/workspace-agent';
import { fakeProcessFactory, fakePtyFactory, type FakePty, type FakeProcess } from '@notea/workspace-agent/testing';
import { WorkspaceClient, WorkspaceRequestError } from '../src/client';

const TOKEN = 'client-test-token-1234567890';

/** Mimics the orchestrator: sends the identify frame first, then behaves as a normal socket. */
function identifyingWebSocket(identity: ClientIdentity): typeof WebSocket {
  return class IdentifyingWebSocket extends WebSocket {
    constructor(url: string | URL) {
      super(url);
      this.addEventListener('open', () => super.send(JSON.stringify({ type: 'identify', client: identity })), {
        once: true,
      });
    }
  };
}

let server: AgentServer;
let port: number;
let spawned: FakePty[];
let spawnedProcesses: FakeProcess[];
let projectDir: string;
let sessions: SessionManager;

async function startServer(listenPort = 0): Promise<number> {
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
  const processes = new ProcessManager({
    spawn: fakeProcs.factory,
    defaultCwd: projectDir,
    baseEnv: {},
    maxProcesses: 4,
    maxOutputBytes: 1024 * 1024,
    defaultTimeoutMs: 60_000,
  });
  const hub = new AgentHub({
    sessions,
    processes,
    fs: new FsService(projectDir),
    workspaceId: 'ws-client',
    projectDir,
    agentVersion: 'test',
    log: silentLogger,
    identifyTimeoutMs: 200,
  });
  server = createAgentServer({
    port: listenPort,
    host: '127.0.0.1',
    token: TOKEN,
    hub,
    log: silentLogger,
    workspaceId: 'ws-client',
    agentVersion: 'test',
  });
  return (await server.listen()).port;
}

const identity: ClientIdentity = { id: 'conn-1', userId: 'u1', name: 'Andrej', kind: 'user', role: 'owner' };

beforeEach(async () => {
  projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'notea-client-'));
  await fsp.writeFile(path.join(projectDir, 'a.txt'), 'A');
  port = await startServer();
});

afterEach(async () => {
  await server.close();
  sessions.dispose();
  await fsp.rm(projectDir, { recursive: true, force: true });
});

describe('WorkspaceClient', () => {
  it('connects, receives hello, and correlates requests with replies', async () => {
    const client = new WorkspaceClient({
      url: `ws://127.0.0.1:${port}/ws?token=${TOKEN}`,
      WebSocketImpl: identifyingWebSocket(identity),
    });
    const hello = await client.waitForHello();
    expect(hello.you.userId).toBe('u1');
    expect(client.state).toBe('open');

    const created = await client.createTerminal({ cols: 80, rows: 24, title: 't1' });
    expect(created.session.title).toBe('t1');

    const outputs: string[] = [];
    client.on('term.output', (m) => outputs.push(m.data));
    spawned[0]?.emitData('hi');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(outputs).toEqual(['hi']);

    client.input(created.session.id, 'ls\r');
    await client.ping();
    expect(spawned[0]?.written).toEqual(['ls\r']);

    const listed = await client.listFiles('');
    expect(listed.entries.map((e) => e.name)).toEqual(['a.txt']);
    const file = await client.readFile('a.txt');
    expect(file.content).toBe('A');
    const written = await client.writeFile('a.txt', 'B', file.etag);
    expect(written.etag).not.toBe(file.etag);

    client.close();
    expect(client.state).toBe('closed');
  });

  it('rejects requests with the agent error code', async () => {
    const client = new WorkspaceClient({
      url: `ws://127.0.0.1:${port}/ws?token=${TOKEN}`,
      WebSocketImpl: identifyingWebSocket({ ...identity, role: 'viewer' }),
    });
    await client.waitForHello();
    await expect(client.createTerminal({ cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(client.readFile('missing.txt')).rejects.toBeInstanceOf(WorkspaceRequestError);
    client.close();
  });

  it('stops after an authentication failure when the URL is static', async () => {
    // A plain socket never identifies, so the agent closes it with 4401 after its timeout.
    const client = new WorkspaceClient({
      url: `ws://127.0.0.1:${port}/ws?token=${TOKEN}`,
      minBackoffMs: 10,
    });
    const states: string[] = [];
    client.onStateChange(({ state }) => states.push(state));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(client.state).toBe('closed');
    expect(states).toEqual(['open', 'closed']);
  });

  it('keeps retrying after an authentication failure when a URL resolver can refresh the token', async () => {
    let calls = 0;
    const client = new WorkspaceClient({
      url: async () => {
        calls += 1;
        return `ws://127.0.0.1:${port}/ws?token=${TOKEN}`;
      },
      minBackoffMs: 10,
      maxBackoffMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(client.state).not.toBe('closed');
    expect(calls).toBeGreaterThan(1);
    client.close();
  });

  it('runs an exec to completion and collects its output', async () => {
    const client = new WorkspaceClient({
      url: `ws://127.0.0.1:${port}/ws?token=${TOKEN}`,
      WebSocketImpl: identifyingWebSocket(identity),
    });
    await client.waitForHello();
    const chunks: string[] = [];
    const resultPromise = client.runExec({ command: 'git status', shell: true }, (stream, data) => chunks.push(`${stream}:${data}`));
    await new Promise((resolve) => setTimeout(resolve, 50));
    spawnedProcesses[0]?.emitStdout('clean\n');
    spawnedProcesses[0]?.emitStderr('warn\n');
    spawnedProcesses[0]?.emitExit(0);
    const result = await resultPromise;
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, stdout: 'clean\n', stderr: 'warn\n' });
    expect(chunks).toEqual(['stdout:clean\n', 'stderr:warn\n']);
    client.close();
  });

  it('reconnects with backoff when the connection drops and re-announces hello', async () => {
    const client = new WorkspaceClient({
      url: `ws://127.0.0.1:${port}/ws?token=${TOKEN}`,
      WebSocketImpl: identifyingWebSocket(identity),
      minBackoffMs: 20,
      maxBackoffMs: 50,
    });
    await client.waitForHello();
    const states: string[] = [];
    client.onStateChange(({ state }) => states.push(state));

    // Simulate the agent going away and coming back on the same port.
    await server.close();
    sessions.dispose();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.state).toBe('reconnecting');
    await startServer(port);

    const hello = await client.waitForHello(5000);
    expect(hello.you.userId).toBe('u1');
    expect(states[0]).toBe('reconnecting');
    expect(states).toContain('open');
    client.close();
  });
});
