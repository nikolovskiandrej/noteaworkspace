import Link from 'next/link';
import type { ReactNode } from 'react';
import { UserMenu } from './user-menu';
import { Wordmark } from './wordmark';

/**
 * The bar at the top of every signed-in page: the wordmark, a breadcrumb (children),
 * the page's own actions, and the account menu.
 */
export function TopBar({
  userName,
  userEmail,
  actions,
  children,
}: {
  userName: string;
  userEmail?: string | null;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-40 flex h-12 flex-none items-center gap-2 border-b border-line bg-panel px-2.5 sm:gap-3 sm:px-4">
      <Link href="/" className="flex h-8 flex-none items-center rounded-md px-1.5" aria-label="Notea Workspace, all workspaces">
        <Wordmark compact />
      </Link>
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
        {children}
      </nav>
      {actions ? <div className="flex flex-none items-center gap-1.5">{actions}</div> : null}
      <UserMenu name={userName} email={userEmail} />
    </header>
  );
}

/**
 * One breadcrumb step: a link while there is somewhere to go back to, text for the
 * current page. Intermediate steps give way on narrow screens; the wordmark already
 * leads home.
 */
export function Crumb({ href, children }: { href?: string; children: ReactNode }) {
  if (href) {
    return (
      <span className="hidden flex-none items-center gap-2 sm:flex">
        <span className="text-fg-faint" aria-hidden>
          /
        </span>
        <Link href={href} className="rounded text-fg-subtle transition-colors hover:text-fg">
          {children}
        </Link>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex-none text-fg-faint" aria-hidden>
        /
      </span>
      <span className="min-w-0 truncate font-medium text-fg" aria-current="page">
        {children}
      </span>
    </span>
  );
}
