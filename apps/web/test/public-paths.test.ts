import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isPublicPath } from '../src/lib/public-paths';

// Next needs `config.matcher` to be a literal in proxy.ts, and importing proxy.ts pulls
// in next-auth, which vitest cannot resolve; so read the literal out of the source.
const matchers = [...readFileSync(new URL('../src/proxy.ts', import.meta.url), 'utf8').matchAll(/matcher:\s*\[([^\]]*)\]/g)]
  .flatMap((match) => [...match[1]!.matchAll(/'([^']+)'/g)].map((quoted) => quoted[1]!));

/** Next wraps a matcher as ^…$ before testing the pathname against it. */
function proxyRuns(pathname: string): boolean {
  return matchers.some((pattern) => new RegExp(`^${pattern}$`).test(pathname));
}

describe('what an anonymous visitor can fetch', () => {
  // The sign-in page draws the logo and the mascot; behind the auth gate they came
  // back as a redirect to the sign-in page and showed up as broken images.
  it.each(['/brand/notea-mark.png', '/brand/notea-mascot.webp', '/icon.png', '/apple-icon.png', '/sign-in', '/api/auth/session', '/favicon.ico'])(
    '%s is public',
    (pathname) => {
      expect(isPublicPath(pathname)).toBe(true);
    },
  );

  it.each(['/', '/workspaces/notea', '/settings/ai', '/api/workspaces/1/connect-token', '/brandy', '/icon.png.map'])('%s is behind the sign-in', (pathname) => {
    expect(isPublicPath(pathname)).toBe(false);
  });

  it('keeps the brand files and icons out of the proxy, and the app inside it', () => {
    expect(matchers.length).toBeGreaterThan(0);
    for (const pathname of ['/brand/notea-mark.png', '/brand/notea-mascot.webp', '/icon.png', '/apple-icon.png', '/_next/static/chunks/a.js']) {
      expect(proxyRuns(pathname), pathname).toBe(false);
    }
    for (const pathname of ['/', '/workspaces/notea', '/sign-in', '/api/workspaces/1/connect-token']) {
      expect(proxyRuns(pathname), pathname).toBe(true);
    }
  });
});
