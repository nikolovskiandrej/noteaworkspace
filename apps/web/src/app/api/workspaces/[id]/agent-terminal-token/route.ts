import { and, eq, isNull } from 'drizzle-orm';
import { users, workspaces } from '@notea/db';
import { currentUserId } from '@/auth';
import { getMembershipRole } from '@/lib/authz';
import { getDb } from '@/lib/db';
import { env } from '@/lib/env';
import { getOrchestrator, OrchestratorError } from '@/lib/orchestrator';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Issues a short-lived token for one member's Claude terminal (D-045) and returns
 * the full WebSocket URL. Any member may watch any writer's terminal; the
 * orchestrator lets the holder type only when it is their own. The browser calls
 * this on every (re)connect.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: { code: 'unauthorized', message: 'sign in first' } }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { ownerId?: unknown } | null;
  const ownerId = typeof body?.ownerId === 'string' && UUID.test(body.ownerId) ? body.ownerId : null;
  if (!ownerId) return Response.json({ error: { code: 'bad_request', message: 'ownerId must be a member id' } }, { status: 400 });

  const { id: workspaceId } = await context.params;
  if (!UUID.test(workspaceId)) {
    return Response.json({ error: { code: 'not_found', message: 'workspace not found' } }, { status: 404 });
  }
  const db = getDb();
  const role = await getMembershipRole(db, workspaceId, userId);
  const workspace = role
    ? await db.query.workspaces.findFirst({ where: and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)) })
    : null;
  if (!role || !workspace) {
    return Response.json({ error: { code: 'not_found', message: 'workspace not found' } }, { status: 404 });
  }
  // Only members who can write have a Claude here.
  const ownerRole = ownerId === userId ? role : await getMembershipRole(db, workspaceId, ownerId);
  const [viewer, owner] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, userId), columns: { name: true } }),
    db.query.users.findFirst({ where: eq(users.id, ownerId), columns: { name: true, email: true, agentUid: true } }),
  ]);
  if (!ownerRole || ownerRole === 'viewer' || !owner) {
    return Response.json({ error: { code: 'not_found', message: 'terminal not found' } }, { status: 404 });
  }

  try {
    const issued = await getOrchestrator().issueAgentTerminalToken({
      workspaceId,
      userId,
      name: viewer?.name ?? 'user',
      role,
      owner: { userId: ownerId, name: owner.name, email: owner.email, uid: owner.agentUid },
    });
    const config = env();
    const base = (config.ORCHESTRATOR_PUBLIC_URL ?? config.ORCHESTRATOR_URL).replace(/^http/, 'ws').replace(/\/$/, '');
    return Response.json({
      url: `${base}${issued.wsPath}?token=${encodeURIComponent(issued.token)}`,
      expiresAt: issued.expiresAt,
      canInput: issued.canInput,
    });
  } catch (err) {
    if (err instanceof OrchestratorError) {
      return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status >= 500 ? 502 : err.status });
    }
    throw err;
  }
}
