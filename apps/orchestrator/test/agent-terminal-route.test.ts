import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WS_CLOSE, type AgentTerminalServerMessage, type IssueAgentTerminalTokenResponse, type WorkspaceRuntimeInfo } from '@notea/protocol';
import { AgentTerminals } from '../src/agent-terminals';
import { buildApp } from '../src/app';
import type { WorkspaceRuntimeApi } from '../src/docker/workspace-runtime';
import { TokenService } from '../src/tokens';
import { FakeTtyRunner } from './fake-tty';

const API_KEY = 'orchestrator-test-api-key';
const WS_ID = 'ws-terminals';
const andrej = { userId: 'u-andrej', name: 'Andrej', email: 'andrej@notea.mk', uid: 20_003 };
const niche = { userId: 'u-niche', name: 'Niche', email: 'niche@notea.mk', uid: 20_004 };

let app: FastifyInstance;
let base: string;
let tokens: TokenService;
let runner: FakeTtyRunner;
let terminals: AgentTerminals;
let running = true;
/** Delays the container lookup, as a real `docker inspect` does, to widen the setup window. */
let inspectDelayMs = 0;

function runtimeInfo(): WorkspaceRuntimeInfo {
  return {
    workspaceId: WS_ID,
    status: running ? 'running' : 'stopped',
    containerId: running ? 'container-1' : null,
    image: 'notea/workspace:dev',
    volumeName: 'v',
    resources: null,
    createdAt: null,
    startedAt: null,
    dockerStatus: running ? 'running' : 'exited',
  };
}

const runtime = {
  inspect: async (id: string) => {
    if (inspectDelayMs) await new Promise((resolve) => setTimeout(resolve, inspectDelayMs));
    return id === WS_ID ? runtimeInfo() : null;
  },
} as unknown as WorkspaceRuntimeApi;

const noAgentExec = {
  start: async () => {
    throw new Error('agent exec not available in this test');
  },
  kill: async () => undefined,
};

beforeAll(async () => {
  tokens = new TokenService({ connectTokenSecret: 'c'.repeat(32), agentTokenSecret: 'a'.repeat(32), defaultTtlSeconds: 300, maxTtlSeconds: 3600 });
  runner = new FakeTtyRunner();
  terminals = new AgentTerminals(runner);
  app = await buildApp({ runtime, tokens, apiKey: API_KEY, agentExec: noAgentExec, terminals });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  base = `127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await terminals.shutdown();
  await app.close();
});

beforeEach(async () => {
  running = true;
  inspectDelayMs = 0;
  await terminals.stop(WS_ID, andrej.uid);
  await terminals.stop(WS_ID, niche.uid);
});

async function issue(viewer: { userId: string; name: string }, owner: typeof andrej, role: 'owner' | 'editor' | 'viewer' = 'editor', apiKey = API_KEY) {
  const response = await fetch(`http://${base}/agent-terminal-tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: WS_ID, userId: viewer.userId, name: viewer.name, role, owner }),
  });
  return { status: response.status, body: (await response.json()) as IssueAgentTerminalTokenResponse };
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class Client {
  readonly messages: AgentTerminalServerMessage[] = [];
  readonly closed: Promise<number>;
  private wake: (() => void) | null = null;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      this.messages.push(JSON.parse(raw.toString()) as AgentTerminalServerMessage);
      this.wake?.();
    });
    this.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  }

  static async open(path: string, token: string, beforeOpen?: (ws: WebSocket) => void): Promise<Client> {
    const ws = new WebSocket(`ws://${base}${path}?token=${encodeURIComponent(token)}`);
    const client = new Client(ws);
    beforeOpen?.(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return client;
  }

  send(message: object): void {
    this.ws.send(JSON.stringify(message));
  }

  async find<T extends AgentTerminalServerMessage['type']>(
    type: T,
    predicate: (m: Extract<AgentTerminalServerMessage, { type: T }>) => boolean = () => true,
  ): Promise<Extract<AgentTerminalServerMessage, { type: T }>> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const found = this.messages.find((m) => m.type === type && predicate(m as Extract<AgentTerminalServerMessage, { type: T }>));
      if (found) return found as Extract<AgentTerminalServerMessage, { type: T }>;
      if (Date.now() > deadline) throw new Error(`no ${type} message; got ${JSON.stringify(this.messages).slice(0, 400)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
}

describe('agent terminal tokens', () => {
  it('require the API key', async () => {
    const { status } = await issue(andrej, andrej, 'owner', 'wrong-key-wrong-key');
    expect(status).toBe(401);
  });

  it('let only the terminal’s own member type, and only when they can write', async () => {
    expect((await issue(andrej, andrej, 'owner')).body.canInput).toBe(true);
    expect((await issue(niche, niche, 'editor')).body.canInput).toBe(true);
    expect((await issue(niche, andrej, 'editor')).body.canInput).toBe(false);
    expect((await issue(andrej, niche, 'owner')).body.canInput).toBe(false);
    expect((await issue(niche, niche, 'viewer')).body.canInput).toBe(false);
    expect((await issue(andrej, andrej)).body.wsPath).toBe(`/ws/workspaces/${WS_ID}/agent-terminal`);
  });
});

describe('agent terminal socket', () => {
  it('refuses a workspace connect token and a token for another workspace', async () => {
    const connect = await tokens.issueConnectToken({ sub: andrej.userId, ws: WS_ID, name: 'Andrej', role: 'owner', kind: 'user' });
    const client = await Client.open(`/ws/workspaces/${WS_ID}/agent-terminal`, connect.token);
    expect(await client.closed).toBe(WS_CLOSE.UNAUTHORIZED);

    const other = await tokens.issueAgentTerminalToken({ sub: andrej.userId, ws: 'ws-other', name: 'Andrej', role: 'owner', owner: andrej, input: true });
    const second = await Client.open(`/ws/workspaces/${WS_ID}/agent-terminal`, other.token);
    expect(await second.closed).toBe(WS_CLOSE.UNAUTHORIZED);
  });

  it('and a workspace token cannot open an agent terminal’s bridge counterpart either', async () => {
    const terminalToken = await tokens.issueAgentTerminalToken({ sub: andrej.userId, ws: WS_ID, name: 'Andrej', role: 'owner', owner: andrej, input: true });
    await expect(tokens.verifyConnectToken(terminalToken.token, WS_ID)).rejects.toThrow(/invalid connect token/);
  });

  it('closes when the workspace is not running', async () => {
    running = false;
    const { body } = await issue(andrej, andrej, 'owner');
    const client = await Client.open(body.wsPath, body.token);
    expect(await client.closed).toBe(WS_CLOSE.UPSTREAM_UNAVAILABLE);
  });

  it('lets the owner start, type into, resize and stop their terminal, sent even before the token is checked', async () => {
    const { body } = await issue(andrej, andrej, 'owner');
    // Queued on the socket before it opens: must not be lost while the token is checked.
    const client = await Client.open(body.wsPath, body.token, (ws) => ws.once('open', () => ws.send(JSON.stringify({ type: 'start', cols: 90, rows: 30 }))));
    const hello = await client.find('hello');
    expect(hello).toMatchObject({ canInput: true, owner: { userId: andrej.userId, name: 'Andrej' } });
    await client.find('state', (m) => m.terminal.status === 'running');
    const tty = runner.last(andrej.uid);
    expect(tty.identity).toEqual({ uid: 20_003, name: 'Andrej', email: 'andrej@notea.mk' });
    expect(tty.size).toEqual({ cols: 90, rows: 30 });
    expect(tty.containerId).toBe('container-1');

    client.send({ type: 'input', data: 'build me a todo app\r' });
    client.send({ type: 'resize', cols: 100, rows: 32 });
    await until(() => tty.sizes.length > 0);
    expect(tty.written).toEqual(['build me a todo app\r']);
    expect(tty.sizes).toEqual([{ cols: 100, rows: 32 }]);
    tty.print('✻ Thinking…');
    await client.find('output', (m) => m.data.includes('Thinking'));

    client.send({ type: 'stop' });
    await client.find('state', (m) => m.terminal.status === 'exited');
    client.ws.close();
  });

  it('lets anyone watch, and nobody else type', async () => {
    const own = await issue(andrej, andrej, 'owner');
    const owner = await Client.open(own.body.wsPath, own.body.token);
    await owner.find('hello');
    owner.send({ type: 'start', cols: 80, rows: 24 });
    await owner.find('state', (m) => m.terminal.status === 'running');
    const tty = runner.last(andrej.uid);
    tty.print('Welcome to Claude Code\r\n');

    const watch = await issue(niche, andrej, 'editor');
    const watcher = await Client.open(watch.body.wsPath, watch.body.token);
    const hello = await watcher.find('hello');
    expect(hello.canInput).toBe(false);
    expect(hello.terminal.status).toBe('running');
    expect(hello.screen).toContain('Welcome to Claude Code');

    watcher.send({ type: 'input', data: 'rm -rf /\r' });
    watcher.send({ type: 'input', data: 'again\r' });
    watcher.send({ type: 'resize', cols: 20, rows: 10 });
    watcher.send({ type: 'stop' });
    watcher.send({ type: 'start', cols: 80, rows: 24 });
    const refused = await watcher.find('error');
    expect(refused.message).toBe("Only Andrej can type in Andrej's Claude.");
    // The owner's keystroke, sent after the watcher's, arriving proves the watcher's were handled.
    owner.send({ type: 'input', data: 'x' });
    await until(() => tty.written.length > 0);
    expect(watcher.messages.filter((m) => m.type === 'error')).toHaveLength(1);
    expect(tty.written).toEqual(['x']);
    expect(tty.sizes).toEqual([]);
    expect(tty.exited).toBe(false);
    expect(runner.started.filter((t) => t.identity.uid === andrej.uid && !t.exited)).toHaveLength(1);

    // …but sees what the owner's Claude prints.
    tty.print('Done.\r\n');
    await watcher.find('output', (m) => m.data.includes('Done.'));
    owner.ws.close();
    watcher.ws.close();
  });

  it('closes a connection that sends too much before its token is checked', async () => {
    const { body } = await issue(andrej, andrej, 'owner');
    inspectDelayMs = 300;
    // Two 700 KB frames on open: more than the 1 MB held for an unverified client.
    const big = JSON.stringify({ type: 'input', data: 'x'.repeat(700 * 1024) });
    const client = await Client.open(body.wsPath, body.token, (ws) =>
      ws.once('open', () => {
        ws.send(big);
        ws.send(big);
      }),
    );
    expect(await client.closed).toBe(1008);
  });

  it('rejects malformed messages without closing', async () => {
    const { body } = await issue(andrej, andrej, 'owner');
    const client = await Client.open(body.wsPath, body.token);
    await client.find('hello');
    client.ws.send('{not json');
    expect((await client.find('error')).message).toBe('invalid JSON');
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.ws.close();
  });

  it('can be stopped over REST when a member leaves', async () => {
    await terminals.start(WS_ID, 'container-1', niche, { cols: 80, rows: 24 });
    const response = await fetch(`http://${base}/workspaces/${WS_ID}/agent-terminals/${niche.uid}/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(response.status).toBe(204);
    expect(runner.last(niche.uid).exited).toBe(true);
  });
});
