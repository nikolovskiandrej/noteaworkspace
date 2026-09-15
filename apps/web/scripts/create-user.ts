/**
 * Creates (or updates the password of) a user.
 *   npm run create-user -w @notea/web -- <email> <name> <password>
 * Reads DATABASE_URL from the environment or the repository-root .env.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createDatabase, users } from '@notea/db';
import { hashPassword } from '../src/lib/password';
import { normalizeEmail } from '../src/lib/users';

for (const candidate of [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const [email, name, password] = process.argv.slice(2);
if (!email || !name || !password) {
  process.stderr.write('usage: create-user <email> <name> <password>\n');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(1);
}

const handle = createDatabase(url, { max: 1 });
try {
  const passwordHash = await hashPassword(password);
  const normalized = normalizeEmail(email);
  const existing = await handle.db.query.users.findFirst({ where: eq(users.email, normalized) });
  if (existing) {
    await handle.db.update(users).set({ passwordHash, name, updatedAt: new Date() }).where(eq(users.id, existing.id));
    process.stdout.write(`updated user ${normalized} (${existing.id})\n`);
  } else {
    const [row] = await handle.db.insert(users).values({ email: normalized, name, passwordHash }).returning();
    process.stdout.write(`created user ${normalized} (${row?.id})\n`);
  }
} finally {
  await handle.close();
}
