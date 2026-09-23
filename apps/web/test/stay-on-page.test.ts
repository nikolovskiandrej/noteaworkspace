import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ revalidated: [] as string[], redirected: [] as string[], referer: null as string | null }));

vi.mock('next/cache', () => ({ revalidatePath: (path: string) => calls.revalidated.push(path) }));
vi.mock('next/headers', () => ({ headers: async () => new Headers(calls.referer ? { referer: calls.referer } : {}) }));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    calls.redirected.push(path);
    throw new Error('NEXT_REDIRECT');
  },
}));

const { stayOnPage } = await import('../src/lib/stay-on-page');

describe('stayOnPage', () => {
  beforeEach(() => {
    calls.revalidated.length = 0;
    calls.redirected.length = 0;
    calls.referer = null;
  });

  it('refreshes the page without redirecting, so the page stays mounted', async () => {
    // A redirect here is what remounted the workspace page after queueing a task or
    // saving the policy, discarding unsaved editor text.
    calls.referer = 'http://127.0.0.1:3000/workspaces/atlas-api';
    await stayOnPage('/workspaces/atlas-api');
    expect(calls.revalidated).toEqual(['/workspaces/atlas-api']);
    expect(calls.redirected).toEqual([]);
  });

  it('redirects to drop a notice an earlier failure left in the query string', async () => {
    calls.referer = 'http://127.0.0.1:3000/workspaces/atlas-api?error=no+user+with+that+email';
    await expect(stayOnPage('/workspaces/atlas-api')).rejects.toThrow('NEXT_REDIRECT');
    expect(calls.redirected).toEqual(['/workspaces/atlas-api']);
  });

  it('does not redirect when there is no usable referer', async () => {
    await stayOnPage('/settings/ai');
    calls.referer = 'not a url';
    await stayOnPage('/settings/ai');
    expect(calls.redirected).toEqual([]);
    expect(calls.revalidated).toEqual(['/settings/ai', '/settings/ai']);
  });
});
