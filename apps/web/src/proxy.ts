import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from './auth.config';
import { isPublicPath } from './lib/public-paths';

const { auth } = NextAuth(authConfig);

// Static assets are excluded by the matcher below as well; `isPublicPath` keeps the
// sign-in page working (it draws the logo and the mascot) even if the matcher
// convention changes between Next versions.

/**
 * Redirects anonymous visitors to the sign-in page. This is a convenience gate
 * only: every server action and route handler re-checks the session and the
 * workspace membership itself.
 */
export const proxy = auth((request) => {
  const { pathname } = request.nextUrl;
  if (!request.auth && !isPublicPath(pathname)) {
    const signIn = new URL('/sign-in', request.nextUrl);
    if (pathname !== '/') signIn.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(signIn);
  }
  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|brand/).*)'],
};
