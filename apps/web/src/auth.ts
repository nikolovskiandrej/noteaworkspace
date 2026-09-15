import NextAuth, { CredentialsSignin, type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { authConfig } from './auth.config';
import { getDb } from './lib/db';
import { signInLimiters } from './lib/rate-limit';
import { normalizeEmail, verifyCredentials } from './lib/users';

declare module 'next-auth' {
  interface Session {
    user: { id: string } & DefaultSession['user'];
  }
}

class RateLimitedSignin extends CredentialsSignin {
  override code = 'rate_limited';
}

function clientAddress(request: Request | undefined): string {
  const forwarded = request?.headers.get('x-forwarded-for') ?? '';
  return forwarded.split(',')[0]?.trim() || request?.headers.get('x-real-ip') || 'unknown';
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { type: 'email' },
        password: { type: 'password' },
      },
      async authorize(credentials, request) {
        const email = typeof credentials?.email === 'string' ? normalizeEmail(credentials.email) : '';
        const password = typeof credentials?.password === 'string' ? credentials.password : '';
        if (!email || !password) return null;

        const limiters = signInLimiters();
        const ip = clientAddress(request);
        if (limiters.byEmail.isLimited(email) || limiters.byIp.isLimited(ip)) throw new RateLimitedSignin();

        const user = await verifyCredentials(getDb(), email, password);
        if (!user) {
          // Only failures count towards the limit.
          limiters.byEmail.hit(email);
          limiters.byIp.hit(ip);
          return null;
        }
        limiters.byEmail.reset(email);
        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
});

/** Returns the signed-in user's id or null. Use in server components, actions and route handlers. */
export async function currentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}
