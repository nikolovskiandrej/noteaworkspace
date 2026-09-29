/**
 * Paths an anonymous visitor may fetch: the sign-in page and what it draws (the logo
 * and mascot under /brand, the site icons), Auth.js, and Next's own files. Everything
 * else redirects to sign-in.
 */
const PUBLIC_PREFIXES = ['/sign-in', '/api/auth', '/_next', '/brand/'];
const PUBLIC_FILES = new Set(['/favicon.ico', '/icon.png', '/apple-icon.png']);

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_FILES.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
