'use client';

import { ChevronDown, KeyRound, LayoutGrid, LogOut } from 'lucide-react';
import Link from 'next/link';
import { signOutAction } from '@/lib/actions';
import { initials } from './ui/avatar';
import { Menu } from './ui/menu';

export function UserMenu({ name, email }: { name: string; email?: string | null }) {
  return (
    <Menu
      label={`Account: ${name}`}
      triggerClassName="flex h-8 items-center gap-2 rounded-md pl-1 pr-1.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg sm:pr-2"
      trigger={
        <>
          <span className="grid size-6 place-items-center rounded-full bg-brand text-[11px] font-semibold text-fg ring-1 ring-brand-edge" aria-hidden>
            {initials(name)}
          </span>
          <span className="hidden max-w-40 truncate text-[13px] sm:inline">{name}</span>
          <ChevronDown className="size-3.5 text-fg-subtle" aria-hidden />
        </>
      }
    >
      <div className="px-2.5 pb-2 pt-1.5">
        <p className="truncate text-[13px] font-medium text-fg">{name}</p>
        {email ? <p className="truncate text-xs text-fg-subtle">{email}</p> : null}
      </div>
      <div className="menu-separator" />
      <Link href="/" className="menu-item">
        <LayoutGrid aria-hidden />
        Workspaces
      </Link>
      <Link href="/settings/ai" className="menu-item">
        <KeyRound aria-hidden />
        AI &amp; Claude connections
      </Link>
      <div className="menu-separator" />
      <form action={signOutAction}>
        <button type="submit" className="menu-item">
          <LogOut aria-hidden />
          Sign out
        </button>
      </form>
    </Menu>
  );
}
