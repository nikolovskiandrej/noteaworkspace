import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { WebSocket, type RawData } from 'ws';
import { AGENT_WS_PATH, WS_CLOSE, type ClientIdentity, type ClientMessage } from '@notea/protocol';
import type { AgentEndpoint } from '../docker/workspace-runtime';
import type { TokenService } from '../tokens';

export interface BridgeDeps {
  tokens: TokenService;
  resolveAgent: (workspaceId: string) => Promise<AgentEndpoint | null>;
}

/**
 * Browser <-> workspace agent bridge. After verifying the connect token this is a
 * byte-for-byte pipe in both directions; the only frame the orchestrator originates
 * is the initial `identify`, which binds the verified identity to the connection.
 */
export function registerBridge(app: FastifyInstance, deps: BridgeDeps): void {
  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/ws/workspaces/:id',
    { websocket: true },
    async (client, request) => {
      const workspaceId = request.params.id;
      const log = request.log.child({ workspaceId });

      let claims;
      try {
        claims = await deps.tokens.verifyConnectToken(request.query.token ?? '', workspaceId);
      } catch (err) {
        log.info({ reason: (err as Error).message }, 'rejected workspace connection');
        client.close(WS_CLOSE.UNAUTHORIZED, 'invalid connect token');
        return;
      }

      let endpoint: AgentEndpoint | null = null;
      try {
        endpoint = await deps.resolveAgent(workspaceId);
      } catch (err) {
        log.error({ err }, 'failed to resolve workspace agent');
      }
      if (!endpoint) {
        client.close(WS_CLOSE.UPSTREAM_UNAVAILABLE, 'workspace is not running');
        return;
      }

      const identity: ClientIdentity = {
        id: randomUUID(),
        userId: claims.sub,
        name: claims.name,
        kind: claims.kind,
        role: claims.role,
      };
      const identify: ClientMessage = { type: 'identify', client: identity };
      const upstreamUrl = `ws://${endpoint.host}:${endpoint.port}${AGENT_WS_PATH}?token=${encodeURIComponent(
        deps.tokens.agentToken(workspaceId),
      )}`;
      const upstream = new WebSocket(upstreamUrl, { handshakeTimeout: 10_000 });
      const pending: Array<{ data: RawData; binary: boolean }> = [];
      let upstreamReady = false;

      log.info({ userId: identity.userId, role: identity.role, connectionId: identity.id }, 'bridging workspace connection');

      client.on('message', (data, isBinary) => {
        if (upstreamReady) upstream.send(data, { binary: isBinary });
        else pending.push({ data, binary: isBinary });
      });
      client.on('close', () => closeQuietly(upstream, 1000, 'client left'));
      client.on('error', (err) => {
        log.warn({ err }, 'client socket error');
        closeQuietly(upstream, 1011, 'client error');
      });

      upstream.on('open', () => {
        upstreamReady = true;
        upstream.send(JSON.stringify(identify));
        for (const frame of pending) upstream.send(frame.data, { binary: frame.binary });
        pending.length = 0;
      });
      upstream.on('message', (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      upstream.on('close', (code, reason) => {
        closeQuietly(client, translateCloseCode(code), reason.toString());
      });
      upstream.on('error', (err) => {
        log.warn({ err: err.message }, 'workspace agent connection error');
        closeQuietly(client, WS_CLOSE.UPSTREAM_UNAVAILABLE, 'workspace agent unreachable');
      });
    },
  );
}

/** Only forward close codes that the `ws` library allows a peer to send. */
function translateCloseCode(code: number): number {
  if (code === 1000 || code === 1001 || (code >= 4000 && code <= 4999)) return code;
  return 1011;
}

function closeQuietly(socket: WebSocket, code: number, reason: string): void {
  try {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
    }
  } catch {
    // socket already closing
  }
}
