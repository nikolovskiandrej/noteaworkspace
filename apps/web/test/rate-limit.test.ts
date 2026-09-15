import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from '../src/lib/rate-limit';

describe('SlidingWindowLimiter', () => {
  it('allows up to max hits per window, then blocks until the window slides', () => {
    let now = 1_000_000;
    const limiter = new SlidingWindowLimiter(3, 1000, () => now);
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').remaining).toBe(0);
    const blocked = limiter.hit('a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(1000);
    expect(limiter.isLimited('a')).toBe(true);
    expect(limiter.isLimited('b')).toBe(false);
    now += 1001;
    expect(limiter.isLimited('a')).toBe(false);
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('resets a key', () => {
    const limiter = new SlidingWindowLimiter(1, 60_000);
    limiter.hit('k');
    expect(limiter.isLimited('k')).toBe(true);
    limiter.reset('k');
    expect(limiter.isLimited('k')).toBe(false);
  });
});
