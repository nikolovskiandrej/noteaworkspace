import type { NextAuthConfig } from 'next-auth';

/**
 * Configuration shared by the proxy (session check only) and the full Auth.js
 * instance (`auth.ts`, which adds the Credentials provider and database access).
 */
export const authConfig = {
  session: { strategy: 'jwt', maxAge: 60 * 60 * 24 * 14 },
  pages: { signIn: '/sign-in' },
  // Self-hosted behind our own reverse proxy; the host header is trusted.
  trustHost: true,
  providers: [],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.id = user.id;
      return token;
    },
    session({ session, token }) {
      if (typeof token.id === 'string') session.user.id = token.id;
      return session;
    },
  },
} satisfies NextAuthConfig;
