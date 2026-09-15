/**
 * Workspace service against a real Postgres (DATABASE_URL) with a fake orchestrator.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, runMigrations, users, workspaceMembers, workspaces, type DatabaseHandle } from '@notea/db';
import type { WorkspaceRuntimeInfo } from '@notea/protocol';
import { ForbiddenError, NotFoundError, roleAtLeast } from '../src/lib/authz';
import type { OrchestratorClient } from '../src/lib/orchestrator';
import { createUser, verifyCredentials } from '../src/lib/users';
import {
  addMember,
  createWorkspace,
  deleteWorkspace,
  getWorkspaceDetail,
  listWorkspacesForUser,
  removeMember,
  slugify,
  startWorkspace,
  stopWorkspace,
} from '../src/lib/workspaces';

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

class FakeOrchestrator {
  readonly runtimes = new Map<string, WorkspaceRuntimeInfo>();
  readonly calls: string[] = [];
  failCreate = false;

  private info(id: string, status: WorkspaceRuntimeInfo['status']): WorkspaceRuntimeInfo {
    return { workspaceId: id, status, containerId: 'c', image: 'img', volumeName: 'v', resources: null, createdAt: null, startedAt: null, dockerStatus: status };
  }
  async listWorkspaces() {
    this.calls.push('list');
    return { workspaces: [...this.runtimes.values()] };
  }
  async createWorkspace(req: { workspaceId: string }) {
    this.calls.push(`create:${req.workspaceId}`);
    if (this.failCreate) throw new Error('image not found');
    const info = this.info(req.workspaceId, 'running');
    this.runtimes.set(req.workspaceId, info);
    return info;
  }
  async getWorkspace(id: string) {
    return this.runtimes.get(id) ?? null;
  }
  async startWorkspace(id: string) {
    this.calls.push(`start:${id}`);
    const info = this.info(id, 'running');
    this.runtimes.set(id, info);
    return info;
  }
  async stopWorkspace(id: string) {
    this.calls.push(`stop:${id}`);
    const info = this.info(id, 'stopped');
    this.runtimes.set(id, info);
    return info;
  }
  async deleteWorkspace(id: string) {
    this.calls.push(`delete:${id}`);
    this.runtimes.delete(id);
  }
  async issueConnectToken() {
    return { token: 't', expiresAt: '', wsPath: '/ws' };
  }
}

describe('roleAtLeast', () => {
  it('orders viewer < editor < owner', () => {
    expect(roleAtLeast('owner', 'viewer')).toBe(true);
    expect(roleAtLeast('editor', 'owner')).toBe(false);
    expect(roleAtLeast('viewer', 'viewer')).toBe(true);
  });
});

describe('slugify', () => {
  it('normalises names', () => {
    expect(slugify('My Cool Project!')).toBe('my-cool-project');
    expect(slugify('  --a  ')).toBe('a');
  });
});

describeDb('workspace service', () => {
  let handle: DatabaseHandle;
  let orchestrator: FakeOrchestrator;
  const suffix = randomUUID().slice(0, 8);
  const ownerEmail = `owner-${suffix}@example.com`;
  const otherEmail = `other-${suffix}@example.com`;
  let ownerId: string;
  let otherId: string;

  const deps = () => ({ db: handle.db, orchestrator: orchestrator as unknown as OrchestratorClient });

  beforeAll(async () => {
    handle = createDatabase(url as string, { max: 2 });
    await runMigrations(handle.db);
    orchestrator = new FakeOrchestrator();
    ownerId = (await createUser(handle.db, { email: ownerEmail, name: 'Owner', password: 'password-1' })).id;
    otherId = (await createUser(handle.db, { email: otherEmail, name: 'Other', password: 'password-2' })).id;
  });

  afterAll(async () => {
    const owned = await handle.db.query.workspaces.findMany({ where: eq(workspaces.ownerId, ownerId) });
    if (owned.length) await handle.db.delete(workspaces).where(inArray(workspaces.id, owned.map((w) => w.id)));
    await handle.db.delete(users).where(inArray(users.email, [ownerEmail, otherEmail]));
    await handle.close();
  });

  it('verifies credentials', async () => {
    expect((await verifyCredentials(handle.db, ownerEmail.toUpperCase(), 'password-1'))?.id).toBe(ownerId);
    expect(await verifyCredentials(handle.db, ownerEmail, 'wrong')).toBeNull();
    expect(await verifyCredentials(handle.db, 'nobody@example.com', 'password-1')).toBeNull();
  });

  it('creates a workspace with owner membership and starts its runtime', async () => {
    const workspace = await createWorkspace(deps(), ownerId, { name: `Proj ${suffix}` });
    expect(workspace.slug).toBe(`proj-${suffix}`);
    expect(orchestrator.calls).toContain(`create:${workspace.id}`);

    const list = await listWorkspacesForUser(deps(), ownerId);
    expect(list.map((i) => [i.workspace.id, i.role, i.status])).toContainEqual([workspace.id, 'owner', 'running']);
    expect(await listWorkspacesForUser(deps(), otherId)).toEqual([]);

    const detail = await getWorkspaceDetail(deps(), workspace.slug, ownerId);
    expect(detail?.role).toBe('owner');
    expect(detail?.events.map((e) => e.type)).toEqual(['workspace.started', 'workspace.created']);
    expect(await getWorkspaceDetail(deps(), workspace.slug, otherId)).toBeNull();
  });

  it('rolls back the row when the runtime cannot be created', async () => {
    orchestrator.failCreate = true;
    await expect(createWorkspace(deps(), ownerId, { name: `Broken ${suffix}` })).rejects.toThrow(/image not found/);
    orchestrator.failCreate = false;
    expect(await handle.db.query.workspaces.findFirst({ where: eq(workspaces.slug, `broken-${suffix}`) })).toBeUndefined();
  });

  it('enforces roles on lifecycle and membership operations', async () => {
    const workspace = (await handle.db.query.workspaces.findFirst({ where: eq(workspaces.slug, `proj-${suffix}`) }))!;

    // Non-member: not found (existence is not revealed).
    await expect(stopWorkspace(deps(), otherId, workspace.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(addMember(deps(), otherId, workspace.id, { email: otherEmail, role: 'editor' })).rejects.toBeInstanceOf(NotFoundError);

    // Owner adds a viewer; the viewer cannot start/stop or manage members.
    await addMember(deps(), ownerId, workspace.id, { email: otherEmail, role: 'viewer' });
    await expect(stopWorkspace(deps(), otherId, workspace.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeMember(deps(), otherId, workspace.id, ownerId)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await getWorkspaceDetail(deps(), workspace.slug, otherId))?.role).toBe('viewer');

    // Promote to editor: lifecycle allowed, membership management still owner-only.
    await addMember(deps(), ownerId, workspace.id, { email: otherEmail, role: 'editor' });
    expect((await stopWorkspace(deps(), otherId, workspace.id)).status).toBe('stopped');
    expect((await startWorkspace(deps(), otherId, workspace.id)).status).toBe('running');
    await expect(deleteWorkspace(deps(), otherId, workspace.id)).rejects.toBeInstanceOf(ForbiddenError);

    // Owner cannot be removed or re-added; unknown emails are rejected.
    await expect(removeMember(deps(), ownerId, workspace.id, ownerId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addMember(deps(), ownerId, workspace.id, { email: ownerEmail, role: 'editor' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addMember(deps(), ownerId, workspace.id, { email: 'ghost@example.com', role: 'editor' })).rejects.toBeInstanceOf(NotFoundError);

    await removeMember(deps(), ownerId, workspace.id, otherId);
    expect(await handle.db.query.workspaceMembers.findMany({ where: eq(workspaceMembers.workspaceId, workspace.id) })).toHaveLength(1);

    // Owner deletes: runtime removed, row soft-deleted and hidden from lists.
    await deleteWorkspace(deps(), ownerId, workspace.id);
    expect(orchestrator.calls).toContain(`delete:${workspace.id}`);
    expect(await listWorkspacesForUser(deps(), ownerId)).toEqual([]);
    expect(await getWorkspaceDetail(deps(), workspace.slug, ownerId)).toBeNull();
  });
});
