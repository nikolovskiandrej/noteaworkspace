/**
 * Bootstraps the development accounts, and optionally puts them in one shared
 * workspace so the two-member model can be exercised end to end.
 *
 *   npm run seed:dev -w @notea/web
 *
 * Reads everything from the environment (repository-root `.env`, which is not
 * committed) so no account or password is written into the source tree:
 *
 *   NOTEA_DEV_PASSWORD   required; the password given to every seeded account
 *   NOTEA_DEV_USERS      optional; `email:Name,email:Name` (default: the two below)
 *   NOTEA_DEV_WORKSPACE  optional; slug of an existing workspace. The first user
 *                        becomes its owner, the rest editors.
 *
 * Existing accounts keep their id (and therefore their agent uid, their credentials
 * and their task history); only the name and password hash are refreshed.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { createDatabase, users, workspaceMembers, workspaces } from '@notea/db';
import { hashPassword } from '../src/lib/password';
import { normalizeEmail } from '../src/lib/users';

for (const candidate of [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const DEFAULT_USERS = 'andrej@notea.mk:Andrej,niche@notea.mk:Niche';

const url = process.env.DATABASE_URL;
const password = process.env.NOTEA_DEV_PASSWORD;
if (!url) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(1);
}
if (!password || password.length < 8) {
  process.stderr.write('NOTEA_DEV_PASSWORD is not set (or is shorter than 8 characters); add it to .env\n');
  process.exit(1);
}

const wanted = (process.env.NOTEA_DEV_USERS || DEFAULT_USERS)
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [email, ...name] = entry.split(':');
    if (!email) throw new Error(`invalid NOTEA_DEV_USERS entry: ${entry}`);
    return { email: normalizeEmail(email), name: name.join(':').trim() || email.split('@')[0]! };
  });

const handle = createDatabase(url, { max: 1 });
try {
  const passwordHash = await hashPassword(password);
  const seeded: { id: string; email: string; agentUid: number }[] = [];
  for (const { email, name } of wanted) {
    const existing = await handle.db.query.users.findFirst({ where: eq(users.email, email) });
    if (existing) {
      await handle.db.update(users).set({ passwordHash, name, updatedAt: new Date() }).where(eq(users.id, existing.id));
      seeded.push({ id: existing.id, email, agentUid: existing.agentUid });
      process.stdout.write(`updated ${email} (agent uid ${existing.agentUid})\n`);
    } else {
      const [row] = await handle.db.insert(users).values({ email, name, passwordHash }).returning();
      if (!row) throw new Error(`failed to create ${email}`);
      seeded.push({ id: row.id, email, agentUid: row.agentUid });
      process.stdout.write(`created ${email} (agent uid ${row.agentUid})\n`);
    }
  }

  const slug = process.env.NOTEA_DEV_WORKSPACE?.trim();
  if (slug) {
    const workspace = await handle.db.query.workspaces.findFirst({ where: eq(workspaces.slug, slug) });
    if (!workspace) {
      process.stderr.write(`workspace "${slug}" does not exist; create it in the UI first\n`);
      process.exit(1);
    }
    for (const [index, user] of seeded.entries()) {
      const role = index === 0 ? 'owner' : 'editor';
      const member = await handle.db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, user.id)),
      });
      if (member) {
        if (member.role !== role) {
          await handle.db
            .update(workspaceMembers)
            .set({ role })
            .where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, user.id)));
        }
      } else {
        await handle.db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: user.id, role });
      }
      process.stdout.write(`${user.email} is ${role} of ${slug}\n`);
    }
    if (seeded[0]) await handle.db.update(workspaces).set({ ownerId: seeded[0].id }).where(eq(workspaces.id, workspace.id));
  }
  process.stdout.write('seed complete\n');
} finally {
  await handle.close();
}
