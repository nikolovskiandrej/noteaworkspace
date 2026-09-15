/**
 * In-memory sliding-window limiter for sign-in attempts. Sufficient for a single
 * web process (the personal deployment); swap for a shared store when scaling out.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an attempt and reports whether it exceeds the limit. */
  hit(key: string): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const current = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => current - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return { allowed: false, remaining: 0, retryAfterMs: recent[0]! + this.windowMs - current };
    }
    recent.push(current);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(current);
    return { allowed: true, remaining: this.max - recent.length, retryAfterMs: 0 };
  }

  /** True when the key is currently over the limit (without recording an attempt). */
  isLimited(key: string): boolean {
    const current = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => current - t < this.windowMs);
    return recent.length >= this.max;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(current: number): void {
    for (const [key, times] of this.hits) {
      const recent = times.filter((t) => current - t < this.windowMs);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }
}

const globalForLimiters = globalThis as unknown as { __noteaSignInLimiters?: { byEmail: SlidingWindowLimiter; byIp: SlidingWindowLimiter } };

/** Failed sign-ins: 8 per e-mail and 40 per client address per 15 minutes. */
export function signInLimiters() {
  if (!globalForLimiters.__noteaSignInLimiters) {
    globalForLimiters.__noteaSignInLimiters = {
      byEmail: new SlidingWindowLimiter(8, 15 * 60 * 1000),
      byIp: new SlidingWindowLimiter(40, 15 * 60 * 1000),
    };
  }
  return globalForLimiters.__noteaSignInLimiters;
}
