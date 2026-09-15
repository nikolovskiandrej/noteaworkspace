import { eq } from 'drizzle-orm';
import { users, type Database, type User } from '@notea/db';
import { hashPassword, verifyPassword } from './password';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(db: Database, email: string): Promise<User | null> {
  const row = await db.query.users.findFirst({ where: eq(users.email, normalizeEmail(email)) });
  return row ?? null;
}

export async function createUser(
  db: Database,
  input: { email: string; name: string; password: string },
): Promise<User> {
  const passwordHash = await hashPassword(input.password);
  const [row] = await db
    .insert(users)
    .values({ email: normalizeEmail(input.email), name: input.name.trim(), passwordHash })
    .returning();
  if (!row) throw new Error('failed to create user');
  return row;
}

/** Returns the user when the email/password pair is valid, otherwise null. */
export async function verifyCredentials(db: Database, email: string, password: string): Promise<User | null> {
  const user = await findUserByEmail(db, email);
  // Always run the hash comparison so timing does not reveal whether the email exists.
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  return user && ok ? user : null;
}

// A valid-format hash that never matches (random salt/hash), used to equalise timing.
const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64, 1).toString('base64');
