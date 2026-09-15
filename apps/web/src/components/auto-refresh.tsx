'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Re-fetches the server-rendered page on an interval while something is in progress. */
export function AutoRefresh({ intervalMs, enabled }: { intervalMs: number; enabled: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs, enabled]);
  return null;
}
