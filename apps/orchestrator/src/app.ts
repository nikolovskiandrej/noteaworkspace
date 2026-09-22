import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import websocket from '@fastify/websocket';
import type { OrchestratorErrorBody } from '@notea/protocol';
import type { AgentExecRunner } from './docker/agent-exec';
import type { WorkspaceRuntimeApi } from './docker/workspace-runtime';
import { RuntimeError } from './errors';
import { registerBridge } from './routes/bridge';
import { registerDevConsole } from './routes/dev-console';
import { registerWorkspaceRoutes } from './routes/workspaces';
import type { TokenService } from './tokens';

export interface AppDeps {
  runtime: WorkspaceRuntimeApi;
  tokens: TokenService;
  apiKey: string;
  /** Runs agent processes under a per-user uid; see docker/agent-exec.ts. */
  agentExec: AgentExecRunner;
  /** Keepalive interval on streamed agent execs (default 30 s); tests shorten it. */
  execKeepaliveMs?: number;
  logger?: FastifyServerOptions['logger'];
  /** Serve the browser dev console at /dev/console (development only). */
  devConsole?: boolean;
}

/**
 * Strips the query string from a URL before it reaches a log.
 *
 * Browsers and the worker open the bridge as `/ws/workspaces/<id>?token=<connect JWT>`,
 * and Fastify's default request serializer logs `req.url` verbatim — which would write
 * a live workspace credential (owner role included) into the orchestrator's log.
 * SECURITY_MODEL.md §3: never log tokens; logs carry ids only.
 */
export function redactQuery(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : `${url.slice(0, query)}?<redacted>`;
}

/**
 * Applies {@link redactQuery} to the request serializer. Applied last so a caller's
 * serializers cannot accidentally restore full-URL logging; a ready-made logger
 * instance is passed through untouched because it owns its own serializers.
 */
function withRedactedUrls(logger: AppDeps['logger']): FastifyServerOptions['logger'] {
  if (typeof logger !== 'object' || logger === null || 'child' in logger) return logger ?? false;
  const options = logger as Record<string, unknown>;
  const serializers = {
    ...((options.serializers as Record<string, unknown> | undefined) ?? {}),
    req: (request: FastifyRequest) => ({
      method: request.method,
      url: redactQuery(request.url),
      host: request.host,
      remoteAddress: request.ip,
    }),
  };
  return { ...options, serializers } as FastifyServerOptions['logger'];
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: withRedactedUrls(deps.logger) });

  app.setErrorHandler((err: unknown, _request, reply) => {
    if (err instanceof RuntimeError) {
      const body: OrchestratorErrorBody = { error: { code: err.code, message: err.message } };
      return reply.code(err.statusCode).send(body);
    }
    const rawStatus = (err as { statusCode?: unknown }).statusCode;
    const statusCode = typeof rawStatus === 'number' && rawStatus >= 400 ? rawStatus : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (statusCode >= 500) app.log.error({ err }, 'unhandled error');
    const body: OrchestratorErrorBody = {
      error: {
        code: statusCode >= 500 ? 'internal' : 'bad_request',
        message: statusCode >= 500 ? 'internal error' : message,
      },
    };
    return reply.code(statusCode).send(body);
  });

  app.get('/healthz', async () => ({ ok: true, service: 'notea-orchestrator' }));

  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });
  registerBridge(app, {
    tokens: deps.tokens,
    resolveAgent: (workspaceId) => deps.runtime.agentEndpoint(workspaceId),
  });
  await app.register(async (scoped) => {
    await registerWorkspaceRoutes(scoped, {
      runtime: deps.runtime,
      tokens: deps.tokens,
      apiKey: deps.apiKey,
      agentExec: deps.agentExec,
      execKeepaliveMs: deps.execKeepaliveMs,
    });
  });
  if (deps.devConsole) {
    registerDevConsole(app, { runtime: deps.runtime, tokens: deps.tokens });
    app.log.warn('dev console enabled at /dev/console; never expose this host');
  }

  return app;
}
