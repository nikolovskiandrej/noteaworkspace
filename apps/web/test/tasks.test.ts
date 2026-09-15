import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCredentialsKey } from '@notea/agents';
import { agentTasks, createDatabase, runMigrations, users, workspaceMembers, workspaces, type DatabaseHandle } from '@notea/db';
import { ForbiddenError, NotFoundError } from '../src/lib/authz';
import { addCredential, deleteCredential, listCredentials } from '../src/lib/credentials';
import { approveTask, cancelTask, createTask, deleteTask, listTasksForWorkspace, parseScope, requeueTask, updatePolicy } from '../src/lib/tasks';

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describe('parseScope', () => {
  it('splits, trims and rejects escapes', () => {
    expect(parseScope('src/api/**, docs/\n ./README.md')).toEqual(['src/api/**', 'docs', 'README.md']);
    expect(parseScope('')).toEqual([]);
    expect(() => parseScope('../etc')).toThrow(/invalid scope/);
    expect(() => parseScope('/abs')).toThrow(/invalid scope/);
  });
});

describeDb('tasks and credentials services', () => {
  let handle: DatabaseHandle;
  const suffix = randomUUID().slice(0, 8);
  let ownerId: string;
  let viewerId: string;
  let workspaceId: string;
  const key = parseCredentialsKey('c'.repeat(64));

  beforeAll(async () => {
    handle = createDatabase(url as string, { max: 2 });
    await runMigrations(handle.db);
    const [owner] = await handle.db.insert(users).values({ email: `t-owner-${suffix}@example.com`, name: 'Owner' }).returning();
    const [viewer] = await handle.db.insert(users).values({ email: `t-viewer-${suffix}@example.com`, name: 'Viewer' }).returning();
    ownerId = owner!.id;
    viewerId = viewer!.id;
    const [ws] = await handle.db.insert(workspaces).values({ slug: `tasks-${suffix}`, name: 'T', ownerId }).returning();
    workspaceId = ws!.id;
    await handle.db.insert(workspaceMembers).values([
      { workspaceId, userId: ownerId, role: 'owner' },
      { workspaceId, userId: viewerId, role: 'viewer' },
    ]);
  });

  afterAll(async () => {
    await handle.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await handle.db.delete(users).where(inArray(users.id, [ownerId, viewerId]));
    await handle.close();
  });

  it('stores credentials encrypted and lists them masked', async () => {
    const credential = await addCredential(handle.db, ownerId, key, { provider: 'anthropic', label: 'main', secret: 'sk-ant-api03-abcdefghijklmnop' });
    expect(credential.encryptedSecret.startsWith('v1:')).toBe(true);
    expect(credential.encryptedSecret).not.toContain('sk-ant');
    const listed = await listCredentials(handle.db, ownerId, key);
    expect(listed).toMatchObject([{ label: 'main', provider: 'anthropic', masked: 'sk-ant…mnop' }]);
    expect(await listCredentials(handle.db, viewerId, key)).toEqual([]);
    await expect(deleteCredential(handle.db, viewerId, credential.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(addCredential(handle.db, ownerId, key, { provider: 'nope', label: 'x', secret: 'sk-1234567890' })).rejects.toThrow(/unknown provider/);
  });

  it('creates tasks with validation and role checks, then walks the transitions', async () => {
    await expect(createTask(handle.db, viewerId, workspaceId, { title: 'x', description: 'y', runtime: 'generic-cli', command: 'true' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createTask(handle.db, ownerId, workspaceId, { title: 'x', description: 'y', runtime: 'nope' })).rejects.toThrow(/unknown runtime/);
    await expect(createTask(handle.db, ownerId, workspaceId, { title: 'x', description: 'y', runtime: 'generic-cli' })).rejects.toThrow(/needs a command/);
    await expect(
      createTask(handle.db, ownerId, workspaceId, { title: 'x', description: 'y', runtime: 'claude-code-cli', model: 'openai:gpt-5' }),
    ).rejects.toThrow(/cannot use openai/);

    const [credential] = await listCredentials(handle.db, ownerId, key);
    const task = await createTask(handle.db, ownerId, workspaceId, {
      title: 'Add tests',
      description: 'Cover the parser.',
      runtime: 'claude-code-cli',
      model: 'anthropic:claude-sonnet-5',
      credentialId: credential!.id,
      scope: 'src/parser/**, test/',
      maxMinutes: 999,
    });
    expect(task).toMatchObject({ status: 'queued', provider: 'anthropic', modelId: 'claude-sonnet-5', scope: ['src/parser/**', 'test'], maxMinutes: 240, agentName: 'Claude Code' });

    // Only editors and owners drive transitions; illegal transitions are rejected.
    await expect(approveTask(handle.db, viewerId, task.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approveTask(handle.db, ownerId, task.id)).rejects.toThrow(/cannot move task from queued to approved/);
    await cancelTask(handle.db, ownerId, task.id);
    await requeueTask(handle.db, ownerId, task.id);
    await handle.db.update(agentTasks).set({ status: 'needs_review' }).where(eq(agentTasks.id, task.id));
    await approveTask(handle.db, ownerId, task.id);
    const approved = await handle.db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) });
    expect(approved).toMatchObject({ status: 'approved', approvedBy: ownerId });

    const views = await listTasksForWorkspace(handle.db, workspaceId);
    expect(views.map((v) => v.task.id)).toEqual([task.id]);

    await expect(deleteTask(handle.db, viewerId, task.id)).rejects.toBeInstanceOf(ForbiddenError);
    await deleteTask(handle.db, ownerId, task.id);
    expect(await listTasksForWorkspace(handle.db, workspaceId)).toEqual([]);
  });

  it('lets only the owner change the coordination policy', async () => {
    await expect(updatePolicy(handle.db, viewerId, workspaceId, { integration: 'auto' })).rejects.toBeInstanceOf(ForbiddenError);
    await updatePolicy(handle.db, ownerId, workspaceId, { integration: 'auto', checkCommand: 'npm test', baseBranch: 'main' });
    const ws = await handle.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    expect(ws?.coordinationPolicy).toEqual({ overlap: 'block', integration: 'auto', checkCommand: 'npm test', baseBranch: 'main' });
    await expect(updatePolicy(handle.db, ownerId, workspaceId, { baseBranch: 'bad branch' })).rejects.toThrow(/invalid base branch/);
  });
});
