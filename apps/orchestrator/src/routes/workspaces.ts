import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ClientKindSchema, WorkspaceRoleSchema, type IssueConnectTokenResponse } from '@notea/protocol';
import type { WorkspaceRuntimeApi } from '../docker/workspace-runtime';
import { RuntimeError } from '../errors';
import type { TokenService } from '../tokens';

const AGENT_READY_TIMEOUT_MS = 60_000;

const CreateWorkspaceSchema = z.object({
  workspaceId: z.string().min(1).max(64),
  image: z.string().min(1).max(256).optional(),
  resources: z
    .object({
      cpus: z.number().positive().max(64).optional(),
      memoryMb: z.number().int().positive().max(262_144).optional(),
      pidsLimit: z.number().int().positive().max(65_536).optional(),
    })
    .optional(),
  start: z.boolean().optional(),
  /** Wait until the agent answers its health check (default true when starting). */
  wait: z.boolean().optional(),
});

const IssueConnectTokenSchema = z.object({
  workspaceId: z.string().min(1).max(64),
  userId: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  role: WorkspaceRoleSchema,
  kind: ClientKindSchema.optional(),
  ttlSeconds: z.number().int().positive().optional(),
});

export interface WorkspaceRoutesDeps {
  runtime: WorkspaceRuntimeApi;
  tokens: TokenService;
  apiKey: string;
}

/**
 * Control-plane facing REST API. Every route requires the shared API key; the
 * control plane (apps/web) is the only intended caller. Browsers never call this.
 */
export async function registerWorkspaceRoutes(app: FastifyInstance, deps: WorkspaceRoutesDeps): Promise<void> {
  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !safeEqual(match[1] ?? '', deps.apiKey)) {
      throw new RuntimeError(401, 'unauthorized', 'missing or invalid API key');
    }
  });

  app.get('/workspaces', async () => ({ workspaces: await deps.runtime.list() }));

  app.post('/workspaces', async (request, reply) => {
    const body = parseBody(CreateWorkspaceSchema, request.body);
    const info = await deps.runtime.create(body);
    const shouldWait = body.start !== false && body.wait !== false;
    if (shouldWait) {
      await deps.runtime.waitForAgent(body.workspaceId, AGENT_READY_TIMEOUT_MS);
    }
    reply.code(201);
    return info;
  });

  app.get<{ Params: { id: string } }>('/workspaces/:id', async (request) => {
    const info = await deps.runtime.inspect(request.params.id);
    if (!info) throw new RuntimeError(404, 'not_found', `workspace runtime ${request.params.id} not found`);
    return info;
  });

  app.post<{ Params: { id: string } }>('/workspaces/:id/start', async (request) => {
    await deps.runtime.start(request.params.id);
    await deps.runtime.waitForAgent(request.params.id, AGENT_READY_TIMEOUT_MS);
    return deps.runtime.inspect(request.params.id);
  });

  app.post<{ Params: { id: string } }>('/workspaces/:id/stop', async (request) => deps.runtime.stop(request.params.id));

  app.delete<{ Params: { id: string }; Querystring: { deleteVolume?: string } }>(
    '/workspaces/:id',
    async (request, reply) => {
      await deps.runtime.remove(request.params.id, { deleteVolume: request.query.deleteVolume === 'true' });
      reply.code(204);
      return null;
    },
  );

  app.post('/connect-tokens', async (request): Promise<IssueConnectTokenResponse> => {
    const body = parseBody(IssueConnectTokenSchema, request.body);
    const issued = await deps.tokens.issueConnectToken(
      { sub: body.userId, ws: body.workspaceId, name: body.name, role: body.role, kind: body.kind ?? 'user' },
      body.ttlSeconds,
    );
    return { ...issued, wsPath: `/ws/workspaces/${encodeURIComponent(body.workspaceId)}` };
  });
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new RuntimeError(400, 'bad_request', detail);
  }
  return result.data;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
