import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { AGENT_HEALTH_PATH, AGENT_WS_PATH } from '@notea/protocol';
import type { AgentHub } from './hub';
import type { Logger } from './logger';

export interface AgentServerOptions {
  port: number;
  host?: string;
  /** Shared secret; the orchestrator presents it as `?token=` or a bearer header. */
  token: string;
  hub: AgentHub;
  log: Logger;
  workspaceId: string;
  agentVersion: string;
}

export interface AgentServer {
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
}

export function createAgentServer(opts: AgentServerOptions): AgentServer {
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://agent.local');
    if (req.method === 'GET' && url.pathname === AGENT_HEALTH_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          workspaceId: opts.workspaceId,
          agentVersion: opts.agentVersion,
          clients: opts.hub.clientCount,
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }));
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://agent.local');
    if (url.pathname !== AGENT_WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const presented = url.searchParams.get('token') ?? bearerToken(req.headers.authorization);
    if (!presented || !safeEqual(presented, opts.token)) {
      opts.log.warn('rejected websocket upgrade with bad token', { remote: req.socket.remoteAddress });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      opts.hub.addSocket(ws);
    });
  });

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(opts.port, opts.host ?? '0.0.0.0', () => {
          httpServer.off('error', reject);
          const address = httpServer.address() as AddressInfo;
          resolve({ port: address.port });
        });
      }),
    close: () =>
      new Promise((resolve) => {
        opts.hub.closeAll();
        wss.close();
        httpServer.close(() => resolve());
        // Do not wait on lingering keep-alive connections.
        httpServer.closeAllConnections();
      }),
  };
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
