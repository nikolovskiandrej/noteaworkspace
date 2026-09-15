import { and, eq, isNull } from 'drizzle-orm';
import { users, workspaces } from '@notea/db';
import { currentUserId } from '@/auth';
import { getMembershipRole } from '@/lib/authz';
import { getDb } from '@/lib/db';
import { env } from '@/lib/env';
import { getOrchestrator, OrchestratorError } from '@/lib/orchestrator';

/**
 * Issues a short-lived connect token for the signed-in member and returns the
 * full WebSocket URL. The browser calls this on every (re)connect.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: { code: 'unauthorized', message: 'sign in first' } }, { status: 401 });

  const { id: workspaceId } = await context.params;
  const db = getDb();
  const role = await getMembershipRole(db, workspaceId, userId);
  const workspace = role
    ? await db.query.workspaces.findFirst({ where: and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)) })
    : null;
  if (!role || !workspace) {
    return Response.json({ error: { code: 'not_found', message: 'workspace not found' } }, { status: 404 });
  }
  const user = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { name: true } });

  try {
    const issued = await getOrchestrator().issueConnectToken({
      workspaceId,
      userId,
      name: user?.name ?? 'user',
      role,
      kind: 'user',
    });
    const config = env();
    const base = (config.ORCHESTRATOR_PUBLIC_URL ?? config.ORCHESTRATOR_URL).replace(/^http/, 'ws').replace(/\/$/, '');
    return Response.json({
      url: `${base}${issued.wsPath}?token=${encodeURIComponent(issued.token)}`,
      expiresAt: issued.expiresAt,
      role,
    });
  } catch (err) {
    if (err instanceof OrchestratorError) {
      return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status >= 500 ? 502 : err.status });
    }
    throw err;
  }
}
