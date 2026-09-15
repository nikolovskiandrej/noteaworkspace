import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, runMigrations, users, workspaces, type DatabaseHandle } from '@notea/db';
import { acquireIntegrationLease, integrationLeaseHolder, releaseIntegrationLease } from '../src/integration-lease';

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('integration lease', () => {
  let handle: DatabaseHandle;
  let userId: string;
  let workspaceId: string;
  const suffix = randomUUID().slice(0, 8);

  beforeAll(async () => {
    handle = createDatabase(url as string, { max: 2 });
    await runMigrations(handle.db);
    const [user] = await handle.db.insert(users).values({ email: `lease-${suffix}@example.com`, name: 'L' }).returning();
    userId = user!.id;
    const [ws] = await handle.db.insert(workspaces).values({ slug: `lease-${suffix}`, name: 'Lease', ownerId: userId }).returning();
    workspaceId = ws!.id;
  });

  afterAll(async () => {
    await handle.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await handle.db.delete(users).where(eq(users.id, userId));
    await handle.close();
  });

  it('is exclusive per workspace, re-entrant for the holder, and recoverable after expiry', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    expect(await acquireIntegrationLease(handle.db, workspaceId, 'worker-a', t0)).toBe(true);
    expect(await acquireIntegrationLease(handle.db, workspaceId, 'worker-b', t0)).toBe(false);
    expect(await acquireIntegrationLease(handle.db, workspaceId, 'worker-a', t0)).toBe(true);

    // The lease expires after its ttl; another worker may then take over.
    const later = new Date(t0.getTime() + 31 * 60 * 1000);
    expect(await acquireIntegrationLease(handle.db, workspaceId, 'worker-b', later)).toBe(true);
    expect(await acquireIntegrationLease(handle.db, workspaceId, 'worker-a', later)).toBe(false);

    // Releasing by a non-holder is a no-op; releasing by the holder frees it.
    await releaseIntegrationLease(handle.db, workspaceId, 'worker-a');
    expect(await acquireIntegrationLease(handle.db, workspaceId, 'worker-a', later)).toBe(false);
    await releaseIntegrationLease(handle.db, workspaceId, 'worker-b');
    expect(await acquireIntegrationLease(handle.db, workspaceId, 'worker-a', new Date())).toBe(true);
    expect((await integrationLeaseHolder(handle.db, workspaceId))?.workerId).toBe('worker-a');
    await releaseIntegrationLease(handle.db, workspaceId, 'worker-a');
    expect(await integrationLeaseHolder(handle.db, workspaceId)).toBeNull();
  });
});
