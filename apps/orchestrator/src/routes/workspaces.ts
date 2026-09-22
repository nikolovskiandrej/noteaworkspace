import { timingSafeEqual } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ClientKindSchema, WorkspaceRoleSchema, type AgentExecFrame, type IssueConnectTokenResponse } from '@notea/protocol';
import { collectAgentExec, type AgentExecRunner } from '../docker/agent-exec';
import type { WorkspaceRuntimeApi } from '../docker/workspace-runtime';
import { RuntimeError } from '../errors';
import type { TokenService } from '../tokens';

const AGENT_READY_TIMEOUT_MS = 60_000;
/** Well inside the 300 s after which Node's fetch gives up on a silent response body. */
const EXEC_KEEPALIVE_MS = 30_000;

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

const AgentExecSchema = z.object({
  uid: z.number().int(),
  cmd: z.array(z.string()).min(1).max(64),
  cwd: z.string().max(4096).optional(),
  env: z.record(z.string(), z.string()).optional(),
  unsetEnv: z.array(z.string()).max(32).optional(),
  tty: z.boolean().optional(),
  stream: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const KillAgentExecSchema = z.object({ uid: z.number().int() });

export interface WorkspaceRoutesDeps {
  runtime: WorkspaceRuntimeApi;
  tokens: TokenService;
  apiKey: string;
  agentExec: AgentExecRunner;
  /** Interval of keepalive frames on streamed agent execs; tests shorten it. */
  execKeepaliveMs?: number;
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

  /**
   * Runs one process in a workspace container under a given Unix uid.
   *
   * The control plane is the only caller (shared API key, same as every other route
   * here). The uid range and the fixed gid are enforced in `buildAgentExecOptions`,
   * so a compromised control plane still cannot ask for root or for the `dev` user
   * whose shells the workspace's humans share.
   */
  app.post<{ Params: { id: string } }>('/workspaces/:id/agent-exec', async (request, reply) => {
    const body = parseBody(AgentExecSchema, request.body);
    const containerId = await runningContainerId(deps, request.params.id);
    const handle = await deps.agentExec.start(containerId, body);
    if (body.stream !== true) return collectAgentExec(handle);

    const frames = new PassThrough();
    const write = (frame: AgentExecFrame) => {
      if (!frames.writableEnded) frames.write(`${JSON.stringify(frame)}\n`);
    };
    write({ type: 'started', execId: handle.execId });
    // A quiet process must not look like a finished one to the client.
    const keepalive = setInterval(() => write({ type: 'keepalive' }), deps.execKeepaliveMs ?? EXEC_KEEPALIVE_MS);
    let exited = false;
    handle.stdout.on('data', (chunk: Buffer) => write({ type: 'out', data: chunk.toString('utf8') }));
    handle.stderr.on('data', (chunk: Buffer) => write({ type: 'err', data: chunk.toString('utf8') }));
    void handle.done
      .then((outcome) => write({ type: 'exit', exitCode: outcome.exitCode, timedOut: outcome.timedOut }))
      .catch(() => write({ type: 'exit', exitCode: null, timedOut: false }))
      .finally(() => {
        exited = true;
        clearInterval(keepalive);
        frames.end();
      });
    // The stream is the process's only watcher. If the caller goes away first (the
    // worker crashed, or a restart outlasted its drain), stop the process, as the
    // workspace agent does with a disconnected client's execs.
    reply.raw.on('close', () => {
      if (!exited) void deps.agentExec.kill(containerId, handle.execId, body.uid).catch(() => undefined);
    });
    reply.header('content-type', 'application/x-ndjson');
    reply.header('cache-control', 'no-store');
    return reply.send(frames);
  });

  app.post<{ Params: { id: string; execId: string } }>('/workspaces/:id/agent-exec/:execId/kill', async (request, reply) => {
    const body = parseBody(KillAgentExecSchema, request.body);
    const containerId = await runningContainerId(deps, request.params.id);
    await deps.agentExec.kill(containerId, request.params.execId, body.uid);
    reply.code(204);
    return null;
  });

  app.post('/connect-tokens', async (request): Promise<IssueConnectTokenResponse> => {
    const body = parseBody(IssueConnectTokenSchema, request.body);
    const issued = await deps.tokens.issueConnectToken(
      { sub: body.userId, ws: body.workspaceId, name: body.name, role: body.role, kind: body.kind ?? 'user' },
      body.ttlSeconds,
    );
    return { ...issued, wsPath: `/ws/workspaces/${encodeURIComponent(body.workspaceId)}` };
  });
}

async function runningContainerId(deps: WorkspaceRoutesDeps, workspaceId: string): Promise<string> {
  const info = await deps.runtime.inspect(workspaceId);
  if (!info) throw new RuntimeError(404, 'not_found', `workspace runtime ${workspaceId} not found`);
  if (info.status !== 'running' || !info.containerId) {
    throw new RuntimeError(409, 'not_running', `workspace ${workspaceId} is ${info.status}; start it first`);
  }
  return info.containerId;
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
