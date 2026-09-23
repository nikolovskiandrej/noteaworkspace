import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WS_CLOSE, type AgentMessage, type AgentMessageOf, type ClientMessage } from '@notea/protocol';
import { AgentHub, FsService, ProcessManager, SessionManager, createAgentServer, silentLogger, type AgentServer } from '@notea/workspace-agent';
import { fakeProcessFactory, fakePtyFactory, type FakePty } from '@notea/workspace-agent/testing';
import { AgentTerminals } from '../src/agent-terminals';
import { buildApp } from '../src/app';
import type { WorkspaceRuntimeApi } from '../src/docker/workspace-runtime';
import { RuntimeError } from '../src/errors';
import { TokenService } from '../src/tokens';
import { FakeTtyRunner } from './fake-tty';

const noAgentExec = {
  start: async () => {
    throw new Error('agent exec not available in this test');
  },
  kill: async () => undefined,
};

const API_KEY = 'orchestrator-test-api-key';
const WORKSPACE_ID = 'ws-bridge';

let agentServer: AgentServer;
let agentPort: number;
let hub: AgentHub;
/** Delays the agent lookup, as a real `docker inspect` does, to widen the setup window. */
let resolveDelayMs = 0;
let spawned: FakePty[];
let app: FastifyInstance;
let baseUrl: string;
let tokens: TokenService;
let projectDir: string;

class TestClient {
  private readonly queue: AgentMessage[] = [];
  private readonly waiters: Array<(m: AgentMessage) => void> = [];
  readonly closed: Promise<number>;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as AgentMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
    this.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  }

  static async open(url: string): Promise<TestClient> {
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

  next(timeoutMs = 3000): Promise<AgentMessage> {
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
}

beforeAll(async () => {
  projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'notea-bridge-'));
  tokens = new TokenService({
    connectTokenSecret: 'c'.repeat(32),
    agentTokenSecret: 'a'.repeat(32),
    defaultTtlSeconds: 300,
    maxTtlSeconds: 3600,
  });

  const fake = fakePtyFactory();
  spawned = fake.spawned;
  let counter = 0;
  const sessions = new SessionManager({
    spawn: fake.factory,
    defaultCwd: projectDir,
    defaultCommand: '/bin/bash',
    defaultArgs: ['-l'],
    env: {},
    maxSessions: 4,
    scrollbackBytes: 1024,
    idGenerator: () => `s${++counter}`,
  });
  const processes = new ProcessManager({
    spawn: fakeProcessFactory().factory,
    defaultCwd: projectDir,
    baseEnv: {},
    maxProcesses: 4,
    maxOutputBytes: 1024 * 1024,
    defaultTimeoutMs: 60_000,
  });
  hub = new AgentHub({
    sessions,
    processes,
    fs: new FsService(projectDir),
    workspaceId: WORKSPACE_ID,
    projectDir,
    agentVersion: 'test',
    log: silentLogger,
  });
  agentServer = createAgentServer({
    port: 0,
    host: '127.0.0.1',
    token: tokens.agentToken(WORKSPACE_ID),
    hub,
    log: silentLogger,
    workspaceId: WORKSPACE_ID,
    agentVersion: 'test',
  });
  agentPort = (await agentServer.listen()).port;

  const runtime: WorkspaceRuntimeApi = {
    list: async () => [],
    create: async () => {
      throw new RuntimeError(500, 'internal', 'not used');
    },
    inspect: async () => null,
    start: async () => {
      throw new RuntimeError(500, 'internal', 'not used');
    },
    stop: async () => {
      throw new RuntimeError(500, 'internal', 'not used');
    },
    remove: async () => undefined,
    agentEndpoint: async (id) => {
      if (resolveDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, resolveDelayMs));
      return id === WORKSPACE_ID ? { host: '127.0.0.1', port: agentPort } : null;
    },
    waitForAgent: async () => ({ host: '127.0.0.1', port: agentPort }),
  };
  app = await buildApp({ runtime, tokens, apiKey: API_KEY, agentExec: noAgentExec, terminals: new AgentTerminals(new FakeTtyRunner()) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
  await agentServer.close();
  await fsp.rm(projectDir, { recursive: true, force: true });
});

async function issueToken(overrides: Partial<{ workspaceId: string; userId: string; name: string; role: string }> = {}) {
  const response = await fetch(`http://${baseUrl}/connect-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ workspaceId: WORKSPACE_ID, userId: 'u1', name: 'Andrej', role: 'owner', ...overrides }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { token: string; wsPath: string };
}

describe('orchestrator REST', () => {
  it('requires the api key', async () => {
    const response = await fetch(`http://${baseUrl}/workspaces`);
    expect(response.status).toBe(401);
    const withKey = await fetch(`http://${baseUrl}/workspaces`, { headers: { authorization: `Bearer ${API_KEY}` } });
    expect(withKey.status).toBe(200);
    expect(await withKey.json()).toEqual({ workspaces: [] });
  });

  it('validates connect token requests', async () => {
    const response = await fetch(`http://${baseUrl}/connect-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ workspaceId: WORKSPACE_ID, userId: 'u1', name: 'A', role: 'admin' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('returns 404 for unknown workspaces', async () => {
    const response = await fetch(`http://${baseUrl}/workspaces/nope`, { headers: { authorization: `Bearer ${API_KEY}` } });
    expect(response.status).toBe(404);
  });
});

describe('workspace bridge', () => {
  it('rejects missing or invalid tokens', async () => {
    const noToken = await TestClient.open(`ws://${baseUrl}/ws/workspaces/${WORKSPACE_ID}`);
    expect(await noToken.closed).toBe(WS_CLOSE.UNAUTHORIZED);
    const badToken = await TestClient.open(`ws://${baseUrl}/ws/workspaces/${WORKSPACE_ID}?token=nope`);
    expect(await badToken.closed).toBe(WS_CLOSE.UNAUTHORIZED);
  });

  it('closes with 4503 when the workspace is not running', async () => {
    const { token } = await issueToken({ workspaceId: 'ws-stopped' });
    const client = await TestClient.open(`ws://${baseUrl}/ws/workspaces/ws-stopped?token=${token}`);
    expect(await client.closed).toBe(WS_CLOSE.UPSTREAM_UNAVAILABLE);
  });

  it('bridges an identified session end to end', async () => {
    const { token, wsPath } = await issueToken();
    expect(wsPath).toBe(`/ws/workspaces/${WORKSPACE_ID}`);
    const client = await TestClient.open(`ws://${baseUrl}${wsPath}?token=${token}`);

    // Frames sent before the upstream is ready must be delivered after identify.
    client.send({ type: 'term.create', reqId: 'r1', cols: 80, rows: 24 });

    const hello = await client.nextOfType('hello');
    expect(hello.you).toMatchObject({ userId: 'u1', name: 'Andrej', role: 'owner', kind: 'user' });
    expect(hello.workspaceId).toBe(WORKSPACE_ID);

    const created = await client.nextOfType('term.created');
    expect(created.session.createdBy).toEqual({ userId: 'u1', name: 'Andrej', kind: 'user' });

    spawned[0]?.emitData('hello from pty\r\n');
    expect((await client.nextOfType('term.output')).data).toBe('hello from pty\r\n');

    client.send({ type: 'term.input', sessionId: created.session.id, data: 'ls\r' });
    client.send({ type: 'ping', reqId: 'p1' });
    await client.nextOfType('pong');
    expect(spawned[0]?.written).toEqual(['ls\r']);

    // A client cannot re-identify as somebody else.
    client.send({ type: 'identify', client: { id: 'x', userId: 'mallory', name: 'Mallory', kind: 'user', role: 'owner' } });
    client.send({ type: 'ping', reqId: 'p2' });
    await client.nextOfType('pong');
    client.send({ type: 'term.list', reqId: 'l1' });
    const listed = await client.nextOfType('term.listed');
    expect(listed.sessions[0]?.attachedClientIds).toEqual([hello.you.id]);

    client.ws.close(1000, 'done');
    expect(await client.closed).toBe(1000);
  });

  it('delivers frames a client sends while the connection is still being set up', async () => {
    // The web UI sends its first request as soon as the socket reports `open`, which
    // happens before the token check and the agent lookup have finished.
    resolveDelayMs = 100;
    try {
      const { token } = await issueToken();
      const client = await TestClient.open(`ws://${baseUrl}/ws/workspaces/${WORKSPACE_ID}?token=${token}`);
      client.send({ type: 'ping', reqId: 'early' });
      await client.nextOfType('hello');
      expect((await client.nextOfType('pong')).reqId).toBe('early');
      client.ws.close();
      await client.closed;
    } finally {
      resolveDelayMs = 0;
    }
  });

  it('opens no upstream for a client that leaves during setup', async () => {
    await new Promise((resolve) => setTimeout(resolve, 100)); // earlier tests' connections settle
    const before = hub.clientCount;
    resolveDelayMs = 100;
    try {
      const { token } = await issueToken();
      const client = await TestClient.open(`ws://${baseUrl}/ws/workspaces/${WORKSPACE_ID}?token=${token}`);
      client.ws.close();
      await client.closed;
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Otherwise the agent keeps a connection nobody will ever close: a ghost in presence.
      expect(hub.clientCount).toBe(before);
    } finally {
      resolveDelayMs = 0;
    }
  });

  it('enforces the viewer role through the bridge', async () => {
    const { token } = await issueToken({ userId: 'v1', name: 'Viewer', role: 'viewer' });
    const client = await TestClient.open(`ws://${baseUrl}/ws/workspaces/${WORKSPACE_ID}?token=${token}`);
    await client.nextOfType('hello');
    client.send({ type: 'term.create', reqId: 'r1', cols: 80, rows: 24 });
    const error = await client.nextOfType('error');
    expect(error.code).toBe('unauthorized');
    client.ws.close();
  });
});
