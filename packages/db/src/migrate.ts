/** `npm run migrate -w @notea/db` — applies pending migrations to DATABASE_URL. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createDatabase, runMigrations } from './client';

for (const candidate of [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(1);
}

const handle = createDatabase(url, { max: 1 });
try {
  await runMigrations(handle.db);
  process.stdout.write('migrations applied\n');
} finally {
  await handle.close();
}
