import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from './auth.config';

const { auth } = NextAuth(authConfig);

const PUBLIC_PREFIXES = ['/sign-in', '/api/auth'];

/**
 * Redirects anonymous visitors to the sign-in page. This is a convenience gate
 * only: every server action and route handler re-checks the session and the
 * workspace membership itself.
 */
export const proxy = auth((request) => {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  if (!request.auth && !isPublic) {
    const signIn = new URL('/sign-in', request.nextUrl);
    if (pathname !== '/') signIn.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(signIn);
  }
  return NextResponse.next();
});

export const proxyConfig = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
