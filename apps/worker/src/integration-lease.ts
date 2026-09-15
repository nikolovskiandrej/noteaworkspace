import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { workspaces, type Database } from '@notea/db';

export const INTEGRATION_LEASE_MS = 30 * 60 * 1000;

/**
 * Database-level lease guaranteeing that only one worker integrates into a
 * workspace's main tree at a time, even with several worker processes. The
 * in-process PerKeyMutex still serialises within one worker. Expired leases
 * (crashed worker) can be taken over.
 */
export async function acquireIntegrationLease(
  db: Database,
  workspaceId: string,
  workerId: string,
  now: Date = new Date(),
  ttlMs: number = INTEGRATION_LEASE_MS,
): Promise<boolean> {
  const until = new Date(now.getTime() + ttlMs);
  const rows = await db
    .update(workspaces)
    .set({ integrationLockedBy: workerId, integrationLockedUntil: until })
    .where(
      and(
        eq(workspaces.id, workspaceId),
        or(
          isNull(workspaces.integrationLockedBy),
          eq(workspaces.integrationLockedBy, workerId),
          lt(workspaces.integrationLockedUntil, now),
          isNull(workspaces.integrationLockedUntil),
        ),
      ),
    )
    .returning({ id: workspaces.id });
  return rows.length === 1;
}

export async function releaseIntegrationLease(db: Database, workspaceId: string, workerId: string): Promise<void> {
  await db
    .update(workspaces)
    .set({ integrationLockedBy: null, integrationLockedUntil: null })
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.integrationLockedBy, workerId)));
}

/** For diagnostics: who holds the lease, if anyone. */
export async function integrationLeaseHolder(db: Database, workspaceId: string): Promise<{ workerId: string; until: Date } | null> {
  const [row] = await db
    .select({ by: workspaces.integrationLockedBy, until: workspaces.integrationLockedUntil })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), sql`${workspaces.integrationLockedUntil} > now()`));
  return row?.by && row.until ? { workerId: row.by, until: row.until } : null;
}
