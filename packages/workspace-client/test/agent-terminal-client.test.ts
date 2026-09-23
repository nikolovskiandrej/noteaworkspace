import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTerminalServerMessage } from '@notea/protocol';
import { AgentTerminalClient } from '../src/agent-terminal-client';

let server: WebSocketServer | null = null;
let client: AgentTerminalClient | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/** A stand-in for the orchestrator route: records what arrives and who connected. */
async function startServer(onConnection: (socket: ServerSocket, url: string) => void): Promise<number> {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  server.on('connection', (socket, request) => onConnection(socket, request.url ?? ''));
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
  return (server.address() as AddressInfo).port;
}

const hello: AgentTerminalServerMessage = {
  type: 'hello',
  canInput: true,
  owner: { userId: 'u1', name: 'Andrej' },
  terminal: { status: 'running', cols: 80, rows: 24, exitCode: null, startedAt: null, error: null },
  screen: 'Welcome',
  links: [],
};

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('AgentTerminalClient', () => {
  it('delivers messages and sends only while connected', async () => {
    const received: string[] = [];
    const port = await startServer((socket) => {
      socket.send(JSON.stringify(hello));
      socket.on('message', (raw) => received.push(raw.toString()));
    });
    const messages: AgentTerminalServerMessage[] = [];
    client = new AgentTerminalClient({ url: async () => `ws://127.0.0.1:${port}/t?token=a` });
    expect(client.send({ type: 'input', data: 'too early' })).toBe(false);
    client.onMessage((message) => messages.push(message));
    await until(() => messages.length === 1);
    expect(messages[0]).toEqual(hello);
    expect(client.state).toBe('open');
    expect(client.send({ type: 'input', data: 'hi\r' })).toBe(true);
    await until(() => received.length === 1);
    expect(JSON.parse(received[0]!)).toEqual({ type: 'input', data: 'hi\r' });
  });

  it('reconnects with a fresh URL after the server closes, whatever the code', async () => {
    const urls: string[] = [];
    let connections = 0;
    const port = await startServer((socket, url) => {
      urls.push(url);
      connections += 1;
      if (connections === 1) socket.close(4401, 'invalid terminal token');
      else socket.send(JSON.stringify(hello));
    });
    let issued = 0;
    const states: string[] = [];
    client = new AgentTerminalClient({ url: async () => `ws://127.0.0.1:${port}/t?token=${++issued}`, minBackoffMs: 10, maxBackoffMs: 20 });
    client.onStateChange(({ state }) => states.push(state));
    const messages: AgentTerminalServerMessage[] = [];
    client.onMessage((message) => messages.push(message));
    await until(() => messages.length === 1);
    expect(urls).toEqual(['/t?token=1', '/t?token=2']);
    expect(states).toEqual(['open', 'reconnecting', 'open']);
  });

  it('retries when the URL cannot be had, and stops for good when closed', async () => {
    let calls = 0;
    client = new AgentTerminalClient({
      url: async () => {
        calls += 1;
        throw new Error('token request failed (502)');
      },
      minBackoffMs: 5,
      maxBackoffMs: 10,
    });
    await until(() => calls >= 3);
    client.close();
    const after = calls;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(after);
    expect(client.state).toBe('closed');
  });
});
