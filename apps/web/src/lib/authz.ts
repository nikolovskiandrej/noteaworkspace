import { and, eq } from 'drizzle-orm';
import { workspaceMembers, type Database } from '@notea/db';
import type { WorkspaceRole } from '@notea/protocol';

const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 0, editor: 1, owner: 2 };

export class ForbiddenError extends Error {
  constructor(message = 'forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends Error {
  constructor(message = 'not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export function roleAtLeast(role: WorkspaceRole, minimum: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export async function getMembershipRole(db: Database, workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const row = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
    columns: { role: true },
  });
  return row?.role ?? null;
}

/**
 * Server-side authorization for every workspace operation. Non-members get
 * NotFoundError (do not reveal that the workspace exists); members below the
 * required role get ForbiddenError.
 */
export async function requireMembership(
  db: Database,
  workspaceId: string,
  userId: string,
  minimum: WorkspaceRole,
): Promise<WorkspaceRole> {
  const role = await getMembershipRole(db, workspaceId, userId);
  if (!role) throw new NotFoundError('workspace not found');
  if (!roleAtLeast(role, minimum)) throw new ForbiddenError(`this action requires the ${minimum} role`);
  return role;
}
