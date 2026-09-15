/**
 * Runs against a real Postgres when DATABASE_URL is set (see infra/compose/docker-compose.dev.yml).
 * Applies migrations, then exercises constraints on throw-away rows.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, runMigrations, type DatabaseHandle } from '../src/client';
import { users, workspaceEvents, workspaceMembers, workspaces } from '../src/schema';

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('database', () => {
  let handle: DatabaseHandle;
  const suffix = randomUUID().slice(0, 8);
  const email = `test-${suffix}@example.com`;

  beforeAll(async () => {
    handle = createDatabase(url as string, { max: 2 });
    await runMigrations(handle.db);
  });

  afterAll(async () => {
    await handle.db.delete(users).where(eq(users.email, email));
    await handle.close();
  });

  it('creates a user, a workspace with its owner membership, and events', async () => {
    const { db } = handle;
    const [user] = await db.insert(users).values({ email, name: 'Test', passwordHash: 'x' }).returning();
    expect(user?.id).toBeTruthy();

    const [workspace] = await db
      .insert(workspaces)
      .values({ slug: `ws-${suffix}`, name: 'Test WS', ownerId: user!.id })
      .returning();
    expect(workspace?.image).toBe('notea/workspace:dev');

    await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId: user!.id, role: 'owner' });
    await db.insert(workspaceEvents).values({
      workspaceId: workspace!.id,
      actorKind: 'user',
      actorId: user!.id,
      type: 'workspace.created',
      payload: { slug: workspace!.slug },
    });

    const members = await db.query.workspaceMembers.findMany({ where: eq(workspaceMembers.workspaceId, workspace!.id) });
    expect(members.map((m) => m.role)).toEqual(['owner']);

    // Unique email and slug are enforced.
    await expect(db.insert(users).values({ email, name: 'Dup' })).rejects.toThrow();
    await expect(
      db.insert(workspaces).values({ slug: `ws-${suffix}`, name: 'Dup', ownerId: user!.id }),
    ).rejects.toThrow();

    // Deleting the workspace cascades to members and events.
    await db.delete(workspaces).where(eq(workspaces.id, workspace!.id));
    expect(await db.query.workspaceEvents.findMany({ where: eq(workspaceEvents.workspaceId, workspace!.id) })).toEqual([]);
  });
});
