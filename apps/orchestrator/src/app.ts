import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import websocket from '@fastify/websocket';
import type { OrchestratorErrorBody } from '@notea/protocol';
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
  logger?: FastifyServerOptions['logger'];
  /** Serve the browser dev console at /dev/console (development only). */
  devConsole?: boolean;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });

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
    await registerWorkspaceRoutes(scoped, { runtime: deps.runtime, tokens: deps.tokens, apiKey: deps.apiKey });
  });
  if (deps.devConsole) {
    registerDevConsole(app, { runtime: deps.runtime, tokens: deps.tokens });
    app.log.warn('dev console enabled at /dev/console; never expose this host');
  }

  return app;
}
