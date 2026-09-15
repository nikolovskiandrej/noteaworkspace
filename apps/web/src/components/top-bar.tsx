import Link from 'next/link';
import { signOutAction } from '@/lib/actions';

export function TopBar({ userName, children }: { userName: string; children?: React.ReactNode }) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-4 border-b border-[#232830] bg-[#14171c] px-4 text-sm">
      <Link href="/" className="font-semibold tracking-tight text-emerald-300">
        Notea Workspace
      </Link>
      <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
      <span className="text-[#9aa1ab]">{userName}</span>
      <form action={signOutAction}>
        <button type="submit" className="rounded border border-[#2b313b] px-2 py-0.5 text-xs text-[#c3c8d0] hover:bg-[#1c2027]">
          Sign out
        </button>
      </form>
    </header>
  );
}
