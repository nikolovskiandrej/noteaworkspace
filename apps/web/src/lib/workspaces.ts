import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  users,
  workspaceEvents,
  workspaceMembers,
  workspaces,
  type Database,
  type Workspace,
  type WorkspaceEvent,
} from '@notea/db';
import type { WorkspaceRole, WorkspaceRuntimeInfo, WorkspaceRuntimeStatus } from '@notea/protocol';
import { ForbiddenError, NotFoundError, requireMembership } from './authz';
import type { OrchestratorClient } from './orchestrator';
import { normalizeEmail } from './users';

export interface WorkspaceServiceDeps {
  db: Database;
  orchestrator: OrchestratorClient;
}

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41);
}

export interface WorkspaceListItem {
  workspace: Workspace;
  role: WorkspaceRole;
  status: WorkspaceRuntimeStatus;
}

export async function listWorkspacesForUser(deps: WorkspaceServiceDeps, userId: string): Promise<WorkspaceListItem[]> {
  const rows = await deps.db
    .select({ workspace: workspaces, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaces.deletedAt)))
    .orderBy(desc(workspaces.createdAt));

  let runtimeById = new Map<string, WorkspaceRuntimeInfo>();
  try {
    const { workspaces: runtimes } = await deps.orchestrator.listWorkspaces();
    runtimeById = new Map(runtimes.map((r) => [r.workspaceId, r]));
  } catch {
    // Orchestrator down: fall back to the cached status below.
  }
  return rows.map(({ workspace, role }) => ({
    workspace,
    role,
    status: runtimeById.get(workspace.id)?.status ?? ((workspace.lastKnownStatus as WorkspaceRuntimeStatus | null) ?? 'unknown'),
  }));
}

export interface WorkspaceDetail {
  workspace: Workspace;
  role: WorkspaceRole;
  runtime: WorkspaceRuntimeInfo | null;
  /** The orchestrator could not be asked (unreachable, erroring): `runtime` is unknown, not absent. */
  runtimeUnavailable: boolean;
  members: Array<{ userId: string; email: string; name: string; role: WorkspaceRole }>;
  events: WorkspaceEvent[];
}

export async function getWorkspaceDetail(
  deps: WorkspaceServiceDeps,
  slug: string,
  userId: string,
): Promise<WorkspaceDetail | null> {
  const workspace = await deps.db.query.workspaces.findFirst({
    where: and(eq(workspaces.slug, slug), isNull(workspaces.deletedAt)),
  });
  if (!workspace) return null;
  const membership = await deps.db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, userId)),
  });
  if (!membership) return null;

  let runtimeUnavailable = false;
  const [runtime, memberRows, events] = await Promise.all([
    deps.orchestrator.getWorkspace(workspace.id).catch(() => {
      runtimeUnavailable = true;
      return null;
    }),
    deps.db
      .select({ userId: users.id, email: users.email, name: users.name, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, workspace.id)),
    deps.db.query.workspaceEvents.findMany({
      where: eq(workspaceEvents.workspaceId, workspace.id),
      orderBy: desc(workspaceEvents.id),
      limit: 50,
    }),
  ]);
  return { workspace, role: membership.role, runtime, runtimeUnavailable, members: memberRows, events };
}

export async function recordEvent(
  db: Database,
  input: { workspaceId: string; actorKind: 'user' | 'agent' | 'system'; actorId?: string | null; type: string; payload?: Record<string, unknown> },
): Promise<void> {
  await db.insert(workspaceEvents).values({
    workspaceId: input.workspaceId,
    actorKind: input.actorKind,
    actorId: input.actorId ?? null,
    type: input.type,
    payload: input.payload ?? {},
  });
}

export async function createWorkspace(
  deps: WorkspaceServiceDeps,
  userId: string,
  input: { name: string; slug?: string },
): Promise<Workspace> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) throw new Error('name must be 1-80 characters');
  const slug = (input.slug?.trim() || slugify(name)).toLowerCase();
  if (!SLUG_PATTERN.test(slug)) throw new Error('slug must be 2-41 lowercase letters, digits or dashes');

  const workspace = await deps.db.transaction(async (tx) => {
    const [row] = await tx.insert(workspaces).values({ name, slug, ownerId: userId, lastKnownStatus: 'creating' }).returning();
    if (!row) throw new Error('failed to create workspace');
    await tx.insert(workspaceMembers).values({ workspaceId: row.id, userId, role: 'owner', invitedBy: userId });
    await tx.insert(workspaceEvents).values({
      workspaceId: row.id,
      actorKind: 'user',
      actorId: userId,
      type: 'workspace.created',
      payload: { name, slug },
    });
    return row;
  });

  try {
    const runtime = await deps.orchestrator.createWorkspace({
      workspaceId: workspace.id,
      image: workspace.image,
      resources: workspace.resources ?? undefined,
      wait: true,
    });
    await deps.db.update(workspaces).set({ lastKnownStatus: runtime.status, updatedAt: new Date() }).where(eq(workspaces.id, workspace.id));
    await recordEvent(deps.db, { workspaceId: workspace.id, actorKind: 'system', type: 'workspace.started', payload: { containerId: runtime.containerId } });
  } catch (err) {
    // No usable runtime: remove the row so the user can retry with the same slug, and
    // whatever the orchestrator did create. It may have made the container and then
    // timed out waiting for the agent, or answered after this client gave up; left
    // alone, that container keeps running (restart policy) where nothing lists it.
    await deps.orchestrator.deleteWorkspace(workspace.id, { deleteVolume: true }).catch(() => undefined);
    await deps.db.delete(workspaces).where(eq(workspaces.id, workspace.id));
    throw err;
  }
  return workspace;
}

async function loadWorkspace(db: Database, workspaceId: string): Promise<Workspace> {
  const workspace = await db.query.workspaces.findFirst({ where: and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)) });
  if (!workspace) throw new NotFoundError('workspace not found');
  return workspace;
}

export async function startWorkspace(deps: WorkspaceServiceDeps, userId: string, workspaceId: string): Promise<WorkspaceRuntimeInfo> {
  await requireMembership(deps.db, workspaceId, userId, 'editor');
  await loadWorkspace(deps.db, workspaceId);
  const runtime = await deps.orchestrator.startWorkspace(workspaceId);
  await deps.db.update(workspaces).set({ lastKnownStatus: runtime.status, updatedAt: new Date() }).where(eq(workspaces.id, workspaceId));
  await recordEvent(deps.db, { workspaceId, actorKind: 'user', actorId: userId, type: 'workspace.started' });
  return runtime;
}

export async function stopWorkspace(deps: WorkspaceServiceDeps, userId: string, workspaceId: string): Promise<WorkspaceRuntimeInfo> {
  await requireMembership(deps.db, workspaceId, userId, 'editor');
  await loadWorkspace(deps.db, workspaceId);
  const runtime = await deps.orchestrator.stopWorkspace(workspaceId);
  await deps.db.update(workspaces).set({ lastKnownStatus: runtime.status, updatedAt: new Date() }).where(eq(workspaces.id, workspaceId));
  await recordEvent(deps.db, { workspaceId, actorKind: 'user', actorId: userId, type: 'workspace.stopped' });
  return runtime;
}

/** Owner only. Removes the container and its volume, then soft-deletes the row. */
export async function deleteWorkspace(deps: WorkspaceServiceDeps, userId: string, workspaceId: string): Promise<void> {
  await requireMembership(deps.db, workspaceId, userId, 'owner');
  await loadWorkspace(deps.db, workspaceId);
  await deps.orchestrator.deleteWorkspace(workspaceId, { deleteVolume: true });
  await deps.db
    .update(workspaces)
    .set({ deletedAt: new Date(), lastKnownStatus: 'deleted', updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId));
  await recordEvent(deps.db, { workspaceId, actorKind: 'user', actorId: userId, type: 'workspace.deleted' });
}

/** Owner only. The user must already exist (no self sign-up in the personal MVP). */
export async function addMember(
  deps: WorkspaceServiceDeps,
  actorId: string,
  workspaceId: string,
  input: { email: string; role: Exclude<WorkspaceRole, 'owner'> },
): Promise<void> {
  await requireMembership(deps.db, workspaceId, actorId, 'owner');
  if (input.role !== 'editor' && input.role !== 'viewer') throw new Error('role must be editor or viewer');
  const user = await deps.db.query.users.findFirst({ where: eq(users.email, normalizeEmail(input.email)) });
  if (!user) throw new NotFoundError('no user with that email');
  const workspace = await loadWorkspace(deps.db, workspaceId);
  if (user.id === workspace.ownerId) throw new ForbiddenError('the owner already has full access');
  await deps.db
    .insert(workspaceMembers)
    .values({ workspaceId, userId: user.id, role: input.role, invitedBy: actorId })
    .onConflictDoUpdate({ target: [workspaceMembers.workspaceId, workspaceMembers.userId], set: { role: input.role } });
  await recordEvent(deps.db, {
    workspaceId,
    actorKind: 'user',
    actorId,
    type: 'member.added',
    payload: { userId: user.id, email: user.email, role: input.role },
  });
}

/** Owner only. The owner cannot be removed. */
export async function removeMember(deps: WorkspaceServiceDeps, actorId: string, workspaceId: string, userId: string): Promise<void> {
  await requireMembership(deps.db, workspaceId, actorId, 'owner');
  const workspace = await loadWorkspace(deps.db, workspaceId);
  if (userId === workspace.ownerId) throw new ForbiddenError('the owner cannot be removed');
  await deps.db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  await recordEvent(deps.db, { workspaceId, actorKind: 'user', actorId, type: 'member.removed', payload: { userId } });
}
