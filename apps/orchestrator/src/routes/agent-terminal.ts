import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { WS_CLOSE, parseAgentTerminalClientMessage, type AgentTerminalServerMessage, type AgentTerminalTokenClaims } from '@notea/protocol';
import type { AgentTerminals } from '../agent-terminals';
import type { WorkspaceRuntimeApi } from '../docker/workspace-runtime';
import type { TokenService } from '../tokens';

export interface AgentTerminalRouteDeps {
  tokens: TokenService;
  runtime: Pick<WorkspaceRuntimeApi, 'inspect'>;
  terminals: AgentTerminals;
}

/**
 * What a client may send before its token has been checked: enough for a `start` and
 * some early keystrokes, and small, because anyone can open this socket.
 */
const MAX_PENDING_MESSAGES = 64;
const MAX_PENDING_BYTES = 1024 * 1024;

/**
 * One member's Claude terminal (D-045), for anyone in the workspace to watch.
 *
 * The token names the member whose terminal it is and whether the holder may type
 * (only that member, and only if they can write to the workspace). That is checked
 * here on every message: a viewer's input, resize, start or stop never reaches the
 * terminal, however the browser was modified.
 */
export function registerAgentTerminalRoute(app: FastifyInstance, deps: AgentTerminalRouteDeps): void {
  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/ws/workspaces/:id/agent-terminal',
    { websocket: true },
    async (socket, request) => {
      const workspaceId = request.params.id;
      const log = request.log.child({ workspaceId });

      // Listeners first, as in the bridge: the browser sends `start` as soon as the
      // socket opens, which may be before the token has been checked.
      let handle: ((raw: string) => void) | null = null;
      const pending: string[] = [];
      let pendingBytes = 0;
      let gone = false;
      let detach: (() => void) | null = null;
      socket.on('message', (data) => {
        const raw = data.toString();
        if (handle) {
          handle(raw);
          return;
        }
        pendingBytes += raw.length;
        if (pending.length >= MAX_PENDING_MESSAGES || pendingBytes > MAX_PENDING_BYTES) {
          pending.length = 0;
          socket.close(1008, 'too much data before the terminal was ready');
          return;
        }
        pending.push(raw);
      });
      socket.on('close', () => {
        gone = true;
        detach?.();
      });
      socket.on('error', (err) => log.warn({ err: err.message }, 'agent terminal socket error'));

      let claims: AgentTerminalTokenClaims;
      try {
        claims = await deps.tokens.verifyAgentTerminalToken(request.query.token ?? '', workspaceId);
      } catch (err) {
        log.info({ reason: (err as Error).message }, 'rejected agent terminal connection');
        socket.close(WS_CLOSE.UNAUTHORIZED, 'invalid terminal token');
        return;
      }
      const running = await runningContainer(deps, workspaceId);
      if (!running) {
        socket.close(WS_CLOSE.UPSTREAM_UNAVAILABLE, 'workspace is not running');
        return;
      }
      if (gone) return;

      const send = (message: AgentTerminalServerMessage) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      };
      const { owner } = claims;
      const attached = await deps.terminals.attach(workspaceId, owner.uid, send);
      if (gone) {
        attached.detach();
        return;
      }
      detach = attached.detach;
      send({
        type: 'hello',
        canInput: claims.input,
        owner: { userId: owner.userId, name: owner.name },
        terminal: attached.terminal,
        screen: attached.screen,
        links: attached.links,
      });
      attached.resume();
      log.info({ userId: claims.sub, ownerId: owner.userId, canInput: claims.input }, 'agent terminal attached');

      let refused = false;
      handle = (raw) => {
        const parsed = parseAgentTerminalClientMessage(raw);
        if (!parsed.ok) {
          send({ type: 'error', message: parsed.error });
          return;
        }
        if (!claims.input) {
          // Once per connection: a viewer's every keystroke would otherwise earn one.
          if (!refused) send({ type: 'error', message: `Only ${owner.name} can type in ${owner.name}'s Claude.` });
          refused = true;
          return;
        }
        const message = parsed.message;
        switch (message.type) {
          case 'input':
            deps.terminals.input(workspaceId, owner.uid, message.data);
            return;
          case 'resize':
            void deps.terminals.resize(workspaceId, owner.uid, { cols: message.cols, rows: message.rows });
            return;
          case 'start':
            void (async () => {
              // Looked up again: the workspace may have been restarted onto a new container.
              const containerId = await runningContainer(deps, workspaceId);
              if (!containerId) {
                send({ type: 'error', message: 'The workspace is not running.' });
                return;
              }
              await deps.terminals.start(workspaceId, containerId, { uid: owner.uid, name: owner.name, email: owner.email }, { cols: message.cols, rows: message.rows });
            })().catch((err: unknown) => {
              log.warn({ err: (err as Error).message }, 'agent terminal start failed');
              send({ type: 'error', message: 'Claude could not be started.' });
            });
            return;
          case 'stop':
            void deps.terminals.stop(workspaceId, owner.uid).catch((err: unknown) => {
              log.warn({ err: (err as Error).message }, 'agent terminal stop failed');
              send({ type: 'error', message: 'Claude could not be stopped.' });
            });
            return;
          default: {
            const exhaustive: never = message;
            send({ type: 'error', message: `unsupported message ${String(exhaustive)}` });
          }
        }
      };
      for (const raw of pending.splice(0)) handle(raw);
    },
  );
}

async function runningContainer(deps: AgentTerminalRouteDeps, workspaceId: string): Promise<string | null> {
  const info = await deps.runtime.inspect(workspaceId).catch(() => null);
  return info?.status === 'running' && info.containerId ? info.containerId : null;
}
