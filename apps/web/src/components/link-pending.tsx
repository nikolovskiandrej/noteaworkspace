'use client';

import { ChevronRight, LoaderCircle } from 'lucide-react';
import { useLinkStatus } from 'next/link';

/**
 * Goes inside a <Link>: a chevron that becomes a spinner while the linked page loads,
 * so opening a workspace (which asks the orchestrator first) answers the click at
 * once. No Suspense boundary is involved, so the page itself still renders in one go.
 */
export function LinkPendingChevron() {
  const { pending } = useLinkStatus();
  return pending ? (
    <LoaderCircle className="size-4 animate-spin text-fg-subtle" aria-hidden />
  ) : (
    <ChevronRight className="size-4 text-fg-faint transition-transform duration-200 ease-out group-hover:translate-x-0.5 group-hover:text-fg-subtle" aria-hidden />
  );
}
