import { createDatabase, type Database, type DatabaseHandle } from '@notea/db';
import { env } from './env';

const globalForDb = globalThis as unknown as { __noteaDb?: DatabaseHandle };

/** Process-wide connection pool (survives Next.js dev hot reloads). */
export function getDb(): Database {
  if (!globalForDb.__noteaDb) {
    globalForDb.__noteaDb = createDatabase(env().DATABASE_URL, { max: 10 });
  }
  return globalForDb.__noteaDb.db;
}
